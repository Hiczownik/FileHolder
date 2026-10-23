// Calls to the FileHolder API, shared by the scenarios. Every request is tagged with a fixed `name`, so share tokens
// and storage keys never become metric labels (one series per token would swamp the summary and Prometheus).
import http from 'k6/http';
import { check, fail } from 'k6';

export const API = `${__ENV.FILEHOLDER_URL || 'http://ui'}/api/v1/files`;

// Set by run.ps1 for each run. Bundle titles carry it, so the run's SQL checks find exactly the bundles it made.
export const RUN_ID = __ENV.RUN_ID || `local-${Date.now()}`;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Share tokens are 8 of these (CryptoUtils.GenerateShortToken).
const TOKEN_CHARACTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function postJson(path, body, name, params = {}) {
  return http.post(`${API}${path}`, body === undefined ? null : JSON.stringify(body), {
    ...params,
    headers: { ...JSON_HEADERS, ...params.headers },
    tags: { name, ...params.tags },
  });
}

/** A random token in the share-token format; a real bundle having it is a 1 in 62^8 chance. */
export function randomToken() {
  let token = '';
  for (let i = 0; i < 8; i++) {
    token += TOKEN_CHARACTERS[Math.floor(Math.random() * TOKEN_CHARACTERS.length)];
  }
  return token;
}

/**
 * File contents of the given size. The bytes don't matter to the server, which only checks sizes, so one buffer per
 * size is built per VU and reused. A 64 KiB pattern is copied in, since filling 16 MiB parts byte by byte in k6's
 * JavaScript takes seconds.
 */
const PATTERN = Uint8Array.from({ length: 64 * 1024 }, (_, i) => i % 251);
const buffers = new Map();
export function contentOfSize(sizeBytes) {
  if (!buffers.has(sizeBytes)) {
    const bytes = new Uint8Array(sizeBytes);
    for (let offset = 0; offset < sizeBytes; offset += PATTERN.length) {
      bytes.set(PATTERN.subarray(0, Math.min(PATTERN.length, sizeBytes - offset)), offset);
    }
    buffers.set(sizeBytes, bytes.buffer);
  }
  return buffers.get(sizeBytes);
}

/** A bundle title for this run: `k6 <run id> <label>`, which the SQL checks match on. */
export function runTitle(label) {
  return `k6 ${RUN_ID} ${label}`;
}

/**
 * POST /presign. `files` are `{ fileName, contentType, sizeBytes }`; `bundle` holds the bundle settings that
 * presign and confirm both take (title, expireInHours, maxDownloads, password).
 */
export function presign(files, bundle = {}, params = {}) {
  return postJson('/presign', { ...bundleSettings(bundle), files }, 'POST /presign', params);
}

/** PUT of a single-file upload to its presigned storage URL. */
export function putSingle(item, body, params = {}) {
  return http.put(item.uploadUrl, body, { ...params, tags: { name: 'PUT storage (single)', ...params.tags } });
}

/** POST /confirm for the files presign returned. */
export function confirm(uploadToken, files, items, bundle = {}, params = {}) {
  return postJson('/confirm', {
    ...bundleSettings(bundle),
    ...keyMaterial(bundle),
    uploadToken,
    files: files.map((file, i) => ({
      storageKey: items[i].storageKey,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    })),
  }, 'POST /confirm', params);
}

// An encrypted bundle sends its derived key (kAuth) as the password: 32 bytes as 43 base64url characters
// (BundleRules.MustBeAuthKey). The server only checks its shape and stores a hash, so a placeholder of that shape does.
const PLACEHOLDER_AUTH_KEY = 'k6-placeholder-auth-key-'.padEnd(43, 'C');

// An encrypted bundle's title may only be sent encrypted, so it gets none.
function bundleSettings({ title = null, expireInHours = 1, maxDownloads = null, password = null, encrypted = false }) {
  return {
    title: encrypted ? null : title,
    expireInHours,
    maxDownloads,
    password: encrypted ? PLACEHOLDER_AUTH_KEY : password,
    isEncrypted: encrypted,
  };
}

// The server only checks an encrypted bundle's sizes and the shape of its key material, so placeholders do: base64url
// of the lengths the browser sends (a 22-character salt, an 80-character envelope) and a short manifest.
function keyMaterial({ encrypted = false }) {
  if (!encrypted) {
    return {};
  }
  return {
    keySalt: 'k6placeholdersalt00000',
    keyEnvelope: 'k6-placeholder-envelope-'.padEnd(80, 'A'),
    encryptedManifest: 'k6-placeholder-manifest-'.padEnd(400, 'B'),
    keyMode: 'LinkKey',
  };
}

// EncryptedStreamFormat: 4 MiB chunks, each followed by a 16-byte tag; even an empty file has one chunk.
const CHUNK_PLAINTEXT_BYTES = 4 * 1024 * 1024;
const TAG_BYTES = 16;

/** The stored size of an encrypted file of `plaintextBytes` (EncryptedStreamFormat.EncryptedSize). */
export function encryptedSize(plaintextBytes) {
  return plaintextBytes + Math.max(1, Math.ceil(plaintextBytes / CHUNK_PLAINTEXT_BYTES)) * TAG_BYTES;
}

/** Records the step as a check, and ends the iteration (or setup) if it didn't answer as expected. */
function expect(res, status, what) {
  if (!check(res, { [`${what} answers ${status}`]: (r) => r.status === status })) {
    fail(`${what} answered ${res.status}: ${String(res.body).slice(0, 300)}`);
  }
  return res;
}

// Part URLs are signed this many at a time, as the browser does (MultipartLimits.MaxPresignBatchSize is 100).
const PART_BATCH = 50;

/**
 * Uploads one multipart file: part URLs in batches, `parallel` part PUTs at a time, then complete. Every part is
 * partSizeBytes long except the last, which holds the rest (MultipartUploadService.PartSizeBytes).
 */
export function uploadMultipart(uploadToken, item, sizeBytes, { parallel = 4, tags = {} } = {}) {
  const { storageKey, uploadId, partSizeBytes, totalParts } = item;
  const partSize = (partNumber) => (partNumber < totalParts ? partSizeBytes : sizeBytes - (totalParts - 1) * partSizeBytes);
  const parts = [];

  for (let start = 1; start <= totalParts; start += PART_BATCH) {
    const batch = expect(postJson('/multipart/presign-batch',
      { uploadToken, storageKey, uploadId, startPartNumber: start, count: Math.min(PART_BATCH, totalParts - start + 1) },
      'POST /multipart/presign-batch', { tags }), 200, 'presign-batch');

    const urls = batch.json('parts');
    for (let i = 0; i < urls.length; i += parallel) {
      const group = urls.slice(i, i + parallel);
      const responses = http.batch(group.map((part) => ({
        method: 'PUT',
        url: part.uploadUrl,
        body: contentOfSize(partSize(part.partNumber)),
        params: { tags: { name: 'PUT storage (part)', ...tags } },
      })));
      responses.forEach((res, j) => {
        expect(res, 200, 'a part PUT');
        parts.push({ partNumber: group[j].partNumber, eTag: res.headers.Etag });
      });
    }
  }

  expect(postJson('/multipart/complete', { uploadToken, storageKey, uploadId, parts },
    'POST /multipart/complete', { tags }), 200, 'complete');
}

/**
 * Presign, upload (single PUT or multipart, as presign decides) and confirm a bundle. Ends the iteration on any
 * failed step, each of which is a check. Returns the share token.
 */
export function uploadBundle({ files, ...bundle }, { parallel = 4, tags = {} } = {}) {
  const presigned = expect(presign(files, bundle, { tags }), 200, 'presign');
  const { uploadToken, items } = presigned.json();

  files.forEach((file, i) => {
    if (items[i].uploadMode === 'Single') {
      expect(putSingle(items[i], contentOfSize(file.sizeBytes), { tags }), 200, 'a single-file PUT');
    } else {
      uploadMultipart(uploadToken, items[i], file.sizeBytes, { parallel, tags });
    }
  });

  return expect(confirm(uploadToken, files, items, bundle, { tags }), 200, 'confirm').json();
}

/** uploadBundle with one small file unless told otherwise, for setting up a scenario. Returns the share token. */
export function createBundle({ files = [{ fileName: 'load.bin', contentType: 'application/octet-stream', sizeBytes: 1024 }], ...bundle } = {}) {
  return uploadBundle({ files, ...bundle });
}

/** GET /{token}: the bundle's details, as the download page loads them. */
export function getMetadata(shareToken, params = {}) {
  return http.get(`${API}/${shareToken}`, { ...params, tags: { name: 'GET /{token}', ...params.tags } });
}

/** POST /{token}/unlock with a password. */
export function unlock(shareToken, password, params = {}) {
  return postJson(`/${shareToken}/unlock`, { password }, 'POST /{token}/unlock', params);
}

/** POST /{token}/downloads: opens a download session, which counts as one download. */
export function openSession(shareToken, password = null, params = {}) {
  return postJson(`/${shareToken}/downloads`, { password }, 'POST /{token}/downloads', params);
}

/**
 * POST /{token}/download/{fileId}, then GET of the presigned storage URL it returns. A responseType in `params`
 * applies to the file only: the link's own JSON body is always read.
 */
export function downloadFile(shareToken, fileId, downloadSessionId, params = {}) {
  const { responseType, ...linkParams } = params;
  const link = postJson(`/${shareToken}/download/${fileId}`, { password: null, downloadSessionId },
    'POST /{token}/download/{fileId}', linkParams);
  if (link.status !== 200) {
    return link;
  }
  return http.get(link.json('downloadUrl'), { ...params, tags: { name: 'GET storage', ...params.tags } });
}

/**
 * GET /{token}/download-all for an open session: the server's ZIP of the whole bundle, streamed as it is built.
 * Pass responseType 'none' for large bundles, so k6 doesn't keep the body.
 */
export function downloadAll(shareToken, downloadSessionId, params = {}) {
  return http.get(`${API}/${shareToken}/download-all?downloadSessionId=${downloadSessionId}`,
    { ...params, tags: { name: 'GET /{token}/download-all', ...params.tags } });
}

/** The seconds a 429 says to wait, or null if it has no valid Retry-After. */
export function retryAfterSeconds(res) {
  const value = res.headers['Retry-After'];
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

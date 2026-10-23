// Calls to the FileHolder API, shared by the scenarios. Every request is tagged with a fixed `name`, so share tokens
// and storage keys never become metric labels (one series per token would swamp the summary and Prometheus).
import http from 'k6/http';
import { fail } from 'k6';

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
 * size is built per VU and reused.
 */
const buffers = new Map();
export function contentOfSize(sizeBytes) {
  if (!buffers.has(sizeBytes)) {
    const bytes = new Uint8Array(sizeBytes);
    for (let i = 0; i < sizeBytes; i++) {
      bytes[i] = i % 251;
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
    uploadToken,
    files: files.map((file, i) => ({
      storageKey: items[i].storageKey,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    })),
  }, 'POST /confirm', params);
}

function bundleSettings({ title = null, expireInHours = 1, maxDownloads = null, password = null }) {
  return { title, expireInHours, maxDownloads, password };
}

/**
 * Presign, upload and confirm a bundle of small files, failing the iteration (or setup) on any error. Returns the
 * share token. Files must be single-PUT uploads (50 MB or less each); no scenario uploads multipart files yet.
 */
export function createBundle({ files = [{ fileName: 'load.bin', contentType: 'application/octet-stream', sizeBytes: 1024 }], ...bundle } = {}) {
  const presigned = presign(files, bundle);
  if (presigned.status !== 200) {
    fail(`presign answered ${presigned.status}: ${presigned.body}`);
  }

  const { uploadToken, items } = presigned.json();
  files.forEach((file, i) => {
    if (items[i].uploadMode !== 'Single') {
      fail(`createBundle only uploads single-part files; ${file.fileName} needs a multipart upload`);
    }
    const put = putSingle(items[i], contentOfSize(file.sizeBytes));
    if (put.status !== 200) {
      fail(`storage PUT answered ${put.status}: ${put.body}`);
    }
  });

  const confirmed = confirm(uploadToken, files, items, bundle);
  if (confirmed.status !== 200) {
    fail(`confirm answered ${confirmed.status}: ${confirmed.body}`);
  }
  return confirmed.json();
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

/** POST /{token}/download/{fileId}, then GET of the presigned storage URL it returns. */
export function downloadFile(shareToken, fileId, downloadSessionId, params = {}) {
  const link = postJson(`/${shareToken}/download/${fileId}`, { password: null, downloadSessionId },
    'POST /{token}/download/{fileId}', params);
  if (link.status !== 200) {
    return link;
  }
  return http.get(link.json('downloadUrl'), { ...params, tags: { name: 'GET storage', ...params.tags } });
}

/** The seconds a 429 says to wait, or null if it has no valid Retry-After. */
export function retryAfterSeconds(res) {
  const value = res.headers['Retry-After'];
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

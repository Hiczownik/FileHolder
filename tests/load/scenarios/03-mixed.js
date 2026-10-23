// Scenario 3: mixed, realistic traffic. Uploads arrive at a steady rate: 70% small bundles, 20% medium, 10% large
// (multipart), and 30% of them encrypted, which to the server is only a matter of sizes and placeholder key material.
// Meanwhile recipients download bundles made in setup (k6 VUs share no state, so not the ones uploaded during the
// run): one file at a time, or as the server's ZIP. Scenario 8 (soak) runs these same functions slowly for hours.
//
// The sizes are smaller than real large uploads so a 15-minute run writes about 10 GB (see 02-large-multipart.js on
// why data, not time, is the limit); scenario 2 covers large files.
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import {
  downloadAll, downloadFile, encryptedSize, getMetadata, openSession, runTitle, uploadBundle,
} from '../lib/fileholder.js';

const MB = 1000 * 1000;

// Encrypted files are stored at their encrypted size; the name and type are what the browser sends for them.
function files(count, sizeBytes, encrypted, label) {
  return Array.from({ length: count }, (_, i) => encrypted
    ? { fileName: `${label}-${i + 1}.enc`, contentType: 'application/octet-stream', sizeBytes: encryptedSize(sizeBytes) }
    : { fileName: `${label}-${i + 1}.bin`, contentType: 'application/octet-stream', sizeBytes });
}

// [share of uploads, label, files, bytes per file]. Large is the only multipart one (over 50 MiB).
const MIX = [
  [0.7, 'small', 3, 1 * MB],
  [0.2, 'medium', 5, 20 * MB],
  [0.1, 'large', 1, 200 * MB],
];
const ENCRYPTED_SHARE = 0.3;

const uploads = new Counter('mixed_uploads');

/** One upload of the mix, picked at random. */
export function upload() {
  let pick = Math.random();
  const [, label, count, size] = MIX.find(([share]) => (pick -= share) < 0) ?? MIX[0];
  const encrypted = Math.random() < ENCRYPTED_SHARE;
  const tags = { size: label, encrypted: String(encrypted) };

  uploadBundle({ title: runTitle(`mixed ${label}`), encrypted, files: files(count, size, encrypted, label) }, { tags });
  uploads.add(1, tags);
}

/** One recipient: loads the page, opens a session, then fetches every file, or the ZIP. */
export function download(data) {
  const { shareToken, fileCount } = data.pool[Math.floor(Math.random() * data.pool.length)];

  const metadata = getMetadata(shareToken);
  check(metadata, { 'a recipient sees every file': (r) => r.status === 200 && r.json('fileCount') === fileCount });
  const session = openSession(shareToken);
  if (!check(session, { 'a recipient opens a download session': (r) => r.status === 200 }) || metadata.status !== 200) {
    return;
  }
  const sessionId = session.json('downloadSessionId');

  if (Math.random() < 0.3) {
    const zip = downloadAll(shareToken, sessionId, { responseType: 'none' });
    check(zip, { 'the ZIP downloads to the end': (r) => r.status === 200 && !r.error });
  } else {
    for (const file of metadata.json('files')) {
      check(downloadFile(shareToken, file.id, sessionId, { responseType: 'none' }), {
        'a file downloads to the end': (r) => r.status === 200 && !r.error,
      });
    }
  }
}

/** Bundles for the recipients: plain ones of the small and medium kinds, downloadable any number of times. */
export function createDownloadPool(small = 8, medium = 2) {
  const pool = [];
  for (const [kind, count, fileCount, size] of [['small', small, 3, 1 * MB], ['medium', medium, 5, 20 * MB]]) {
    for (let i = 0; i < count; i++) {
      pool.push({ shareToken: uploadBundle({ title: runTitle(`mixed pool ${kind}`), files: files(fileCount, size, false, kind) }), fileCount });
    }
  }
  return pool;
}

// The storage requests are left out of the per-endpoint latency limits: their time is mostly the transfer.
export const API_LATENCY_THRESHOLDS = {
  'http_req_duration{name:POST /presign}': ['p(95)<500'],
  'http_req_duration{name:POST /multipart/presign-batch}': ['p(95)<500'],
  'http_req_duration{name:POST /multipart/complete}': ['p(95)<2000'],
  'http_req_duration{name:POST /confirm}': ['p(95)<3000'],
  'http_req_duration{name:GET /{token}}': ['p(95)<200'],
  'http_req_duration{name:POST /{token}/downloads}': ['p(95)<500'],
  'http_req_duration{name:POST /{token}/download/{fileId}}': ['p(95)<200'],
};

const DURATION = __ENV.DURATION || '15m';
const UPLOADS_PER_MINUTE = Number(__ENV.UPLOADS_PER_MINUTE || 12);
const DOWNLOADS_PER_MINUTE = Number(__ENV.DOWNLOADS_PER_MINUTE || 60);

export const options = {
  setupTimeout: '5m',
  scenarios: {
    uploads: {
      executor: 'constant-arrival-rate',
      exec: 'upload',
      rate: UPLOADS_PER_MINUTE,
      timeUnit: '1m',
      duration: DURATION,
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
    downloads: {
      executor: 'constant-arrival-rate',
      exec: 'download',
      rate: DOWNLOADS_PER_MINUTE,
      timeUnit: '1m',
      duration: DURATION,
      preAllocatedVUs: 5,
      maxVUs: 10,
    },
  },
  thresholds: {
    ...API_LATENCY_THRESHOLDS,
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.999'],
    dropped_iterations: ['count==0'],
  },
};

export function setup() {
  return { pool: createDownloadPool() };
}

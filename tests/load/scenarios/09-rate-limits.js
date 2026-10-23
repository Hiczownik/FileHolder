// Scenario 9: rate limits at their production values (run without docker-compose.load-capacity.yml). Each policy is
// pushed past its limit by one client: it must answer 429 with a Retry-After, never a 5xx, and a client that waits
// as long as Retry-After says gets through again. Once aligned to a fresh window that way, exactly the limit's number
// of requests get through before the next 429. The policies have separate limiters, so they are tested in parallel.
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import http from 'k6/http';
import { API, createBundle, getMetadata, presign, randomToken, retryAfterSeconds, runTitle, unlock } from '../lib/fileholder.js';

// RateLimitOptions.Default*PermitLimit. Override them (e.g. -e LIMIT_DOWNLOAD=50) for a stack with other limits.
const LIMITS = {
  uploadInitiate: Number(__ENV.LIMIT_UPLOAD_INITIATE || 10),
  multipartPipeline: Number(__ENV.LIMIT_MULTIPART_PIPELINE || 300),
  confirm: Number(__ENV.LIMIT_CONFIRM || 10),
  download: Number(__ENV.LIMIT_DOWNLOAD || 30),
  metadata: Number(__ENV.LIMIT_METADATA || 60),
};

const serverErrors = new Counter('rate_limit_server_errors');

// 429s are what this scenario provokes, and the confirms of made-up uploads answer 404.
http.setResponseCallback(http.expectedStatuses(200, 404, 429));

const SMALL_FILE = [{ fileName: 'limits.bin', contentType: 'application/octet-stream', sizeBytes: 1024 }];

// One cheap request per policy, each answered without a 429 while under the limit. Presigns are never confirmed,
// so they leave PendingUploads rows that expire after a day (UploadTimings.PendingUploadLifetime), and no objects.
const REQUESTS = {
  uploadInitiate: () => presign(SMALL_FILE, { title: runTitle('rate limits') }),
  // Aborting an upload nobody started answers 200 false after one database read.
  multipartPipeline: () => http.post(`${API}/multipart/abort`,
    JSON.stringify({ uploadToken: randomToken(), storageKey: 'uploads/none', uploadId: 'none' }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'POST /multipart/abort' } }),
  // A well-formed confirm of an upload token nobody was given: 404.
  confirm: () => http.post(`${API}/confirm`, JSON.stringify({
    uploadToken: randomToken(), expireInHours: 1,
    files: [{ storageKey: 'uploads/none', fileName: 'limits.bin', contentType: 'application/octet-stream', sizeBytes: 1024 }],
  }), { headers: { 'Content-Type': 'application/json' }, tags: { name: 'POST /confirm' } }),
  download: (data) => unlock(data.shareToken, null),
  metadata: (data) => getMetadata(data.shareToken),
};

const EXPECTED_STATUS = { uploadInitiate: 200, multipartPipeline: 200, confirm: 404, download: 200, metadata: 200 };

export const options = {
  setupTimeout: '1m',
  scenarios: Object.fromEntries(Object.keys(LIMITS).map((policy) => [policy, {
    executor: 'per-vu-iterations',
    exec: policy,
    vus: 1,
    iterations: 1,
    maxDuration: '5m',
  }])),
  thresholds: {
    rate_limit_server_errors: ['count==0'],
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  serverErrors.add(0);
  return { shareToken: createBundle({ title: runTitle('rate limits') }) };
}

function send(policy, data) {
  const res = REQUESTS[policy](data);
  if (res.status >= 500) {
    serverErrors.add(1, { policy });
    console.error(`${policy}: answered ${res.status}: ${res.body}`);
  }
  return res;
}

function exercise(policy, data) {
  const limit = LIMITS[policy];

  // Push until the first 429. The window may already be partly used (setup's own requests count) or reset part
  // way, so this takes anywhere from 1 to 2 x limit + 1 requests.
  let rejected = null;
  for (let i = 0; i <= 2 * limit + 1 && rejected === null; i++) {
    const res = send(policy, data);
    if (res.status === 429) {
      rejected = res;
    }
  }
  if (!check(rejected, { [`${policy}: a client past the limit gets 429`]: (r) => r !== null })) {
    return;
  }

  const retryAfter = retryAfterSeconds(rejected);
  check(retryAfter, { [`${policy}: the 429 says when to retry (1-60 s)`]: (s) => s !== null && s >= 1 && s <= 60 });
  check(send(policy, data), { [`${policy}: a client that doesn't wait is refused again`]: (r) => r.status === 429 });

  // Retry-After is rounded up to whole seconds; the limiter replenishes on a short timer, hence the extra moment.
  sleep((retryAfter ?? 60) + 0.5);

  // A fresh window: exactly `limit` requests get through, the next one is refused.
  let passed = 0;
  let first = null;
  for (let i = 0; i < limit; i++) {
    const res = send(policy, data);
    first = first ?? res;
    if (res.status === EXPECTED_STATUS[policy]) {
      passed++;
    }
  }
  check(first, { [`${policy}: a client that waited Retry-After gets through`]: (r) => r.status === EXPECTED_STATUS[policy] });
  check(passed, { [`${policy}: exactly ${limit} requests pass in a fresh window`]: (n) => n === limit });
  check(send(policy, data), { [`${policy}: request ${limit + 1} in the window is refused`]: (r) => r.status === 429 });
}

export const uploadInitiate = (data) => exercise('uploadInitiate', data);
export const multipartPipeline = (data) => exercise('multipartPipeline', data);
export const confirm = (data) => exercise('confirm', data);
export const download = (data) => exercise('download', data);
export const metadata = (data) => exercise('metadata', data);

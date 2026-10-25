// Scenario 1: many small files. Bundles of 50 x 100 KB, presign -> 50 PUTs -> confirm, by a ramp of 1 to 20 clients.
// Confirm makes about three storage calls per single-file upload, one after another (size check, copy, size check
// on the copy), so a 50-file bundle's confirm is the slow request to watch (#37). Each bundle is then opened and one
// of its files downloaded, to show it really is downloadable.
import { check } from 'k6';
import { downloadFile, getMetadata, openSession, runTitle, uploadBundle } from '../lib/fileholder.js';

const FILES_PER_BUNDLE = Number(__ENV.FILES || 50);
const FILE_SIZE = Number(__ENV.FILE_SIZE || 100 * 1024);
const RAMP = __ENV.DURATION || '5m';
const MAX_CLIENTS = Number(__ENV.CLIENTS || 20);

// Set from a first run on known hardware (tests/load/README.md, Baseline); raise it for slower machines.
const CONFIRM_P95_MS = Number(__ENV.CONFIRM_P95_MS || 3000);

const FILES = Array.from({ length: FILES_PER_BUNDLE }, (_, i) => ({
  fileName: `small-${String(i + 1).padStart(2, '0')}.txt`,
  contentType: 'text/plain',
  sizeBytes: FILE_SIZE,
}));

export const options = {
  scenarios: {
    upload: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [{ duration: RAMP, target: MAX_CLIENTS }],
      gracefulRampDown: '1m',
    },
  },
  thresholds: {
    'http_req_duration{name:POST /confirm}': [`p(95)<${CONFIRM_P95_MS}`],
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export default function () {
  const shareToken = uploadBundle({ title: runTitle('small files'), files: FILES });

  const metadata = getMetadata(shareToken);
  check(metadata, { 'the bundle lists all its files': (r) => r.status === 200 && r.json('fileCount') === FILES_PER_BUNDLE });

  const session = openSession(shareToken);
  check(session, { 'a download session opens': (r) => r.status === 200 });
  if (metadata.status !== 200 || session.status !== 200) {
    return;
  }

  const files = metadata.json('files');
  const file = files[Math.floor(Math.random() * files.length)];
  check(downloadFile(shareToken, file.id, session.json('downloadSessionId'), { responseType: 'binary' }), {
    'a file of the bundle downloads in full': (r) => r.status === 200 && r.body.byteLength === FILE_SIZE,
  });
}

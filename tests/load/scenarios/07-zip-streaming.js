// Scenario 7: server ZIP streaming. 20 clients download one 1 GiB bundle with download-all at the same moment. The
// API builds each ZIP as it streams it (BundleStreamService, through a 128 KiB pipe) and nginx passes it on unbuffered
// (proxy_buffering off), so the API's memory must stay flat and the first bytes arrive at once.
//
// The files are named .zip, which the server stores without compressing again, so each ZIP is the files' bytes plus a
// few hundred bytes of headers. k6 discards the bodies (1 GiB each would fill its memory); the scenario's received
// bytes show every ZIP arrived whole.
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { downloadAll, getMetadata, openSession, runTitle, uploadBundle } from '../lib/fileholder.js';
import { apiMemoryAfterScrape, apiPeakWorkingSetBytes, SCRAPE_WAIT_SECONDS } from '../lib/prometheus.js';
import { sleepUntil } from '../lib/timing.js';

const CLIENTS = Number(__ENV.CLIENTS || 20);
const FILES = Number(__ENV.FILES || 4);
const FILE_SIZE = Number(__ENV.FILE_SIZE || 256 * 1024 * 1024);
const BUNDLE_BYTES = FILES * FILE_SIZE;

// Received bytes include the chunked encoding's framing, about 8 bytes per 4 KiB chunk nginx passes on (0.17%
// measured), plus each ZIP's own headers and the session request's response. A ZIP cut off part way ends without
// the final chunk, which k6 reports as an error ('the ZIP downloads to the end').
const FRAMING_SHARE = 0.005;
const OVERHEAD_PER_CLIENT = 64 * 1024;

// 20 ZIPs buffered would be 20 GiB; streamed, each holds a 128 KiB pipe and copy buffers.
const MAX_WORKING_SET_GROWTH_MB = Number(__ENV.MAX_WORKING_SET_GROWTH_MB || 200);

const workingSetGrowth = new Trend('api_working_set_peak_growth_mb');

export const options = {
  setupTimeout: '10m',
  teardownTimeout: '1m',
  scenarios: {
    zip: {
      executor: 'per-vu-iterations',
      vus: CLIENTS,
      iterations: 1,
      maxDuration: '30m',
    },
  },
  thresholds: {
    // A ZIP short by more than the framing would bring this under the files' bytes.
    'data_received{scenario:zip}': [
      `count>=${CLIENTS * BUNDLE_BYTES}`,
      `count<=${Math.ceil(CLIENTS * (BUNDLE_BYTES * (1 + FRAMING_SHARE) + OVERHEAD_PER_CLIENT))}`,
    ],
    // Streaming: the first bytes come once the first file is opened, not once the ZIP is built.
    'http_req_waiting{name:GET /{token}/download-all}': ['p(95)<2000'],
    api_working_set_peak_growth_mb: [`max<${MAX_WORKING_SET_GROWTH_MB}`],
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  const shareToken = uploadBundle({
    title: runTitle('zip streaming'),
    files: Array.from({ length: FILES }, (_, i) => ({ fileName: `archive-${i + 1}.zip`, contentType: 'application/zip', sizeBytes: FILE_SIZE })),
  });
  check(getMetadata(shareToken), { 'the bundle holds every file': (r) => r.status === 200 && r.json('totalSizeBytes') === BUNDLE_BYTES });

  const before = apiMemoryAfterScrape();
  return { shareToken, before, startAt: Date.now() + 2000 };
}

export default function (data) {
  // Opened before the shared start, so all ZIP requests leave together.
  const session = openSession(data.shareToken);
  if (!check(session, { 'a download session opens': (r) => r.status === 200 })) {
    return;
  }

  sleepUntil(data.startAt);
  const zip = downloadAll(data.shareToken, session.json('downloadSessionId'), { responseType: 'none', timeout: '20m' });
  check(zip, {
    'the ZIP downloads to the end': (r) => r.status === 200 && !r.error,
    'it is a ZIP': (r) => r.headers['Content-Type'] === 'application/zip',
  });
}

export function teardown(data) {
  sleep(SCRAPE_WAIT_SECONDS);
  const peak = apiPeakWorkingSetBytes((Date.now() - data.startAt) / 1000 + 5);
  const mb = (bytes) => bytes / (1024 * 1024);
  workingSetGrowth.add(mb(peak - data.before.workingSetBytes));
  console.log(`API working set ${mb(data.before.workingSetBytes).toFixed(1)} MB before, peak ${mb(peak).toFixed(1)} MB`);
}

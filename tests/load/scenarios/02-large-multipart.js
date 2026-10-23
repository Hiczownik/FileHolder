// Scenario 2: large multipart uploads. Each client uploads a 2 GiB file in 16 MiB parts, 4 at a time, as the browser
// does. The parts go straight to storage, so the API only signs part URLs and completes the upload, and its memory
// must stay flat. Records the upload throughput.
//
// Bounded by data rather than time: Docker Desktop's virtual disk grows to the most it ever held and doesn't shrink,
// so the default writes 10 GiB (5 clients x 1 file). run.ps1 purges it afterwards. ITERATIONS adds more files.
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { getMetadata, runTitle, uploadBundle } from '../lib/fileholder.js';
import { apiMemoryAfterScrape, apiPeakWorkingSetBytes } from '../lib/prometheus.js';

const CLIENTS = Number(__ENV.CLIENTS || 5);
const ITERATIONS = Number(__ENV.ITERATIONS || 1);
const FILE_SIZE = Number(__ENV.FILE_SIZE || 2 * 1024 * 1024 * 1024);
const PARALLEL_PARTS = Number(__ENV.PARALLEL_PARTS || 4);

// The API holds no file data, so its working set may only move by what any busy period costs.
const MAX_WORKING_SET_GROWTH_MB = Number(__ENV.MAX_WORKING_SET_GROWTH_MB || 150);

// Per client (each upload's size over its time), and for all clients together.
const throughput = new Trend('upload_throughput_mb_s');
const totalThroughput = new Trend('upload_throughput_all_clients_mb_s');
const uploadedBytes = new Counter('uploaded_bytes');
const workingSetGrowth = new Trend('api_working_set_peak_growth_mb');

export const options = {
  setupTimeout: '1m',
  teardownTimeout: '1m',
  scenarios: {
    upload: {
      executor: 'per-vu-iterations',
      vus: CLIENTS,
      iterations: ITERATIONS,
      maxDuration: '1h',
    },
  },
  thresholds: {
    api_working_set_peak_growth_mb: [`max<${MAX_WORKING_SET_GROWTH_MB}`],
    uploaded_bytes: [`count==${CLIENTS * ITERATIONS * FILE_SIZE}`],
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  const before = apiMemoryAfterScrape();
  return { before, startedAt: Date.now() };
}

export default function () {
  const started = Date.now();
  const shareToken = uploadBundle({
    title: runTitle(`large multipart ${exec.vu.idInTest}`),
    files: [{ fileName: 'large.bin', contentType: 'application/octet-stream', sizeBytes: FILE_SIZE }],
  }, { parallel: PARALLEL_PARTS });
  const seconds = (Date.now() - started) / 1000;

  throughput.add(FILE_SIZE / (1024 * 1024) / seconds);
  uploadedBytes.add(FILE_SIZE);

  check(getMetadata(shareToken), { 'the bundle has the whole file': (r) => r.status === 200 && r.json('totalSizeBytes') === FILE_SIZE });
}

export function teardown(data) {
  const mb = (bytes) => bytes / (1024 * 1024);
  totalThroughput.add(mb(CLIENTS * ITERATIONS * FILE_SIZE) / ((Date.now() - data.startedAt) / 1000));

  const after = apiMemoryAfterScrape();
  const peak = apiPeakWorkingSetBytes((Date.now() - data.startedAt) / 1000);
  workingSetGrowth.add(mb(peak - data.before.workingSetBytes));
  console.log(`API working set ${mb(data.before.workingSetBytes).toFixed(1)} MB before, peak ${mb(peak).toFixed(1)} MB, `
    + `${mb(after.workingSetBytes).toFixed(1)} MB after`);
}

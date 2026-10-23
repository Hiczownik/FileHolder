// Scenario 8: soak. Scenario 3's mixed traffic at a low rate for 2 hours. Nothing may build up: the API's memory in
// the last 15 minutes must stay close to what it was early on, and run.ps1 samples Postgres connections throughout.
// The bundles uploaded here expire after an hour, so the purge runs for real during the soak:
// checks/08-soak.sql then checks that every bundle due for purging was purged.
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { createDownloadPool, download, upload } from './03-mixed.js';
import { apiAverageWorkingSetBytes, apiMemoryAfterScrape } from '../lib/prometheus.js';

export { download, upload };

const DURATION = __ENV.DURATION || '2h';
const UPLOADS_PER_MINUTE = Number(__ENV.UPLOADS_PER_MINUTE || 2);
const DOWNLOADS_PER_MINUTE = Number(__ENV.DOWNLOADS_PER_MINUTE || 10);
const MAX_WORKING_SET_GROWTH_MB = Number(__ENV.MAX_WORKING_SET_GROWTH_MB || 100);

// Memory is compared over two 15-minute windows: one after 10 minutes of warm-up, and the last one.
const WINDOW_SECONDS = 15 * 60;
const WARM_UP_SECONDS = 10 * 60;

const workingSetGrowth = new Trend('api_working_set_growth_mb');

export const options = {
  setupTimeout: '5m',
  teardownTimeout: '2m',
  scenarios: {
    uploads: {
      executor: 'constant-arrival-rate',
      exec: 'upload',
      rate: UPLOADS_PER_MINUTE,
      timeUnit: '1m',
      duration: DURATION,
      preAllocatedVUs: 2,
      maxVUs: 3,
    },
    downloads: {
      executor: 'constant-arrival-rate',
      exec: 'download',
      rate: DOWNLOADS_PER_MINUTE,
      timeUnit: '1m',
      duration: DURATION,
      preAllocatedVUs: 2,
      maxVUs: 2,
    },
  },
  thresholds: {
    api_working_set_growth_mb: [`max<${MAX_WORKING_SET_GROWTH_MB}`],
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.999'],
    dropped_iterations: ['count==0'],
  },
};

export function setup() {
  return { pool: createDownloadPool(4, 1), startedAt: Date.now() };
}

export function teardown(data) {
  apiMemoryAfterScrape();
  const elapsed = (Date.now() - data.startedAt) / 1000;
  const earlyEndsAgo = elapsed - WARM_UP_SECONDS - WINDOW_SECONDS;

  // A short run (DURATION=20m, say) has no separate early window to compare with.
  if (!check(earlyEndsAgo, { 'the soak ran long enough to compare its memory': (s) => s > WINDOW_SECONDS })) {
    return;
  }

  const early = apiAverageWorkingSetBytes(WINDOW_SECONDS, earlyEndsAgo);
  const late = apiAverageWorkingSetBytes(WINDOW_SECONDS);
  const mb = (bytes) => bytes / (1024 * 1024);
  workingSetGrowth.add(mb(late - early));
  console.log(`API working set: ${mb(early).toFixed(1)} MB on average early on, ${mb(late).toFixed(1)} MB at the end`);
}

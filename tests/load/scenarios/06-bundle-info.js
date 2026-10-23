// Scenario 6: bundle info under load. One popular bundle's page is loaded over and over while far more requests ask
// for random unknown tokens. The popular one is served from the cache (HybridCache, FileGroupService
// .GetGroupMetadataByTokenAsync), so it stays fast. Unknown tokens must not be cached: anyone can make them up, so
// caching them would let a client fill the API's memory. The API's heap is read from Prometheus before and after.
import http from 'k6/http';
import { check } from 'k6';
import { Gauge } from 'k6/metrics';
import { createBundle, getMetadata, randomToken, runTitle } from '../lib/fileholder.js';
import { apiMemoryAfterScrape } from '../lib/prometheus.js';

const DURATION = __ENV.DURATION || '2m';
const KNOWN_RATE = Number(__ENV.KNOWN_RATE || 100);
const UNKNOWN_RATE = Number(__ENV.UNKNOWN_RATE || 1400);

// Together under the raised metadata limit of 100,000 a minute (docker-compose.load-capacity.yml).
// At the default rates that is 168,000 unknown tokens in 2 minutes. On a 16-core desktop the heap grew 2 MB; with
// the cache eviction of unknown tokens removed on purpose, it grew 129 MB.
const MAX_HEAP_GROWTH_MB = Number(__ENV.MAX_HEAP_GROWTH_MB || 48);

const heapGrowth = new Gauge('api_heap_growth_mb');
const workingSetGrowth = new Gauge('api_working_set_growth_mb');

// Unknown tokens' 404s are expected.
http.setResponseCallback(http.expectedStatuses(200, 404));

function arrivalRate(rate, exec) {
  return {
    executor: 'constant-arrival-rate',
    exec,
    rate,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: Math.ceil(rate / 10),
    maxVUs: Math.ceil(rate / 2),
  };
}

// A few iterations k6 couldn't start in time don't matter; many would mean far fewer unknown tokens were tried.
// A tenth of a second's worth: under 0.1% of a 2-minute run.
const MAX_DROPPED = Math.ceil((KNOWN_RATE + UNKNOWN_RATE) / 10);

export const options = {
  setupTimeout: '1m',
  teardownTimeout: '1m',
  scenarios: {
    known: arrivalRate(KNOWN_RATE, 'known'),
    unknown: arrivalRate(UNKNOWN_RATE, 'unknown'),
  },
  thresholds: {
    'http_req_duration{scenario:known}': ['p(95)<50'],
    'http_req_duration{scenario:unknown}': ['p(95)<250'],
    api_heap_growth_mb: [`value<${MAX_HEAP_GROWTH_MB}`],
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
    dropped_iterations: [`count<=${MAX_DROPPED}`],
  },
};

export function setup() {
  const shareToken = createBundle({ title: runTitle('bundle info') });
  return { shareToken, before: apiMemoryAfterScrape() };
}

export function known(data) {
  check(getMetadata(data.shareToken), {
    'the popular bundle loads (200)': (r) => r.status === 200 && r.json('fileCount') === 1,
  });
}

export function unknown() {
  check(getMetadata(randomToken()), { 'an unknown token is not found (404)': (r) => r.status === 404 });
}

export function teardown(data) {
  const after = apiMemoryAfterScrape();
  const mb = (bytes) => bytes / (1024 * 1024);
  heapGrowth.add(mb(after.heapBytes - data.before.heapBytes));
  workingSetGrowth.add(mb(after.workingSetBytes - data.before.workingSetBytes));
  console.log(`API heap ${mb(data.before.heapBytes).toFixed(1)} -> ${mb(after.heapBytes).toFixed(1)} MB, `
    + `working set ${mb(data.before.workingSetBytes).toFixed(1)} -> ${mb(after.workingSetBytes).toFixed(1)} MB`);
}

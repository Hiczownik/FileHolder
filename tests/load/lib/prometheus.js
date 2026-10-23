// Reads the API's own metrics from the compose stack's Prometheus, which scrapes the API every 5 s.
import http from 'k6/http';
import { fail, sleep } from 'k6';

const PROMETHEUS = __ENV.PROMETHEUS_URL || 'http://prometheus:9090';

// Long enough for at least one scrape after the moment of interest (docker/prometheus/prometheus.yml).
export const SCRAPE_WAIT_SECONDS = 12;

/** The value of an instant query that returns one series, e.g. sum(...). */
export function queryNumber(expr) {
  const res = http.get(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(expr)}`, {
    tags: { name: 'prometheus query' },
  });
  const result = res.status === 200 ? res.json('data.result') : null;
  if (!result || result.length !== 1) {
    fail(`Prometheus query "${expr}" answered ${res.status} with ${res.body}`);
  }
  return Number(result[0].value[1]);
}

/** The API's managed heap after its last garbage collection, all generations together. */
export function apiHeapBytes() {
  return queryNumber('sum(dotnet_gc_last_collection_heap_size_bytes{job="fileholder-api"})');
}

/** The API process's working set. */
export function apiWorkingSetBytes() {
  return queryNumber('sum(dotnet_process_memory_working_set_bytes{job="fileholder-api"})');
}

/** The API process's highest working set over the last `seconds`, from Prometheus' 5 s samples. */
export function apiPeakWorkingSetBytes(seconds) {
  return queryNumber(`max_over_time(sum(dotnet_process_memory_working_set_bytes{job="fileholder-api"})[${Math.ceil(seconds)}s:5s])`);
}

/** The API process's average working set over `seconds`, ending `endSecondsAgo` seconds ago. */
export function apiAverageWorkingSetBytes(seconds, endSecondsAgo = 0) {
  const offset = endSecondsAgo > 0 ? ` offset ${Math.floor(endSecondsAgo)}s` : '';
  return queryNumber(`avg_over_time(sum(dotnet_process_memory_working_set_bytes{job="fileholder-api"})[${Math.ceil(seconds)}s:5s]${offset})`);
}

/** Waits for a fresh scrape, then reads both memory figures. */
export function apiMemoryAfterScrape() {
  sleep(SCRAPE_WAIT_SECONDS);
  return { heapBytes: apiHeapBytes(), workingSetBytes: apiWorkingSetBytes() };
}

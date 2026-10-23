// Scenario 4: download race. 100 clients open a download session on one bundle with MaxDownloads = 5 at the same
// moment. Opening a session is one conditional UPDATE (DownloadSessionService.OpenSessionAsync), so exactly 5 may
// succeed however many race; the rest are told the bundle is gone (410). Repeated with a new bundle per burst.
// After the run, checks/04-download-race.sql checks each bundle's DownloadCount and sessions in the database.
import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { createBundle, downloadFile, getMetadata, openSession, runTitle } from '../lib/fileholder.js';
import { sleepUntil } from '../lib/timing.js';

const CLIENTS = Number(__ENV.CLIENTS || 100);
const BURSTS = Number(__ENV.BURSTS || 20);
const MAX_DOWNLOADS = 5;
const FILE_SIZE = 64 * 1024;

// Each burst gets its own start time; this leaves the winners time to download the file before the next one.
const BURST_SPACING_MS = 3000;

const opened = new Counter('race_sessions_opened');
const refused = new Counter('race_sessions_refused');
const unexpected = new Counter('race_unexpected_responses');

// The losers' 410s are expected, so http_req_failed counts only real failures.
http.setResponseCallback(http.expectedStatuses(200, 410));

const perBurstThresholds = {};
for (let burst = 0; burst < BURSTS; burst++) {
  perBurstThresholds[`race_sessions_opened{burst:${burst}}`] = [`count==${MAX_DOWNLOADS}`];
  perBurstThresholds[`race_sessions_refused{burst:${burst}}`] = [`count==${CLIENTS - MAX_DOWNLOADS}`];
}

export const options = {
  setupTimeout: '5m',
  scenarios: {
    race: {
      executor: 'per-vu-iterations',
      vus: CLIENTS,
      iterations: BURSTS,
      maxDuration: '10m',
    },
  },
  thresholds: {
    ...perBurstThresholds,
    race_unexpected_responses: ['count==0'],
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  const bundles = [];
  for (let burst = 0; burst < BURSTS; burst++) {
    const shareToken = createBundle({
      title: runTitle(`download race ${burst}`),
      maxDownloads: MAX_DOWNLOADS,
      files: [{ fileName: 'race.bin', contentType: 'application/octet-stream', sizeBytes: FILE_SIZE }],
    });
    const fileId = getMetadata(shareToken).json('files.0.id');
    bundles.push({ shareToken, fileId });

    // A zero sample per burst, so a burst nobody won still has a value for its threshold to fail on.
    opened.add(0, { burst: String(burst) });
    refused.add(0, { burst: String(burst) });
  }
  unexpected.add(0);

  // Every VU waits for the same moment, a little after setup, before its first burst.
  return { bundles, firstBurstAt: Date.now() + 2000 };
}

export default function (data) {
  const burst = exec.vu.iterationInScenario;
  const { shareToken, fileId } = data.bundles[burst];
  const tags = { burst: String(burst) };

  sleepUntil(data.firstBurstAt + burst * BURST_SPACING_MS);
  const res = openSession(shareToken, null, { tags });

  check(res, { 'a session is opened, or refused as gone (410)': (r) => r.status === 200 || r.status === 410 });

  if (res.status === 200) {
    opened.add(1, tags);
    // A session that was opened must work: its file downloads in full.
    const file = downloadFile(shareToken, fileId, res.json('downloadSessionId'), { tags, responseType: 'binary' });
    check(file, { 'a winner downloads the whole file': (r) => r.status === 200 && r.body.byteLength === FILE_SIZE });
  } else if (res.status === 410) {
    refused.add(1, tags);
  } else {
    unexpected.add(1, tags);
    console.error(`burst ${burst}: opening a session answered ${res.status}: ${res.body}`);
  }
}

export function teardown(data) {
  // The last session marks the bundle deleted, so its page says it is gone.
  for (const { shareToken } of data.bundles) {
    check(getMetadata(shareToken), { 'a used-up bundle reports gone (410)': (r) => r.status === 410 });
  }
}

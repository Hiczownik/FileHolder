// Scenario 5: parallel password guessing. 50 clients send a wrong password to one protected bundle at the same moment.
// The first FreeAttempts guesses are verified freely; the next one claims a short verification hold
// (PasswordLockout.VerificationHold, PasswordAttemptGuard), so exactly one more guess is verified and every other
// one is refused with 429 before bcrypt runs. That guess's failure then locks the bundle for LockoutAfter(6) = 1 min.
// Then the uploader's correct password is refused while locked, accepted once the lockout ends, and resets the count.
// Repeated with a new bundle per burst. checks/05-password-guessing.sql checks the counters left in the database.
import exec from 'k6/execution';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { createBundle, retryAfterSeconds, runTitle, unlock } from '../lib/fileholder.js';
import { sleepUntil } from '../lib/timing.js';

const GUESSERS = Number(__ENV.CLIENTS || 50);
const BURSTS = Number(__ENV.BURSTS || 5);
const PASSWORD = 'correct horse battery staple';

// PasswordLockout.cs: the free attempts, and the lockout after the first guess past them.
const FREE_ATTEMPTS = 5;
const FIRST_LOCKOUT_SECONDS = 60;

// Bursts start this far apart; the uploader checks a burst's bundle this long after it, once its guesses are answered.
const BURST_SPACING_MS = 4000;
const SETTLE_MS = 3000;

const verified = new Counter('guesses_verified');
const lockedOut = new Counter('guesses_locked_out');
const unexpected = new Counter('guesses_unexpected_responses');

// Wrong passwords (401) and lockouts (429) are what this scenario expects.
http.setResponseCallback(http.expectedStatuses(200, 401, 429));

const perBurstThresholds = {};
for (let burst = 0; burst < BURSTS; burst++) {
  perBurstThresholds[`guesses_verified{burst:${burst}}`] = [`count==${FREE_ATTEMPTS + 1}`];
  perBurstThresholds[`guesses_locked_out{burst:${burst}}`] = [`count==${GUESSERS - FREE_ATTEMPTS - 1}`];
}

export const options = {
  setupTimeout: '2m',
  scenarios: {
    guessers: {
      executor: 'per-vu-iterations',
      exec: 'guess',
      vus: GUESSERS,
      iterations: BURSTS,
      maxDuration: '5m',
    },
    uploader: {
      executor: 'per-vu-iterations',
      exec: 'uploader',
      vus: BURSTS,
      iterations: 1,
      maxDuration: '5m',
    },
  },
  thresholds: {
    ...perBurstThresholds,
    guesses_unexpected_responses: ['count==0'],
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  const bundles = [];
  for (let burst = 0; burst < BURSTS; burst++) {
    bundles.push(createBundle({ title: runTitle(`password guessing ${burst}`), password: PASSWORD }));
    verified.add(0, { burst: String(burst) });
    lockedOut.add(0, { burst: String(burst) });
  }
  unexpected.add(0);
  return { bundles, firstBurstAt: Date.now() + 2000 };
}

export function guess(data) {
  const burst = exec.vu.iterationInScenario;
  const tags = { burst: String(burst) };

  sleepUntil(data.firstBurstAt + burst * BURST_SPACING_MS);
  const res = unlock(data.bundles[burst], `wrong guess ${exec.vu.idInTest}`, { tags });

  if (res.status === 401) {
    verified.add(1, tags);
  } else if (res.status === 429) {
    lockedOut.add(1, tags);
    check(res, { 'a refused guess says when to retry': (r) => retryAfterSeconds(r) !== null });
  } else {
    unexpected.add(1, tags);
    console.error(`burst ${burst}: a guess answered ${res.status}: ${res.body}`);
  }
}

export function uploader(data) {
  // One uploader iteration per burst, numbered 0, 1, ... across this scenario's VUs.
  const burst = exec.scenario.iterationInTest;
  const shareToken = data.bundles[burst];
  const tags = { burst: String(burst) };

  sleepUntil(data.firstBurstAt + burst * BURST_SPACING_MS + SETTLE_MS);

  const whileLocked = unlock(shareToken, PASSWORD, { tags });
  const retryAfter = retryAfterSeconds(whileLocked);
  check(whileLocked, {
    'the correct password is refused while locked (429)': (r) => r.status === 429,
    // The lockout started when the last verified guess failed, a moment ago.
    'the lockout lasts LockoutAfter(6) = 1 minute': () =>
      retryAfter !== null && retryAfter <= FIRST_LOCKOUT_SECONDS && retryAfter >= FIRST_LOCKOUT_SECONDS - SETTLE_MS / 1000 - 5,
  });

  sleep((retryAfter ?? FIRST_LOCKOUT_SECONDS) + 1);
  check(unlock(shareToken, PASSWORD, { tags }), {
    'the correct password is accepted once the lockout ends': (r) => r.status === 200 && r.json('isUnlocked') === true,
  });

  // A correct password resets the count, so the next wrong one is a free attempt again, not a lockout.
  check(unlock(shareToken, 'one more typo', { tags }), {
    'after a correct password, a wrong one is free again (401)': (r) => r.status === 401,
  });
}

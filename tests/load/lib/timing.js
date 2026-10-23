import { sleep } from 'k6';

/**
 * Sleeps until the given time (milliseconds since the epoch). k6 has no barrier between VUs, so a burst is started by
 * giving every VU the same start time: they all wake within a millisecond or two of each other.
 */
export function sleepUntil(epochMs) {
  const waitMs = epochMs - Date.now();
  if (waitMs > 0) {
    sleep(waitMs / 1000);
  }
}

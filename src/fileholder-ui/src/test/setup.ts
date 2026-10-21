import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import fc from 'fast-check';

// Property tests (*.properties.test.ts) run on a fixed seed, so every CI run tries the same inputs and a failure
// reproduces exactly. The nightly run sets FC_RANDOM=1 for fresh inputs and FC_NUM_RUNS for many more of them; a
// failure there prints its seed, and FC_SEED=<seed> (with the same FC_NUM_RUNS) reruns it (see the README).
const FIXED_SEED = 1734120533;
const DEFAULT_NUM_RUNS = 200;
const configuredRuns = Number.parseInt(process.env.FC_NUM_RUNS ?? '', 10);
const replaySeed = Number.parseInt(process.env.FC_SEED ?? '', 10);
const randomSeed = process.env.FC_RANDOM === '1' ? {} : { seed: FIXED_SEED };
fc.configureGlobal({
  ...(Number.isNaN(replaySeed) ? randomSeed : { seed: replaySeed }),
  numRuns: Number.isNaN(configuredRuns) ? DEFAULT_NUM_RUNS : configuredRuns,
});

// Automatically unmount and clean up the DOM after each test
afterEach(() => {
  cleanup();
});
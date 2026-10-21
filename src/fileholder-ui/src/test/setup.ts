import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import fc from 'fast-check';

// Property tests (*.properties.test.ts) run on a fixed seed, so every CI run tries the same inputs and a failure
// reproduces exactly. The nightly run sets FC_RANDOM=1 for fresh inputs and FC_NUM_RUNS for many more of them; a
// failure there prints its seed and path, which go into fc.configureGlobal (or { seed, path } on the test) to rerun it.
const FIXED_SEED = 1734120533;
const DEFAULT_NUM_RUNS = 200;
const configuredRuns = Number.parseInt(process.env.FC_NUM_RUNS ?? '', 10);
fc.configureGlobal({
  ...(process.env.FC_RANDOM === '1' ? {} : { seed: FIXED_SEED }),
  numRuns: Number.isNaN(configuredRuns) ? DEFAULT_NUM_RUNS : configuredRuns,
});

// Automatically unmount and clean up the DOM after each test
afterEach(() => {
  cleanup();
});
import { stretchPasskey } from '../../shared/utils/crypto/argon2';
import { DEFAULT_ARGON2_PARAMS, formatKdfParams, KDF_LIMITS, type Argon2Params } from '../../shared/utils/crypto/kdfParams';

const KIB_PER_MIB = 1024;
const SALT_BYTES = 16;
const MOST_PASSES_TIMED = 4;
const DOUBLE = 2;

// 16, 32, 64 and 128 MiB: doubling from the least memory a bundle may use, short of the most.
const MEMORY_STEPS_KIB = Array.from(
  { length: Math.log2(KDF_LIMITS.m.max / KDF_LIMITS.m.min) },
  (_, doublings) => KDF_LIMITS.m.min * DOUBLE ** doublings
);
const PASS_STEPS = Array.from({ length: MOST_PASSES_TIMED }, (_, i) => KDF_LIMITS.t.min + i);

/**
 * The settings timed, cheapest first: each memory size with 1–4 passes, then the most memory a bundle may ask for,
 * once, to see whether this device can run it at all. Lanes stay at 1: the browser build runs on one thread.
 */
export const BENCHMARK_SETTINGS: readonly Argon2Params[] = [
  ...MEMORY_STEPS_KIB.flatMap((m) => PASS_STEPS.map((t) => ({ m, t, p: KDF_LIMITS.p.min }))),
  { m: KDF_LIMITS.m.max, t: KDF_LIMITS.t.min, p: KDF_LIMITS.p.min },
];

export type BenchmarkResult =
  | { readonly params: Argon2Params; readonly ms: number }
  | { readonly params: Argon2Params; readonly error: string };

/** Times one stretch with `params`, as an upload or unlock would run it (in a worker, where there is one). */
export async function timeArgon2(params: Argon2Params): Promise<BenchmarkResult> {
  const salt = window.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const started = performance.now();
  try {
    await stretchPasskey({ passkey: 'benchmark-passkey', salt, params });
    return { params, ms: Math.round(performance.now() - started) };
  } catch (err: unknown) {
    return { params, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Times every setting in turn, reporting each result as it comes. A first, untimed run loads the WebAssembly, so
 * the first timing isn't mostly download and compile time.
 */
export async function runBenchmark(onResult: (result: BenchmarkResult) => void): Promise<void> {
  await timeArgon2({ m: KDF_LIMITS.m.min, t: KDF_LIMITS.t.min, p: KDF_LIMITS.p.min });
  await BENCHMARK_SETTINGS.reduce(async (previous, params) => {
    await previous;
    onResult(await timeArgon2(params));
  }, Promise.resolve());
}

export const describeParams = ({ m, t, p }: Argon2Params): string =>
  `${m / KIB_PER_MIB} MiB, ${t} pass${t === 1 ? '' : 'es'}, ${p} lane${p === 1 ? '' : 's'}`;

const isDefault = (params: Argon2Params): boolean =>
  formatKdfParams(params) === formatKdfParams(DEFAULT_ARGON2_PARAMS);

export const describeResult = (result: BenchmarkResult): string =>
  `${describeParams(result.params)}${isDefault(result.params) ? ' (current default)' : ''}: ${'ms' in result ? `${result.ms} ms` : `failed (${result.error})`}`;

/** Plain text to paste into the PR or issue: the device, then one line per setting. */
export function benchmarkReport(results: readonly BenchmarkResult[]): string {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const device = [
    `User agent: ${navigator.userAgent}`,
    `CPU threads: ${navigator.hardwareConcurrency || 'unknown'}`,
    `Device memory: ${nav.deviceMemory === undefined ? 'unknown' : `${nav.deviceMemory} GB`}`,
    `In a worker: ${typeof Worker === 'undefined' ? 'no' : 'yes'}`,
  ];
  return [...device, '', ...results.map(describeResult)].join('\n');
}

import { describe, it, expect } from 'vitest';
import { benchmarkReport, BENCHMARK_SETTINGS, describeParams, timeArgon2 } from '../argon2Benchmark';
import { DEFAULT_ARGON2_PARAMS, formatKdfParams, isSupportedKdfParams, KDF_LIMITS } from '../../../shared/utils/crypto/kdfParams';

describe('Argon2 benchmark (#78)', () => {
  it('only times settings a bundle may use, including the current default and the most memory allowed', () => {
    const formatted = BENCHMARK_SETTINGS.map(formatKdfParams);

    expect(formatted.every(isSupportedKdfParams)).toBe(true);
    expect(formatted).toContain(formatKdfParams(DEFAULT_ARGON2_PARAMS));
    expect(BENCHMARK_SETTINGS.map((params) => params.m)).toContain(KDF_LIMITS.m.max);
  });

  it('reports the device, then one line per setting, marking the default', async () => {
    const result = await timeArgon2({ m: KDF_LIMITS.m.min, t: KDF_LIMITS.t.min, p: KDF_LIMITS.p.min });

    const report = benchmarkReport([result, { params: DEFAULT_ARGON2_PARAMS, error: 'out of memory' }]);

    expect(report).toContain('User agent: ');
    // A timed line: matches "16 MiB, 1 pass, 1 lane: 42 ms"; rejects "16 MiB, 1 pass, 1 lane: failed (…)".
    // https://regex101.com/?regex=16%20MiB%2C%201%20pass%2C%201%20lane%3A%20%5Cd%2B%20ms&testString=16%20MiB%2C%201%20pass%2C%201%20lane%3A%2042%20ms
    expect(report).toMatch(/16 MiB, 1 pass, 1 lane: \d+ ms/);
    expect(report).toContain(`${describeParams(DEFAULT_ARGON2_PARAMS)} (current default): failed (out of memory)`);
  });
});

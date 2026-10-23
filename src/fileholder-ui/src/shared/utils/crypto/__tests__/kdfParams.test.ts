import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import {
  DEFAULT_ARGON2_PARAMS,
  formatKdfParams,
  isSupportedKdfParams,
  KDF_LIMITS,
  parseKdfParams,
  UnsupportedKdfParamsError,
} from '../kdfParams';

interface Vectors {
  readonly cases: readonly { readonly value: string; readonly valid: boolean; readonly why: string }[];
}

// Shared with the server's KeyDerivationParamsTests: both must accept and refuse the same settings.
const VECTORS_PATH = resolve(import.meta.dirname, '../../../../../../../tests/vectors/kdf-params.json');
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors;
const MIN_VECTORS = 40;
const MARGIN = 3;
const MEMORY_MARGIN_KIB = 16384;
// Most inputs fall anywhere near a limit; the rest sit right on either side of one.
const NEAR_LIMIT_WEIGHT = 4;

describe('Argon2id settings shared with the server (#78)', () => {
  it('has the vectors', () => {
    // An empty or misplaced file would make the check below pass without checking anything.
    expect(vectors.cases.length).toBeGreaterThan(MIN_VECTORS);
  });

  it('accepts and refuses what the vectors say', () => {
    const mismatches = vectors.cases
      .filter(({ value, valid }) => isSupportedKdfParams(value) !== valid)
      .map(({ value, valid, why }) => `${why}: expected valid = ${valid} for ${JSON.stringify(value)}`);

    expect(mismatches).toEqual([]);
  });

  it('refuses unsupported settings with an UnsupportedKdfParamsError', () => {
    expect(() => parseKdfParams('{"alg":"argon2id","v":19,"m":4194304,"t":3,"p":1}')).toThrow(UnsupportedKdfParamsError);
  });

  it('writes the default settings as the server expects them, within the limits', () => {
    expect(formatKdfParams(DEFAULT_ARGON2_PARAMS)).toBe('{"alg":"argon2id","v":19,"m":65536,"t":3,"p":1}');
    expect(parseKdfParams(formatKdfParams(DEFAULT_ARGON2_PARAMS))).toEqual(DEFAULT_ARGON2_PARAMS);
  });

  const around = (limit: { readonly min: number; readonly max: number }, margin: number): fc.Arbitrary<number> =>
    fc.oneof(
      { weight: NEAR_LIMIT_WEIGHT, arbitrary: fc.integer({ min: limit.min - margin, max: limit.max + margin }) },
      { weight: 1, arbitrary: fc.constantFrom(limit.min - 1, limit.min, limit.max, limit.max + 1) },
    );

  test.prop([around(KDF_LIMITS.m, MEMORY_MARGIN_KIB), around(KDF_LIMITS.t, MARGIN), around(KDF_LIMITS.p, MARGIN)])(
    'accepts formatted settings exactly when every one is within its limits, as the server does',
    (m, t, p) => {
      const withinLimits = [[m, KDF_LIMITS.m], [t, KDF_LIMITS.t], [p, KDF_LIMITS.p]] as const;
      const expected = withinLimits.every(([value, { min, max }]) => value >= min && value <= max);

      expect(isSupportedKdfParams(formatKdfParams({ m, t, p }))).toBe(expected);
    }
  );
});

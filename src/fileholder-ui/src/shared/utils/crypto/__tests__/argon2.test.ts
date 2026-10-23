import { describe, it, expect } from 'vitest';
import { computeArgon2id, stretchPasskey } from '../argon2';
import { KDF_LIMITS } from '../kdfParams';

const HEX_RADIX = 16;
const HEX_DIGITS = 2;
const KIB_64_MIB = 65536;
const ONE_PASS = 1;
const TWO_PASSES = 2;
const FOUR_PASSES = 4;

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(HEX_RADIX).padStart(HEX_DIGITS, '0')).join('');
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Argon2id version 1.3 test vectors from the reference implementation (phc-winner-argon2, src/test.c): 64 MiB, one
 * lane, 32-byte output. RFC 9106's own Argon2id vector also uses a secret and associated data, which hash-wasm's
 * API has no way to pass, so these are the ones a plain password hash can be checked against.
 */
const REFERENCE_VECTORS = [
  { t: TWO_PASSES, password: 'password', salt: 'somesalt', hash: '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7' },
  { t: ONE_PASS, password: 'password', salt: 'somesalt', hash: 'f6a5adc1ba723dddef9b5ac1d464e180fcd9dffc9d1cbf76cca2fed795d9ca98' },
  { t: FOUR_PASSES, password: 'password', salt: 'somesalt', hash: '9025d48e68ef7395cca9079da4c4ec3affb3c8911fe4f86d1a2520856f63172c' },
  { t: TWO_PASSES, password: 'differentpassword', salt: 'somesalt', hash: '0b84d652cf6b0c4beaef0dfe278ba6a80df6696281d7e0d2891b817d8c458fde' },
  { t: TWO_PASSES, password: 'password', salt: 'diffsalt', hash: 'bdf32b05ccc42eb15d58fd19b1f856b113da1e9a5874fdcc544308565aa8141c' },
] as const;

describe('Argon2id (#78)', () => {
  it.each(REFERENCE_VECTORS)('matches the reference implementation for t=$t, "$password", "$salt"', async ({ t, password, salt, hash }) => {
    const result = await computeArgon2id({ passkey: password, salt: utf8(salt), params: { m: KIB_64_MIB, t, p: 1 } });

    expect(hex(result)).toBe(hash);
  });

  it('gives the same result through stretchPasskey (here without a worker, as in any test)', async () => {
    const { t, password, salt, hash } = REFERENCE_VECTORS[0];

    const result = await stretchPasskey({ passkey: password, salt: utf8(salt), params: { m: KIB_64_MIB, t, p: 1 } });

    expect(hex(result)).toBe(hash);
  });

  it('stretches a passkey the same however its accented letters are composed', async () => {
    const params = { m: KDF_LIMITS.m.min, t: ONE_PASS, p: 1 };
    const salt = utf8('somesalt');

    // "café" with "é" as one character, and as "e" followed by a combining accent.
    const composed = await computeArgon2id({ passkey: 'caf\u00e9', salt, params });
    const decomposed = await computeArgon2id({ passkey: 'cafe\u0301', salt, params });

    expect(hex(decomposed)).toBe(hex(composed));
  });
});

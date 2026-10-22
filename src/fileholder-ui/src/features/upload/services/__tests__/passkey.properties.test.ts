// Plain tests use Vitest's `it`: fast-check's `test` runs its body as a property, many times over.
import { describe, expect, it, vi } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { generateReadablePasskey, PASSKEY_CHARSET } from '../passkey';

// Three groups of four passkey characters: "K7QF-2MXA-9RTB" matches; "K7QF-2MXA" and "k7qf-2mxa-9rtb" don't.
// https://regex101.com/?regex=%5E%5BA-Z1-9%5D%7B4%7D-%5BA-Z1-9%5D%7B4%7D-%5BA-Z1-9%5D%7B4%7D%24&flags=gm&testString=K7QF-2MXA-9RTB%0AK7QF-2MXA%0Ak7qf-2mxa-9rtb
const PASSKEY_SHAPE = /^[A-Z1-9]{4}-[A-Z1-9]{4}-[A-Z1-9]{4}$/;

const PASSKEYS = 20_000;
// For 34 degrees of freedom (35 characters), a fair generator exceeds chi-squared 90 by chance only about once in a
// million runs; plain "byte % 35" without skipping bytes from 245 up (#48) gives about 970 here.
const CHI_SQUARED_THRESHOLD = 90;

const BYTE_VALUES = 256;
const CHARSET_SIZE = PASSKEY_CHARSET.length;
// 245: from here up, "byte % 35" would land on the first 11 characters one extra time.
const FIRST_SKIPPED_BYTE = Math.floor(BYTE_VALUES / CHARSET_SIZE) * CHARSET_SIZE;
const byteFor = (char: string): number => PASSKEY_CHARSET.indexOf(char);

// Random bytes, 4 per draw. 255 and 245 are skipped, so the first group needs a second draw; 244 and 70 are kept
// (244 % 35 = 34 → "9", 70 % 35 = 0 → "A"), and the second draw's last two bytes aren't needed.
const RANDOM_DRAWS: readonly (readonly number[])[] = [
    [BYTE_VALUES - 1, byteFor('A'), FIRST_SKIPPED_BYTE, byteFor('9')],
    [FIRST_SKIPPED_BYTE - 1, byteFor('A') + CHARSET_SIZE + CHARSET_SIZE, byteFor('B'), byteFor('C')],
    Array.from('DEFG', byteFor),
    Array.from('HIJK', byteFor),
];
const PASSKEY_FROM_DRAWS = 'A99A-DEFG-HIJK';

describe('generateReadablePasskey', () => {
    // Nothing to vary: each run is a fresh passkey, and the property is that every one has the right shape.
    test.prop([fc.constant(null)])('gives three groups of four passkey characters', () => {
        expect(generateReadablePasskey()).toMatch(PASSKEY_SHAPE);
    });

    it('skips random bytes from 245 up, which would favour the first 11 characters', () => {
        const draws = [...RANDOM_DRAWS];
        const spy = vi.spyOn(window.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
            (array as Uint8Array).set(draws.shift() ?? []);
            return array;
        });
        try {
            expect(generateReadablePasskey()).toBe(PASSKEY_FROM_DRAWS);
        } finally {
            spy.mockRestore();
        }
    });

    it('favours no character', () => {
        const counts = new Map<string, number>(Array.from(PASSKEY_CHARSET, (char) => [char, 0]));
        Array.from({ length: PASSKEYS }, generateReadablePasskey).forEach((passkey) => {
            Array.from(passkey.replaceAll('-', '')).forEach((char) => counts.set(char, (counts.get(char) ?? 0) + 1));
        });
        const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
        const expected = total / PASSKEY_CHARSET.length;
        const chiSquared = Array.from(counts.values()).reduce((sum, observed) => {
            const deviation = observed - expected;
            return sum + (deviation * deviation) / expected;
        }, 0);

        expect(chiSquared).toBeLessThan(CHI_SQUARED_THRESHOLD);
    });
});

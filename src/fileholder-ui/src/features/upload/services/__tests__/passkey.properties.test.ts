import { describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { generateReadablePasskey, PASSKEY_CHARSET } from '../passkey';

// Three groups of four passkey characters: "K7QF-2MXA-9RTB" matches; "K7QF-2MXA" and "k7qf-2mxa-9rtb" don't.
// https://regex101.com/?regex=%5E%5BA-Z1-9%5D%7B4%7D-%5BA-Z1-9%5D%7B4%7D-%5BA-Z1-9%5D%7B4%7D%24&flags=gm&testString=K7QF-2MXA-9RTB%0AK7QF-2MXA%0Ak7qf-2mxa-9rtb
const PASSKEY_SHAPE = /^[A-Z1-9]{4}-[A-Z1-9]{4}-[A-Z1-9]{4}$/;

const PASSKEYS = 20_000;
// For 34 degrees of freedom (35 characters), a fair generator exceeds chi-squared 90 by chance only about once in a
// million runs; "byte % 35" (#48) gives about 970 here.
const CHI_SQUARED_THRESHOLD = 90;

describe('generateReadablePasskey', () => {
    // Nothing to vary: each run is a fresh passkey, and the property is that every one has the right shape.
    test.prop([fc.constant(null)])('gives three groups of four passkey characters', () => {
        expect(generateReadablePasskey()).toMatch(PASSKEY_SHAPE);
    });

    // Expected to fail until #48 (modulo bias) is fixed: then this starts passing, Vitest reports it, and the
    // "fails" goes.
    test.fails('favours no character', () => {
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

// Plain tests use Vitest's `it`: fast-check's `test` runs its body as a property, many times over.
import { describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import {
    generateReadablePasskey,
    MIN_PASSKEY_LENGTH,
    PASSKEY_REQUIRED_MESSAGE,
    PASSKEY_TOO_SHORT_MESSAGE,
    passkeyProblem,
} from '../passkey';

// One character short of the minimum.
const ONE_TOO_FEW = 'a'.repeat(MIN_PASSKEY_LENGTH - 1);

describe('passkeyProblem (#78)', () => {
    it.each([undefined, '', '   '])('asks for a passkey when there is none (%j)', (passkey) => {
        expect(passkeyProblem(passkey)).toBe(PASSKEY_REQUIRED_MESSAGE);
    });

    it(`refuses fewer than ${MIN_PASSKEY_LENGTH} characters, and accepts ${MIN_PASSKEY_LENGTH}`, () => {
        expect(passkeyProblem(ONE_TOO_FEW)).toBe(PASSKEY_TOO_SHORT_MESSAGE);
        expect(passkeyProblem('a'.repeat(MIN_PASSKEY_LENGTH))).toBeNull();
    });

    it('does not count spaces at either end', () => {
        expect(passkeyProblem(`  ${ONE_TOO_FEW}  `)).toBe(PASSKEY_TOO_SHORT_MESSAGE);
    });

    it('counts an accented letter once, however it was typed', () => {
        // Nine characters ending in "é". Typed as "e" plus a combining accent, the string is ten units long, but the
        // recipient still types nine characters.
        const composed = `${ONE_TOO_FEW.slice(1)}é`;
        const decomposed = composed.normalize('NFD');
        expect(decomposed.length).toBe(MIN_PASSKEY_LENGTH);

        expect(passkeyProblem(decomposed)).toBe(PASSKEY_TOO_SHORT_MESSAGE);
    });

    it('counts a character outside the Basic Multilingual Plane once', () => {
        // "😀" is two UTF-16 units but one character to type.
        expect(passkeyProblem(`${ONE_TOO_FEW.slice(1)}😀`)).toBe(PASSKEY_TOO_SHORT_MESSAGE);
    });

    // Nothing to vary: each run is a fresh passkey, and the property is that every one is accepted.
    test.prop([fc.constant(null)])('accepts every generated passkey', () => {
        expect(passkeyProblem(generateReadablePasskey())).toBeNull();
    });
});

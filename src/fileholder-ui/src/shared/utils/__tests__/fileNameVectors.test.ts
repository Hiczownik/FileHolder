import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { isExtensionForbidden, makeFileNamesUnique, sanitizeFileName } from '../fileNameSafety';
import { blockedFileName, collidingNames, fileName, show } from '../../../test/arbitraries';

/**
 * tests/vectors/file-names.json holds names and what the file-name rules make of them. This test checks the browser's
 * copy against it and FileNameVectorTests checks the server's, so the two can't drift apart. The inputs come from a
 * fixed seed; to regenerate the file after changing the rules (in both copies), run from src/fileholder-ui:
 *   PowerShell: $env:UPDATE_VECTORS='1'; npx vitest run fileNameVectors; Remove-Item Env:UPDATE_VECTORS
 *   bash:       UPDATE_VECTORS=1 npx vitest run fileNameVectors
 * and commit it. Hand-added entries are fine too; regenerating keeps only HAND_PICKED and the seeded ones.
 */

const VECTORS_PATH = resolve(import.meta.dirname, '../../../../../../tests/vectors/file-names.json');
const VECTORS_SEED = 1734120533;
const RANDOM_NAMES = 250;
const BLOCKED_NAMES = 80;
const NAME_LISTS = 40;
const CASE_LISTS = 60;
const MAX_CASE_LIST = 6;
const UPDATING = process.env.UPDATE_VECTORS === '1';
// Lists of at least two names, so there's something to collide; long names to hit the length caps.
const MIN_LIST = 2;
const MAX_LETTERS = 2;
const EMOJI_BODY = 100;
const LONG_BODY = 300;
const LONG_EXTENSION = 100;

/** Names that have broken one copy or the other before, kept whatever the seed gives. */
const HAND_PICKED: readonly string[] = [
    'evil.bat..', 'evil.exe. .', 'C:\\Users\\x\\evil.bat', '../../Startup/x.bat', 'a.\u001C', '..\u001C_.x$', '.', '..',
    '   ', '', '.env', 'zażółć gęślą jaźń.txt', 'report\u202Etxt.exe', 'a\uD800b.txt', '\uDC00.pdf', '😀.png',
    `${'😀'.repeat(EMOJI_BODY)}.txt`, `${'a'.repeat(LONG_BODY)}.${'b'.repeat(LONG_EXTENSION)}`,
];

/**
 * Letters whose upper and lower case are easy to get wrong: ß and ẞ, the three sigmas, dotless and dotted i, long s,
 * the Kelvin, Ohm and Angstrom signs, titlecase ǅ, the ﬀ ligature, micro sign, Greek with a subscript iota (whose full
 * uppercase is two letters), Cherokee and Deseret (outside the BMP).
 */
const TRICKY_LETTERS: readonly string[] = [
    'ß', 'ẞ', 'ς', 'σ', 'Σ', 'ı', 'I', 'i', 'İ', 'ſ', 's', 'S', 'ǅ', 'ǆ', 'Ǆ', 'ﬀ', '\u212A', 'k', 'K', '\u2126', 'ω',
    '\u212B', 'å', 'µ', 'μ', 'ᾀ', 'ᾈ', 'ῳ', 'ῼ', 'ᾳ', 'ᾼ', 'ŉ', 'ǰ', 'ΐ', 'ꭰ', 'Ꭰ', '𐐨', '𐐀',
];

/** Lists of one- or two-letter names from TRICKY_LETTERS, which collide often if the rules fold case the same way. */
const caseNames: fc.Arbitrary<string[]> = fc.array(
    fc.tuple(fc.array(fc.constantFrom(...TRICKY_LETTERS), { minLength: 1, maxLength: MAX_LETTERS }), fc.constantFrom('', '.txt', '.TXT'))
        .map(([letters, extension]) => `${letters.join('')}${extension}`),
    { minLength: MIN_LIST, maxLength: MAX_CASE_LIST },
);

// Matches half a character: a high surrogate not followed by a low one, or a low one not after a high one.
// "a\uD800b" matches; "a😀b" (an emoji, a whole pair) doesn't.
// https://regex101.com/?regex=%5B%5CuD800-%5CuDBFF%5D(%3F!%5B%5CuDC00-%5CuDFFF%5D)%7C(%3F%3C!%5B%5CuD800-%5CuDBFF%5D)%5B%5CuDC00-%5CuDFFF%5D&testString=a%F0%9F%98%80b
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const HEX_RADIX = 16;
const HEX_DIGITS = 4;

/**
 * A name as the file stores it. JSON can carry half a character only as an escape, which .NET's reader refuses, so
 * such names are written as their UTF-16 units instead: "a\uD800" is { nameUtf16: "0061 D800" }.
 */
type StoredName = { readonly name: string } | { readonly nameUtf16: string };

interface NameVector {
    readonly input: StoredName;
    readonly sanitized: string;
    readonly forbidden: boolean;
}

interface ListVector {
    readonly names: readonly string[];
    readonly unique: readonly string[];
}

interface Vectors {
    readonly comment: string;
    readonly seed: number;
    readonly names: readonly NameVector[];
    readonly lists: readonly ListVector[];
}

const store = (name: string): StoredName =>
    LONE_SURROGATE.test(name)
        ? { nameUtf16: name.split('').map((unit) => unit.charCodeAt(0).toString(HEX_RADIX).toUpperCase().padStart(HEX_DIGITS, '0')).join(' ') }
        : { name };

const load = (stored: StoredName): string =>
    'name' in stored
        ? stored.name
        : String.fromCharCode(...stored.nameUtf16.split(' ').map((unit) => Number.parseInt(unit, HEX_RADIX)));

const sample = <T,>(arbitrary: fc.Arbitrary<T>, count: number): T[] => fc.sample(arbitrary, { seed: VECTORS_SEED, numRuns: count });

const generate = (): Vectors => {
    const inputs = [...HAND_PICKED, ...sample(fileName, RANDOM_NAMES), ...sample(blockedFileName, BLOCKED_NAMES)];
    // Lists are of names as stored, which is what the rules make unique.
    const sanitizedLists = sample(fc.array(fileName, { minLength: MIN_LIST, maxLength: MAX_CASE_LIST }), NAME_LISTS)
        .map((names) => names.map(sanitizeFileName));
    const lists = [...sample(collidingNames, NAME_LISTS), ...sample(caseNames, CASE_LISTS), ...sanitizedLists];

    return {
        comment: 'Generated by src/fileholder-ui/src/shared/utils/__tests__/fileNameVectors.test.ts; checked by it and by FileNameVectorTests.',
        seed: VECTORS_SEED,
        names: inputs.map((input) => ({ input: store(input), sanitized: sanitizeFileName(input), forbidden: isExtensionForbidden(input) })),
        lists: lists.map((names) => ({ names, unique: makeFileNamesUnique(names) })),
    };
};

const JSON_INDENT = 2;

describe('file-name vectors shared with the server', () => {
    test.runIf(UPDATING)('regenerates tests/vectors/file-names.json', () => {
        writeFileSync(VECTORS_PATH, `${JSON.stringify(generate(), null, JSON_INDENT)}\n`, 'utf8');
    });

    const vectors: Vectors = UPDATING ? generate() : (JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors);

    test('sanitizeFileName and isExtensionForbidden give what the vectors say', () => {
        vectors.names.forEach(({ input, sanitized, forbidden }) => {
            const name = load(input);
            expect(sanitizeFileName(name), show(name)).toBe(sanitized);
            expect(isExtensionForbidden(name), show(name)).toBe(forbidden);
        });
    });

    test('makeFileNamesUnique gives what the vectors say', () => {
        vectors.lists.forEach(({ names, unique }) => {
            expect(makeFileNamesUnique(names), names.map(show).join(', ')).toEqual(unique);
        });
    });
});

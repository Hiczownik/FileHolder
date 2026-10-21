import fc from 'fast-check';

/**
 * Inputs for the property tests: the kinds of names that have broken things before. The same mix as the server's
 * generators (tests/FileHolder.Tests.Unit/Properties/Generators.cs), so both copies of the rules see similar input.
 */

/** The server's blocked extensions (FileSecurityUtils.ForbiddenExtensions). */
export const BLOCKED_EXTENSIONS = [
    '.exe', '.bat', '.sh', '.cmd', '.dll', '.ps1', '.vbs', '.js', '.scr', '.pif', '.application', '.msi', '.com',
    '.hta', '.jar', '.lnk', '.msc', '.vbe', '.wsf', '.cpl', '.reg', '.iso',
] as const;

// How often each kind of piece comes up, relative to the others.
const RARELY = 1;
const SOMETIMES = 2;
const OCCASIONALLY = 3;
const OFTEN = 4;
const VERY_OFTEN = 6;
const MOSTLY = 10;
const ALMOST_ALWAYS = 30;

const codePointOf = (char: string): number => char.codePointAt(0) ?? 0;

/** Any one code point from `first` to `last`, both given as characters. */
const range = (first: string, last: string): fc.Arbitrary<string> =>
    fc.integer({ min: codePointOf(first), max: codePointOf(last) }).map((codePoint) => String.fromCodePoint(codePoint));

/** Any one UTF-16 unit from `first` to `last`, so lone surrogates can be had too. */
const units = (first: string, last: string): fc.Arbitrary<string> =>
    fc.integer({ min: first.charCodeAt(0), max: last.charCodeAt(0) }).map((unit) => String.fromCharCode(unit));

/** One character (or short run) of a name, weighted towards what has caused trouble. */
export const piece: fc.Arbitrary<string> = fc.oneof(
    { weight: ALMOST_ALWAYS, arbitrary: range(' ', '~') },                          // printable ASCII
    { weight: MOSTLY, arbitrary: fc.constantFrom('.', ' ', '..', '. ', ' .', '...') }, // runs of dots and spaces
    { weight: VERY_OFTEN, arbitrary: fc.constantFrom('/', '\\', 'C:\\', '../', '..\\', '//') }, // paths
    { weight: VERY_OFTEN, arbitrary: range('\u00C0', '\u024F') },                  // accented Latin
    { weight: OFTEN, arbitrary: range('\u0400', '\u04FF') },                       // Cyrillic
    { weight: OFTEN, arbitrary: range('\u0900', '\u097F') },                       // Devanagari, spacing vowel signs (Mc)
    { weight: OFTEN, arbitrary: range('\u0590', '\u06FF') },                       // Hebrew and Arabic (right to left)
    { weight: OFTEN, arbitrary: range('\u4E00', '\u9FFF') },                       // CJK
    { weight: OFTEN, arbitrary: range('\u0300', '\u036F') },                       // combining marks
    { weight: SOMETIMES, arbitrary: range('\u20D0', '\u20F0') },                   // enclosing marks (Me)
    { weight: OCCASIONALLY, arbitrary: fc.constantFrom('\u200B', '\u200C', '\u200D', '\uFEFF', '\u202E') }, // zero-width, BOM, RLO
    { weight: OCCASIONALLY, arbitrary: units('\u0000', '\u001F') },                // control characters, CR, LF, tab
    { weight: RARELY, arbitrary: fc.constant('\u007F') },
    { weight: OFTEN, arbitrary: range('\u{1F300}', '\u{1FAFF}') },                 // emoji (surrogate pairs)
    { weight: SOMETIMES, arbitrary: range('\u{20000}', '\u{2A6DF}') },             // letters outside the BMP
    { weight: RARELY, arbitrary: units('\uD800', '\uDFFF') },                      // lone surrogates
);

const LONG_NAME_PIECES = 2000;
const shortText = fc.array(piece).map((pieces) => pieces.join(''));

/** Any name: short, very long (up to 2,000 pieces), or a body and an extension. */
export const fileName: fc.Arbitrary<string> = fc.oneof(
    { weight: VERY_OFTEN, arbitrary: shortText },
    { weight: RARELY, arbitrary: fc.array(piece, { maxLength: LONG_NAME_PIECES }).map((pieces) => pieces.join('')) },
    { weight: OFTEN, arbitrary: fc.tuple(shortText, shortText).map(([body, extension]) => `${body}.${extension}`) },
);

const SAFE_NAME_MAX = 50;
const SAFE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

/** Names that are already safe: [A-Za-z0-9_-]{1,50} plus ".pdf". */
export const safeFileName: fc.Arbitrary<string> =
    fc.string({ unit: fc.constantFrom(...SAFE_CHARS), minLength: 1, maxLength: SAFE_NAME_MAX }).map((body) => `${body}.pdf`);

/** Characters sanitizing removes from an extension: none is a letter, mark, digit, "_", "-" or ".". */
const removableJunk = fc.constantFrom(' ', '\t', '#', '!', '(', ')', '\u200B', '\u00A0', '\r', '\n', '%', '$');

const randomCase = (text: string): fc.Arbitrary<string> =>
    fc.array(fc.boolean(), { minLength: text.length, maxLength: text.length })
        .map((upper) => Array.from(text, (char, index) => (upper[index] ? char.toUpperCase() : char)).join(''));

/**
 * A blocked extension in random case with junk inside it that sanitizing removes ("e x#e"), then trailing dots and
 * spaces that Windows drops on saving ("evil.exe. ."), after any body.
 */
export const blockedFileName: fc.Arbitrary<string> = fc
    .tuple(fileName, fc.constantFrom(...BLOCKED_EXTENSIONS).chain(randomCase), fc.array(fc.constantFrom('.', ' ')))
    .chain(([body, extension, trailing]) =>
        fc.tuple(...Array.from(extension.slice(1), (char) =>
            fc.oneof(
                { weight: OCCASIONALLY, arbitrary: fc.constant(char) },
                { weight: RARELY, arbitrary: removableJunk.map((junk) => junk + char) })))
            .map((letters) => `${body}.${letters.join('')}${trailing.join('')}`));

const LONGEST_BODY = 190;
const LONGEST_EXTENSION = 63;

/**
 * Lists of names that collide a lot, ignoring case, including names that already look like numbered copies and
 * names as long as sanitizing allows.
 */
export const collidingNames: fc.Arbitrary<string[]> = fc.array(fc.constantFrom(
    'a.txt', 'A.txt', 'a (2).txt', 'A (3).TXT', 'b', 'B', 'notes.pdf', 'NOTES.PDF', 'x.tar.gz', 'X.TAR.GZ', 'unnamed_file',
    `${'a'.repeat(LONGEST_BODY)}.${'b'.repeat(LONGEST_EXTENSION)}`, `${'A'.repeat(LONGEST_BODY)}.${'B'.repeat(LONGEST_EXTENSION)}`,
));

const HEX_RADIX = 16;
const ESCAPE_DIGITS = 4;

/** A name with everything outside printable ASCII escaped as \uXXXX, for failure messages. */
export const show = (text: string): string =>
    `"${text.split('').map((unit) => (unit >= ' ' && unit <= '~' && unit !== '"' && unit !== '\\'
        ? unit
        : `\\u${unit.charCodeAt(0).toString(HEX_RADIX).padStart(ESCAPE_DIGITS, '0')}`)).join('')}"`;

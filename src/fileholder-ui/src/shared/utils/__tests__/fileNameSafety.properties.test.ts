import { describe, expect } from 'vitest';
import { test } from '@fast-check/vitest';
import { isExtensionForbidden, makeFileNamesUnique, sanitizeFileName } from '../fileNameSafety';
import { BLOCKED_EXTENSIONS, blockedFileName, collidingNames, fileName, safeFileName, show } from '../../../test/arbitraries';

/**
 * Rules fileNameSafety must keep for any name; the same rules the server's FileSecurityUtilsProperties check, since
 * both copies must give the same answers. The examples in fileNameSafety.test.ts pin past bugs.
 */

const MAX_STORED_LENGTH = 255; // the server's varchar(255) FileName column

// Matches a name made only of dots, like "..", but not "a.b".
// https://regex101.com/?regex=%5E%5C.%2B%24&flags=gm&testString=..%0Aa.b
const DOTS_ONLY = /^\.+$/;

const LAST_C0_CONTROL = 0x1f;
const DEL = 0x7f;

/** Whether the text holds a C0 control character or DEL, like "\t" or "\u007F". */
const hasControlCharacter = (text: string): boolean =>
    Array.from(text).some((char) => {
        const codePoint = char.codePointAt(0) ?? 0;
        return codePoint <= LAST_C0_CONTROL || codePoint === DEL;
    });

// Matches half a character: a high surrogate not followed by a low one, or a low one not after a high one.
// "a\uD800b" matches; "a😀b" (an emoji, a whole pair) doesn't.
// https://regex101.com/?regex=%5B%5CuD800-%5CuDBFF%5D(%3F!%5B%5CuDC00-%5CuDFFF%5D)%7C(%3F%3C!%5B%5CuD800-%5CuDBFF%5D)%5B%5CuDC00-%5CuDFFF%5D&testString=a%F0%9F%98%80b
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether every surrogate is part of a pair: the server's database can't store half a character. */
const isWellFormed = (text: string): boolean => !LONE_SURROGATE.test(text);

// Matches the trailing dots and spaces Windows drops on saving: in "a.exe. ." the final ". ." matches; "a.pdf" has none.
// https://regex101.com/?regex=%5B.%20%5D%2B%24&flags=gm&testString=a.exe.%20.%0Aa.pdf
const TRAILING_DOTS_AND_SPACES = /[. ]+$/u;

const FIRST_COPY_NUMBER = 2;

const caseKey = (text: string): string => text.toUpperCase();

describe('sanitizeFileName', () => {
    test.prop([fileName])('gives a storable name: not empty or dots only, at most 255 characters, no half characters', (name) => {
        const sanitized = sanitizeFileName(name);
        expect(sanitized.length > 0 && !DOTS_ONLY.test(sanitized), `${show(name)} -> ${show(sanitized)}`).toBe(true);
        expect(sanitized.length, show(name)).toBeLessThanOrEqual(MAX_STORED_LENGTH);
        expect(isWellFormed(sanitized), `${show(name)} -> ${show(sanitized)}`).toBe(true);
    });

    test.prop([fileName])('gives a single path segment without control characters', (name) => {
        const sanitized = sanitizeFileName(name);
        expect(sanitized.includes('/') || sanitized.includes('\\') || hasControlCharacter(sanitized), `${show(name)} -> ${show(sanitized)}`).toBe(false);
    });

    test.prop([fileName])('never ends in a dot or space, which Windows drops on saving', (name) => {
        const sanitized = sanitizeFileName(name);
        expect(sanitized.endsWith('.') || sanitized.endsWith(' '), `${show(name)} -> ${show(sanitized)}`).toBe(false);
    });

    test.prop([fileName])('is idempotent', (name) => {
        const once = sanitizeFileName(name);
        expect(sanitizeFileName(once), `${show(name)} -> ${show(once)}`).toBe(once);
    });

    test.prop([safeFileName])('leaves safe names unchanged', (name) => {
        expect(sanitizeFileName(name)).toBe(name);
    });
});

describe('isExtensionForbidden', () => {
    test.prop([blockedFileName])('catches blocked extensions, whatever is added that saving removes', (name) => {
        expect(isExtensionForbidden(name), `${show(name)} stored as ${show(sanitizeFileName(name))}`).toBe(true);
    });

    test.prop([fileName])('is true whenever the name as saved has a blocked extension', (name) => {
        // What Windows writes to disk: the stored name without trailing dots and spaces.
        const onDisk = sanitizeFileName(name).replace(TRAILING_DOTS_AND_SPACES, '');
        const dot = onDisk.lastIndexOf('.');
        const extension = dot < 0 ? '' : onDisk.slice(dot);
        const blocked = BLOCKED_EXTENSIONS.some((blockedExtension) => caseKey(blockedExtension) === caseKey(extension));
        expect(!blocked || isExtensionForbidden(name), `${show(name)} saved as ${show(onDisk)}`).toBe(true);
    });
});

/** "a.txt" itself, or "a (n).txt" (its body may be shortened to make room for the number). */
const isNameOrNumberedCopy = (candidate: string, original: string): boolean => {
    if (candidate === original) return true;
    const dot = original.lastIndexOf('.');
    const extension = dot <= 0 ? '' : original.slice(dot);
    const body = original.slice(0, original.length - extension.length);
    if (!candidate.endsWith(extension)) return false;
    const withoutExtension = candidate.slice(0, candidate.length - extension.length);
    const open = withoutExtension.lastIndexOf(' (');
    const copy = Number(withoutExtension.slice(open + ' ('.length, -')'.length));
    return open >= 0 && withoutExtension.endsWith(')') && Number.isInteger(copy) && copy >= FIRST_COPY_NUMBER && body.startsWith(withoutExtension.slice(0, open));
};

describe('makeFileNamesUnique', () => {
    test.prop([collidingNames])('gives names unique ignoring case, each its own name or a numbered copy of it', (names) => {
        const unique = makeFileNamesUnique(names);
        expect(unique).toHaveLength(names.length);
        expect(new Set(unique.map(caseKey)).size).toBe(unique.length);
        expect(unique.every((name, index) => isNameOrNumberedCopy(name, names[index]))).toBe(true);
    });

    test.prop([collidingNames])('leaves lists that are already unique unchanged', (names) => {
        const alreadyUnique = names.filter((name, index) => names.findIndex((other) => caseKey(other) === caseKey(name)) === index);
        expect(makeFileNamesUnique(alreadyUnique)).toEqual(alreadyUnique);
    });

    test.prop([collidingNames])('keeps every name storable', (names) => {
        makeFileNamesUnique(names).forEach((name) => {
            expect(name.length).toBeLessThanOrEqual(MAX_STORED_LENGTH);
            expect(DOTS_ONLY.test(name) || name.endsWith('.') || name.endsWith(' '), show(name)).toBe(false);
        });
    });
});

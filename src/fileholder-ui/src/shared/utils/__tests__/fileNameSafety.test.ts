import { describe, it, expect } from 'vitest';
import { isExtensionForbidden, makeFileNamesUnique, sanitizeFileName } from '../fileNameSafety';

describe('sanitizeFileName', () => {
    it.each([
        ['../../AppData/Roaming/Startup/x.txt', 'x.txt'],
        ['..\\..\\Windows\\x.txt', 'x.txt'],
        ['C:\\Users\\me\\report.pdf', 'report.pdf'],
        ['/etc/passwd', 'passwd'],
    ])('keeps only the last path segment of %s', (input, expected) => {
        expect(sanitizeFileName(input)).toBe(expected);
    });

    it('replaces characters the server would replace, but keeps Unicode letters', () => {
        expect(sanitizeFileName('zażółć report?.txt')).toBe('zażółć_report_.txt');
    });

    it.each([
        ['', 'unnamed_file'],
        ['   ', 'unnamed_file'],
        ['..', 'unnamed_file'],
        ['.', 'unnamed_file'],
        ['dir/', 'unnamed_file'],
        ['...', 'unnamed_file'],
        ['. . .', 'unnamed_file'],
        ['.env', 'unnamed_file.env'],
    ])('falls back to a safe name for %j', (input, expected) => {
        expect(sanitizeFileName(input)).toBe(expected);
    });

    it('caps the name body at 190 characters and keeps the extension', () => {
        const maxBodyLength = 190;
        const overlongBodyLength = 300;
        const sanitized = sanitizeFileName(`${'a'.repeat(overlongBodyLength)}.txt`);
        expect(sanitized).toBe(`${'a'.repeat(maxBodyLength)}.txt`);
    });
});

describe('sanitizeFileName length', () => {
    const maxStoredLength = 255;

    it('caps the extension at 64 characters, as the server does', () => {
        const extensionLength = 254;
        const cappedExtensionLength = 63;
        expect(sanitizeFileName(`.${'a'.repeat(extensionLength)}`)).toBe(`unnamed_file.${'a'.repeat(cappedExtensionLength)}`);
    });

    // Each is exactly the 255 characters the server's validation lets through.
    const overlongBodyLength = 200;
    const restAfterBody = maxStoredLength - overlongBodyLength - 1;
    const restAfterOneChar = maxStoredLength - 'a.'.length;

    // Matches a name made only of dots, like "." or "..", but not "a.b" or ".env".
    // https://regex101.com/?regex=%5E%5C.%2B%24&flags=gm&testString=.%0A..%0Aa.b%0A.env
    const dotsOnly = /^\.+$/;

    it.each([
        `.${'a'.repeat(maxStoredLength - 1)}`,
        `${'a'.repeat(overlongBodyLength)}.${'b'.repeat(restAfterBody)}`,
        `a.${'b'.repeat(restAfterOneChar)}`,
        '.'.repeat(maxStoredLength),
    ])("keeps %j within the server's 255-character column", (input) => {
        const sanitized = sanitizeFileName(input);
        expect(sanitized.length).toBeLessThanOrEqual(maxStoredLength);
        expect(sanitized).not.toMatch(dotsOnly);
    });
});

describe('sanitizeFileName with trailing dots and spaces', () => {
    it.each([
        ['report.pdf.', 'report.pdf'],
        ['report.pdf . ', 'report.pdf'],
        ['notes...', 'notes'],
    ])('saves %j as Windows would, as %j', (input, expected) => {
        expect(sanitizeFileName(input)).toBe(expected);
    });
});

describe('isExtensionForbidden', () => {
    // Windows drops trailing dots and spaces on saving, so "invoice.exe." lands as "invoice.exe".
    it.each(['evil.exe', 'EVIL.EXE', 'evil.exe ', 'evil.e x e', 'dir/run.ps1', 'archive.tar.bat', 'setup.msi',
        'invoice.exe.', 'invoice.exe. .', 'invoice.exe . ', 'run.bat...'])(
        'blocks %j',
        (name) => {
            expect(isExtensionForbidden(name)).toBe(true);
        }
    );

    it.each(['report.pdf', 'photo.jpeg', 'notes', 'exe', 'script.json', 'shell.sh.txt'])('allows %j', (name) => {
        expect(isExtensionForbidden(name)).toBe(false);
    });
});

describe('makeFileNamesUnique', () => {
    it('numbers duplicates, ignoring case, and leaves unique names alone', () => {
        expect(makeFileNamesUnique(['a.txt', 'A.txt', 'a.txt', 'b.txt'])).toEqual(['a.txt', 'A (2).txt', 'a (3).txt', 'b.txt']);
    });

    it('skips a copy number another file already uses', () => {
        expect(makeFileNamesUnique(['a.txt', 'a (2).txt', 'a.txt'])).toEqual(['a.txt', 'a (2).txt', 'a (3).txt']);
    });

    // Found by the vectors shared with the server (#70): "ᾀ" upper-cases to two letters in JavaScript, so it was kept
    // apart from "ᾈ", which NTFS and the server treat as the same letter.
    it('folds case as the server does, also where the full upper case is two letters', () => {
        expect(makeFileNamesUnique(['ᾈ.txt', 'ᾀ.txt', 'ß.txt', 'ss.txt'])).toEqual(['ᾈ.txt', 'ᾀ (2).txt', 'ß.txt', 'ss.txt']);
    });
});

// Brought in line with the server's SanitizeFileName after its property tests (#70) found these there.
describe('sanitizeFileName, same as the server', () => {
    const BODY_LIMIT = 190;
    const BEFORE_LIMIT = BODY_LIMIT - 1;
    const LONGEST_EXTENSION = 63;
    const MAX_STORED_LENGTH = 255;

    it('drops trailing dots left once characters are removed', () => {
        // The control character goes from the extension, which would leave "Ŋॐ.".
        expect(sanitizeFileName('Ŋॐ.\u001C')).toBe('Ŋॐ');
    });

    it('is stable when removing characters moves the extension', () => {
        // One pass gives "._", whose own extension is the whole name.
        const sanitized = sanitizeFileName('. . $');

        expect(sanitized).toBe('unnamed_file._');
        expect(sanitizeFileName(sanitized)).toBe(sanitized);
    });

    it('replaces an emoji with one "_", and half a character with "_"', () => {
        expect(sanitizeFileName('a\u{1F600}b.txt')).toBe('a_b.txt');
        expect(sanitizeFileName('a\uD800b.txt')).toBe('a_b.txt');
    });

    it('never cuts a character in half at the length limit', () => {
        const body = `${'a'.repeat(BEFORE_LIMIT)}\u{20000}bbb`;

        expect(sanitizeFileName(`${body}.txt`)).toBe(`${'a'.repeat(BEFORE_LIMIT)}.txt`);
    });

    it('turns a name of only whitespace into "_", as the server does', () => {
        expect(sanitizeFileName('\t')).toBe('_');
        expect(sanitizeFileName('   ')).toBe('unnamed_file');
    });

    it('shortens a maximum-length name to fit its copy number', () => {
        const longest = `${'a'.repeat(BODY_LIMIT)}.${'b'.repeat(LONGEST_EXTENSION)}`;

        const [, copy] = makeFileNamesUnique([longest, longest.toUpperCase()]);

        expect(copy).toHaveLength(MAX_STORED_LENGTH);
        expect(copy.endsWith(` (2).${'B'.repeat(LONGEST_EXTENSION)}`)).toBe(true);
    });
});

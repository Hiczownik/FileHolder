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

describe('isExtensionForbidden', () => {
    it.each(['evil.exe', 'EVIL.EXE', 'evil.exe ', 'evil.e x e', 'dir/run.ps1', 'archive.tar.bat', 'setup.msi'])(
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
});

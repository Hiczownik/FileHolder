import { describe, it, expect } from 'vitest';
import { attachmentDisposition } from '../contentDisposition';

describe('attachmentDisposition', () => {
    it('leaves a plain ASCII name as it is', () => {
        expect(attachmentDisposition('report-2026.pdf')).toBe('attachment; filename="report-2026.pdf"');
    });

    it('matches what the server sends for the same name', () => {
        // Same expectation as the server's GenerateDownloadLink_WithPolishFileName test.
        expect(attachmentDisposition('zażółć.txt'))
            .toBe("attachment; filename=\"zazo_c.txt\"; filename*=UTF-8''za%C5%BC%C3%B3%C5%82%C4%87.txt");
    });

    it('never lets a quote or backslash break out of the quoted fallback', () => {
        expect(attachmentDisposition('a"b\\c.txt').startsWith('attachment; filename="a_b_c.txt"; filename*=')).toBe(true);
    });

    it("escapes the characters RFC 5987 doesn't allow in filename*", () => {
        expect(attachmentDisposition("it's (1)!ł.txt")).toContain("filename*=UTF-8''it%27s%20%281%29%21%C5%82.txt");
    });

    it('produces a value without line breaks, whatever the name', () => {
        const value = attachmentDisposition('evil\r\nX-Injected: 1.txt');
        expect(value.includes('\r') || value.includes('\n')).toBe(false);
    });
});

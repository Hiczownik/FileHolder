import { describe, it, expect } from 'vitest';
import { buildSamplePdf } from '../keeper/samplePdf';

const ORIGIN = 'https://fileholder.app';
const MADE_AT = new Date('2026-10-26T21:07:21.000Z');
const OBJECT_COUNT = 7;
const OFFSET_DIGITS = 10;
const LINES_BEFORE_ENTRIES = 3;

const text = (): string => new TextDecoder().decode(buildSamplePdf(ORIGIN, MADE_AT));

/** The cross-reference table's offsets, one per object, as written after "startxref". */
function xrefOffsets(pdf: string): number[] {
    const start = Number(pdf.slice(pdf.lastIndexOf('startxref') + 'startxref'.length).trim().split('\n')[0]);
    // After "xref", the count line and the free entry for object 0.
    const entries = pdf.slice(start).split('\n').slice(LINES_BEFORE_ENTRIES, LINES_BEFORE_ENTRIES + OBJECT_COUNT);
    return entries.map((entry) => Number(entry.slice(0, OFFSET_DIGITS)));
}

describe('the sample PDF', () => {
    it('is a PDF whose cross-reference table points at each object', () => {
        const pdf = text();

        expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
        expect(pdf.endsWith('%%EOF\n')).toBe(true);
        xrefOffsets(pdf).forEach((offset, index) => {
            expect(pdf.slice(offset).startsWith(`${index + 1} 0 obj\n`)).toBe(true);
        });
    });

    it("gives its content stream's real length", () => {
        const pdf = text();
        const declared = Number(pdf.slice(pdf.indexOf('/Length ') + '/Length '.length).split(' ')[0]);
        const start = pdf.indexOf('stream\n') + 'stream\n'.length;

        expect(pdf.slice(start, start + declared).endsWith('ET')).toBe(true);
        expect(pdf.slice(start + declared).startsWith('\nendstream')).toBe(true);
    });

    it('names the site and the day it was made', () => {
        const pdf = text();

        expect(pdf).toContain('(To share files of your own, go to https://fileholder.app.) Tj');
        expect(pdf).toContain('fileholder.app/sample always points to the latest.');
        expect(pdf).toContain('(This copy was made on 2026-10-26 \\(UTC\\).) Tj');
    });
});

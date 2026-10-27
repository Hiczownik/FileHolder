// The sample bundle's PDF, built here rather than kept as a binary: one A4 page of text in Helvetica, which every PDF
// reader has, so nothing is embedded. Only ASCII, which Helvetica's standard encoding covers as is.

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN_LEFT = 72;
const FIRST_LINE_Y = 760;
const TITLE_SIZE = 22;
const BODY_SIZE = 12;
const LINE_GAP = 18;
const PARAGRAPH_GAP = 10;
const TITLE_GAP = 34;
const XREF_OFFSET_DIGITS = 10;
// "2026-10-26" out of "2026-10-26T21:07:21.000Z".
const ISO_DATE_LENGTH = 10;

/** What the page says, a paragraph per entry; each line is set as given (no wrapping). */
function pageText(origin: string, madeAt: Date): readonly (readonly string[])[] {
    const host = new URL(origin).host;
    return [
        [
            'You just downloaded this from an encrypted bundle. It was decrypted in your',
            'browser with the key in the link, after the bit after "#", which browsers never',
            'send to a server. The storage only ever held scrambled bytes.',
        ],
        [
            'Every bundle on FileHolder deletes itself after the time or number of downloads',
            'its sender chose. This sample is no exception: a new one is made every few',
            `hours, and ${host}/sample always points to the latest.`,
        ],
        [
            'The photo next to this file had its location and camera details removed before',
            'it was uploaded, as FileHolder offers to do for every photo you share.',
        ],
        [`To share files of your own, go to ${origin}.`],
        [`This copy was made on ${madeAt.toISOString().slice(0, ISO_DATE_LENGTH)} (UTC).`],
    ];
}

// A backslash or a parenthesis, which PDF string literals treat specially: in "a (b) \ c" it matches "(", ")" and
// "\", not the letters or spaces. https://regex101.com/?regex=%5B%5C%5C()%5D&flags=g&testString=a%20(b)%20%5C%20c
const PDF_SPECIAL = /[\\()]/g;

/** Escapes what PDF string literals treat specially. */
const escapePdf = (text: string): string => text.replace(PDF_SPECIAL, (char) => `\\${char}`);

function contentStream(origin: string, madeAt: Date): string {
    // Each line moves down from the one before: further after the title and between paragraphs.
    const lines = pageText(origin, madeAt).flatMap((paragraph, p) => {
        const firstGap = p === 0 ? TITLE_GAP : LINE_GAP + PARAGRAPH_GAP;
        return paragraph.map((line, l) => `0 ${-(l === 0 ? firstGap : LINE_GAP)} Td\n(${escapePdf(line)}) Tj`);
    });
    const header = ['BT', `/F2 ${TITLE_SIZE} Tf`, `${MARGIN_LEFT} ${FIRST_LINE_Y} Td`, '(FileHolder sample bundle) Tj', `/F1 ${BODY_SIZE} Tf`];
    return [...header, ...lines, 'ET'].join('\n');
}

/** A one-page PDF about FileHolder for the sample bundle, naming `origin` and the date it was made. */
export function buildSamplePdf(origin: string, madeAt: Date): Uint8Array {
    const content = contentStream(origin, madeAt);
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        '<< /Title (FileHolder sample bundle) /Producer (FileHolder) >>',
    ];

    // Every character is ASCII, so string lengths are byte offsets.
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, index) => {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.map((offset) => `${String(offset).padStart(XREF_OFFSET_DIGITS, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return new TextEncoder().encode(pdf);
}

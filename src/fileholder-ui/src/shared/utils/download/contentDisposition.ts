/**
 * Browser-side copy of ContentDispositionUtils.Attachment on the server: an attachment header that is pure
 * ASCII, so it is valid in any HTTP header, with the real name in filename* (RFC 6266 / RFC 5987), which
 * browsers prefer when present.
 */

const PRINTABLE_ASCII_FIRST = 0x20;
const PRINTABLE_ASCII_LAST = 0x7e;

// Matches combining marks, the accents left behind once a letter is decomposed: in "e" + U+0301 (from "é")
// only the U+0301 matches; "e" and "ł" (a letter of its own) don't.
// https://regex101.com/?regex=%5Cp%7BMn%7D&flags=gu&testString=e%CC%81%20%C5%82
const COMBINING_MARK = /\p{Mn}/gu;

/** "zażółć.txt" becomes "zazo_c.txt": accents are dropped, anything else that isn't printable ASCII becomes "_". */
function asciiFallback(fileName: string): string {
    return Array.from(fileName.normalize('NFD').replace(COMBINING_MARK, ''), (char) => {
        const code = char.codePointAt(0) ?? 0;
        const printable = code >= PRINTABLE_ASCII_FIRST && code <= PRINTABLE_ASCII_LAST;
        return printable && char !== '"' && char !== '\\' ? char : '_';
    }).join('');
}

// Matches the characters encodeURIComponent leaves alone but RFC 5987 doesn't allow in filename*; "'" is
// even its delimiter. In "it's (1)!.txt" the "'", "(", ")" and "!" match; letters, digits and "." don't.
// https://regex101.com/?regex=%5B!'()*%5D&flags=g&testString=it's%20(1)!.txt
const NOT_RFC5987_ATTR_CHAR = /[!'()*]/g;
const HEX_RADIX = 16;

const encodeRfc5987 = (value: string): string =>
    encodeURIComponent(value).replace(NOT_RFC5987_ATTR_CHAR, (char) => `%${char.charCodeAt(0).toString(HEX_RADIX).toUpperCase()}`);

export function attachmentDisposition(fileName: string): string {
    const fallback = asciiFallback(fileName);
    const value = `attachment; filename="${fallback}"`;
    return fallback === fileName ? value : `${value}; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

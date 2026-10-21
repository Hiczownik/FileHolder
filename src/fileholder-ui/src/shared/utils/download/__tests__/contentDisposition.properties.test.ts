import { describe, expect, it } from 'vitest';
import { test } from '@fast-check/vitest';
import { attachmentDisposition } from '../contentDisposition';
import { fileName, safeFileName, show } from '../../../../test/arbitraries';

/** Rules the download header keeps for any name; the server's ContentDispositionUtilsProperties check the same. */

// An RFC 6266 attachment: a quoted ASCII fallback with no '"' or '\' inside, then optionally filename* holding the
// name percent-encoded (RFC 5987 attr-chars and %XX). Matches 'attachment; filename="a_b.txt"; filename*=UTF-8''a%20b.txt';
// rejects 'attachment; filename="a"b"'.
// https://regex101.com/?regex=%5Eattachment%3B%20filename%3D%22%5B%5E%22%5C%5C%5D*%22(%3B%20filename%5C*%3DUTF-8''%5BA-Za-z0-9%25._~-%5D*)%3F%24&testString=attachment%3B%20filename%3D%22a_b.txt%22%3B%20filename*%3DUTF-8''a%2520b.txt
const RFC6266_SHAPE = /^attachment; filename="[^"\\]*"(; filename\*=UTF-8''[A-Za-z0-9%._~-]*)?$/;

// Matches anything outside printable ASCII: "é" and "\n" match, "a" and "~" don't.
// https://regex101.com/?regex=%5B%5E%5Cx20-%5Cx7e%5D&flags=g&testString=a~%C3%A9
const NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/;

// Matches half a character, as in contentDisposition.ts: "a\uD800b" matches; a whole pair doesn't.
// https://regex101.com/?regex=%5B%5CuD800-%5CuDBFF%5D(%3F!%5B%5CuDC00-%5CuDFFF%5D)%7C(%3F%3C!%5B%5CuD800-%5CuDBFF%5D)%5B%5CuDC00-%5CuDFFF%5D&flags=g&testString=a%F0%9F%98%80b
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const STAR_PREFIX = "; filename*=UTF-8''";
const FALLBACK_PREFIX = 'attachment; filename="';

describe('attachmentDisposition', () => {
    test.prop([fileName])('is always printable ASCII', (name) => {
        const header = attachmentDisposition(name);
        expect(NOT_PRINTABLE_ASCII.test(header), `${show(name)} -> ${show(header)}`).toBe(false);
    });

    test.prop([fileName])('has the RFC 6266 shape', (name) => {
        const header = attachmentDisposition(name);
        expect(RFC6266_SHAPE.test(header), `${show(name)} -> ${show(header)}`).toBe(true);
    });

    test.prop([fileName])('carries the name, half characters replaced, in filename* (or as the fallback itself)', (name) => {
        const header = attachmentDisposition(name);
        const star = header.indexOf(STAR_PREFIX);
        const decoded = star < 0
            ? header.slice(FALLBACK_PREFIX.length, -'"'.length)
            : decodeURIComponent(header.slice(star + STAR_PREFIX.length));
        expect(decoded, show(name)).toBe(name.replace(LONE_SURROGATE, '_'));
    });

    test.prop([safeFileName])('gives a plain ASCII name no filename*', (name) => {
        expect(attachmentDisposition(name)).toBe(`attachment; filename="${name}"`);
    });

    // Found by the properties (#70): encodeURIComponent threw a URIError on half a character.
    it('replaces half a character instead of throwing', () => {
        expect(attachmentDisposition('a\uD800.txt')).toBe('attachment; filename="a_.txt"');
    });
});

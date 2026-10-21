import { afterEach, describe, expect, it, vi } from 'vitest';
import { asciiBytes, concatBytes, u16be, u32le, uint16Bytes, uint32Bytes } from '../bytes';
import { readExif, withoutExifPrefix } from '../exif';
import { detectPhotoMetadata, removePhotoMetadata } from '../index';
import { crc32 } from '../png';
import {
    APP0, APP1, APP13, APP14, APP2, APP3, asFile, BASE_JPEG, BASE_PNG, BASE_WEBP, buildExif, buildJpeg, buildPng, buildWebp,
    bytesOf, COM, GAIN_MAP, JPEG_METADATA_OFFSET, jpegSegment, leakedSecrets, MOTION_VIDEO, pngChunks, pngText, segmentId,
    segments, splitJpeg, VP8X_ANIMATION, VP8X_EXIF, VP8X_ICC, VP8X_XMP, webpChunk, webpChunks, webpExtras,
} from './photoFixtures';

const JPEG_TYPE = 'image/jpeg';
const PNG_TYPE = 'image/png';
const WEBP_TYPE = 'image/webp';
const UPRIGHT = 1;
const ROTATED_90 = 6;
const MAX_ORIENTATION = 8;
const ORIENTATIONS = Array.from({ length: MAX_ORIENTATION }, (_, index) => index + 1);
// A cleaned EXIF holds a TIFF header, one directory and the orientation: 26 bytes.
const MINIMAL_TIFF_BYTES = 26;
// Damaged files must be refused quickly, never by a hang.
const MAX_FAILURE_MS = 1000;
const BYTES_PER_KB = 1024;
const LARGE_IMAGE_DATA_MB = 8;
const LARGE_IMAGE_DATA_BYTES = LARGE_IMAGE_DATA_MB * BYTES_PER_KB * BYTES_PER_KB;
// detect and strip only read headers: a few metadata sections of at most 64 KB each.
const MAX_HEADER_READ_KB = 256;
const MAX_HEADER_READ_BYTES = MAX_HEADER_READ_KB * BYTES_PER_KB;
const RIFF_SIZE_OFFSET = 4;
const RIFF_SIZE_FIELD_END = 8;
const SOI_BYTES = 2;
const SEGMENT_HEADER_BYTES = 4;
const EXIF_PREFIX = 'Exif\0\0';
const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const WEBP_CHUNK_SIZE_OFFSET = 4;
const MAX_UINT16 = 0xffff;
const HUGE_LENGTH = 0x7ffffff0;
const HALF = 2;

const strip = async (bytes: Uint8Array, name: string, type: string) => {
    const result = await removePhotoMetadata(asFile(bytes, name, type));
    return { ...result, bytes: await bytesOf(result.file) };
};

/** The TIFF data of each EXIF segment in a JPEG. */
const jpegExifData = (bytes: Uint8Array): Uint8Array[] =>
    splitJpeg(bytes).segments
        .filter((segment) => segment.marker === APP1)
        .map((segment) => segment.bytes.subarray(SEGMENT_HEADER_BYTES + EXIF_PREFIX.length));

/** A copy of `bytes` with `patch` written at `offset`. */
const patched = (bytes: Uint8Array, offset: number, patch: Uint8Array): Uint8Array => {
    const copy = bytes.slice();
    copy.set(patch, offset);
    return copy;
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe('JPEG', () => {
    const fullJpeg = (): Uint8Array => buildJpeg([
        segments.jfxxThumbnail(), segments.exif({ orientation: UPRIGHT }), segments.xmp({ gps: true }), segments.extendedXmp(),
        segments.iptc(), segments.comment(), segments.flashPix(), segments.app3(), segments.adobe(),
    ]);
    const isMetadata = (marker: number, bytes: Uint8Array): boolean =>
        [APP1, APP13, APP3, COM].includes(marker) || ['JFXX', 'FPXR'].includes(segmentId(bytes));

    it('removes EXIF, XMP, IPTC, comments, thumbnails and other APPn segments, and nothing else', async () => {
        const original = fullJpeg();
        const result = await strip(original, 'photo.jpg', JPEG_TYPE);

        expect(result.status).toBe('stripped');
        expect(leakedSecrets(result.bytes)).toEqual([]);
        expect([...result.removed].sort()).toEqual(['APP3', 'Comment', 'EXIF', 'FlashPix', 'JFIF thumbnail', 'Photoshop/IPTC', 'XMP'].sort());

        // The image data, and every segment that isn't metadata, are byte-for-byte the same and in the same order.
        const before = splitJpeg(original);
        const after = splitJpeg(result.bytes);
        expect(after.imageData).toEqual(before.imageData);
        expect(after.segments.map((segment) => segment.bytes)).toEqual(
            before.segments.filter((segment) => !isMetadata(segment.marker, segment.bytes)).map((segment) => segment.bytes));
        // JFIF, the ICC profile and the Adobe colour transform stay.
        expect(after.segments.map((segment) => segment.marker)).toEqual(expect.arrayContaining([APP0, APP2, APP14]));
    });

    it('keeps the name, type and modified date', async () => {
        const original = asFile(fullJpeg(), 'IMG_0001.JPG', JPEG_TYPE);
        const { file } = await removePhotoMetadata(original);

        expect(file.name).toBe('IMG_0001.JPG');
        expect(file.type).toBe(JPEG_TYPE);
        expect(file.lastModified).toBe(original.lastModified);
        expect(file.size).toBeLessThan(original.size);
    });

    it.each(ORIENTATIONS.flatMap((orientation) => [[orientation, false], [orientation, true]] as const))(
        'keeps orientation %i (little-endian: %s) and nothing else of the EXIF',
        async (orientation, littleEndian) => {
            const result = await strip(buildJpeg([segments.exif({ orientation, littleEndian })]), 'rotated.jpg', JPEG_TYPE);
            const exif = jpegExifData(result.bytes);

            expect(leakedSecrets(result.bytes)).toEqual([]);
            if (orientation === UPRIGHT) {
                expect(exif).toEqual([]);
                return;
            }
            expect(exif).toHaveLength(1);
            expect(exif[0]).toHaveLength(MINIMAL_TIFF_BYTES);
            expect(readExif(exif[0])).toEqual({ orientation, hasLocation: false });
        });

    it('adds no EXIF when the original has none or no orientation', async () => {
        const result = await strip(buildJpeg([segments.exif(), segments.comment()]), 'photo.jpg', JPEG_TYPE);

        expect(jpegExifData(result.bytes)).toEqual([]);
    });

    it('leaves a JPEG without metadata untouched, as the same file', async () => {
        const original = asFile(BASE_JPEG, 'clean.jpg', JPEG_TYPE);
        const result = await removePhotoMetadata(original);

        expect(result.status).toBe('unchanged');
        expect(result.file).toBe(original);
    });

    it('keeps an HDR gain map after the image, and the MPF segment that points to it', async () => {
        const original = buildJpeg([segments.exif(), segments.mpf()], [GAIN_MAP]);
        const result = await strip(original, 'hdr.jpg', JPEG_TYPE);

        expect(splitJpeg(result.bytes).imageData).toEqual(splitJpeg(original).imageData);
        expect(result.bytes.subarray(result.bytes.length - GAIN_MAP.length)).toEqual(GAIN_MAP);
        expect(splitJpeg(result.bytes).segments.some((segment) => segment.marker === APP2 && segmentId(segment.bytes) === 'MPF\0')).toBe(true);
    });

    it.each(['container', 'microvideo'] as const)('removes a Motion Photo\'s video (%s format), leaving the still photo', async (format) => {
        const original = buildJpeg([segments.xmp({ motion: { format, length: MOTION_VIDEO.length } })], [MOTION_VIDEO]);
        const result = await strip(original, 'PXL_motion.jpg', JPEG_TYPE);

        expect(result.status).toBe('stripped');
        expect(result.removed).toContain('Motion Photo video');
        expect(leakedSecrets(result.bytes)).toEqual([]);
        expect(splitJpeg(result.bytes).imageData).toEqual(splitJpeg(BASE_JPEG).imageData);
        expect((await detectPhotoMetadata(asFile(original, 'PXL_motion.jpg', JPEG_TYPE))).isMotionPhoto).toBe(true);
    });

    it('never cuts into the photo when a Motion Photo\'s XMP gives a wrong video length', async () => {
        const original = buildJpeg([segments.xmp({ motion: { format: 'container', length: MOTION_VIDEO.length + 1 } })], [MOTION_VIDEO]);
        const file = asFile(original, 'odd.jpg', JPEG_TYPE);
        const result = await removePhotoMetadata(file);

        expect(result.status).toBe('failed');
        expect(result.file).toBe(file);
    });
});

describe('location detection', () => {
    it.each([
        ['GPS coordinates in EXIF', [segments.exif({ gps: 'coordinates' })], true],
        ['GPS coordinates in XMP only', [segments.exif({ gps: 'none' }), segments.xmp({ gps: true })], true],
        ['a GPS section without a fix (all zeros)', [segments.exif({ gps: 'zeros' })], false],
        ['no GPS section', [segments.exif({ gps: 'none' })], false],
        ['no metadata at all', [], false],
    ])('%s: hasLocation is %s', async (_label, extra, expected) => {
        const report = await detectPhotoMetadata(asFile(buildJpeg(extra), 'photo.jpg', JPEG_TYPE));

        expect(report.hasLocation).toBe(expected);
        expect(report.unremovable).toBe(false);
    });

    it('also finds locations in PNG and WebP files', async () => {
        expect((await detectPhotoMetadata(asFile(buildPng([pngText.exif()]), 'a.png', PNG_TYPE))).hasLocation).toBe(true);
        expect((await detectPhotoMetadata(asFile(buildPng([pngText.xmp({ gps: true })]), 'a.png', PNG_TYPE))).hasLocation).toBe(true);
        expect((await detectPhotoMetadata(asFile(buildWebp(VP8X_EXIF, [webpExtras.exif()]), 'a.webp', WEBP_TYPE))).hasLocation).toBe(true);
        expect((await detectPhotoMetadata(asFile(BASE_WEBP, 'a.webp', WEBP_TYPE))).hasLocation).toBe(false);
    });

    it('lists what removing would take out', async () => {
        const report = await detectPhotoMetadata(asFile(buildJpeg([segments.exif(), segments.xmp()]), 'photo.jpg', JPEG_TYPE));

        expect(report.removable).toEqual(['EXIF', 'XMP']);
    });
});

describe('PNG', () => {
    const metadataChunks = ['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'];
    // Chromium's PNG splits its image data over more than one IDAT chunk.
    const IMAGE_CHUNKS = pngChunks(BASE_PNG).filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.type);

    it('removes EXIF, text and time chunks, before and after the image data, and keeps every other chunk', async () => {
        const original = buildPng(
            [pngText.iCCP(), pngText.pHYs(), pngText.exif(), pngText.tEXt(), pngText.xmp({ gps: true }), pngText.tIME()],
            [pngText.zTXt(), pngText.tEXt()],
        );
        const result = await strip(original, 'screenshot.png', PNG_TYPE);

        expect(result.status).toBe('stripped');
        expect(leakedSecrets(result.bytes)).toEqual([]);
        expect(pngChunks(result.bytes)).toEqual(pngChunks(original).filter((chunk) => !metadataChunks.includes(chunk.type)));
        expect(pngChunks(result.bytes).map((chunk) => chunk.type)).toEqual(['IHDR', 'iCCP', 'pHYs', ...IMAGE_CHUNKS, 'IEND']);
    });

    it('keeps an animated PNG\'s animation chunks', async () => {
        const original = buildPng([pngText.acTL(), pngText.fcTL(), pngText.tEXt()], [pngText.fcTL(), pngText.fdAT()]);
        const result = await strip(original, 'animated.png', PNG_TYPE);

        expect(pngChunks(result.bytes).map((chunk) => chunk.type)).toEqual(['IHDR', 'acTL', 'fcTL', ...IMAGE_CHUNKS, 'fcTL', 'fdAT', 'IEND']);
    });

    it('keeps the orientation in a new eXIf chunk', async () => {
        const result = await strip(buildPng([pngText.exif({ orientation: ROTATED_90 })]), 'rotated.png', PNG_TYPE);
        const exif = pngChunks(result.bytes).filter((chunk) => chunk.type === 'eXIf');

        expect(exif).toHaveLength(1);
        expect(readExif(exif[0].data)).toEqual({ orientation: ROTATED_90, hasLocation: false });
        expect(leakedSecrets(result.bytes)).toEqual([]);
    });

    it('writes only chunks with valid CRCs', async () => {
        const result = await strip(buildPng([pngText.exif({ orientation: ROTATED_90 }), pngText.tEXt()]), 'a.png', PNG_TYPE);

        pngChunks(result.bytes).forEach((chunk) => {
            expect(chunk.crc).toBe(crc32(concatBytes(asciiBytes(chunk.type), chunk.data)));
        });
    });

    it('drops data hidden after the end of the image', async () => {
        const result = await strip(buildPng([], [], [asciiBytes('TRAILING-DATA')]), 'a.png', PNG_TYPE);

        expect(result.removed).toEqual(['Data after the image']);
        expect(result.bytes).toEqual(BASE_PNG);
    });

    it('leaves a PNG without metadata untouched', async () => {
        expect((await removePhotoMetadata(asFile(BASE_PNG, 'clean.png', PNG_TYPE))).status).toBe('unchanged');
    });
});

describe('WebP', () => {
    it('removes EXIF and XMP chunks, clears their flags, and rewrites the RIFF size', async () => {
        const original = buildWebp(VP8X_EXIF | VP8X_XMP, [webpExtras.exif(), webpExtras.xmp({ gps: true })]);
        const result = await strip(original, 'photo.webp', WEBP_TYPE);

        expect(result.status).toBe('stripped');
        expect(leakedSecrets(result.bytes)).toEqual([]);
        expect(u32le(result.bytes, RIFF_SIZE_OFFSET)).toBe(result.bytes.length - RIFF_SIZE_FIELD_END);

        const chunks = webpChunks(result.bytes);
        expect(chunks.map((chunk) => chunk.type)).toEqual(['VP8X', 'ICCP', 'VP8 ']);
        const [vp8x] = chunks;
        expect(vp8x.data[0] & (VP8X_EXIF | VP8X_XMP)).toBe(0);
        expect(vp8x.data[0] & VP8X_ICC).toBe(VP8X_ICC);
        // The colour profile, the image data and the canvas size are byte-for-byte the same.
        const originalChunks = webpChunks(original);
        expect(chunks.slice(1)).toEqual(originalChunks.filter((chunk) => chunk.type === 'ICCP' || chunk.type === 'VP8 '));
        expect(vp8x.data.subarray(1)).toEqual(originalChunks[0].data.subarray(1));
    });

    it('keeps the orientation in a new EXIF chunk, with the EXIF flag set', async () => {
        const original = buildWebp(VP8X_EXIF | VP8X_XMP, [webpExtras.exif({ orientation: ROTATED_90 }), webpExtras.xmp()]);
        const result = await strip(original, 'rotated.webp', WEBP_TYPE);
        const chunks = webpChunks(result.bytes);
        const exif = chunks.filter((chunk) => chunk.type === 'EXIF');

        expect(exif).toHaveLength(1);
        expect(readExif(withoutExifPrefix(exif[0].data))).toEqual({ orientation: ROTATED_90, hasLocation: false });
        expect(chunks[0].data[0] & (VP8X_EXIF | VP8X_XMP)).toBe(VP8X_EXIF);
        expect(u32le(result.bytes, RIFF_SIZE_OFFSET)).toBe(result.bytes.length - RIFF_SIZE_FIELD_END);
    });

    it('keeps an animated WebP\'s frames and animation flag', async () => {
        const original = buildWebp(VP8X_EXIF, [webpExtras.exif()], { animated: true });
        const result = await strip(original, 'animated.webp', WEBP_TYPE);
        const chunks = webpChunks(result.bytes);

        expect(chunks.map((chunk) => chunk.type)).toEqual(['VP8X', 'ICCP', 'ANIM', 'ANMF', 'ANMF']);
        expect(chunks[0].data[0] & VP8X_ANIMATION).toBe(VP8X_ANIMATION);
        expect(chunks.slice(1)).toEqual(webpChunks(original).filter((chunk) => chunk.type !== 'VP8X' && chunk.type !== 'EXIF'));
    });

    it('leaves a WebP without metadata untouched', async () => {
        expect((await removePhotoMetadata(asFile(BASE_WEBP, 'clean.webp', WEBP_TYPE))).status).toBe('unchanged');
    });
});

describe('other formats', () => {
    // An ISO media file starts with an "ftyp" box: size, "ftyp", major brand, version, compatible brands.
    const isoMedia = (brand: string): Uint8Array => {
        const body = asciiBytes(`ftyp${brand}\0\0\0\0${brand}mif1`);
        return concatBytes(uint32Bytes(body.length + RIFF_SIZE_OFFSET, false), body, asciiBytes('MEDIA-DATA'));
    };

    it.each([
        ['HEIC', isoMedia('heic'), 'heic'],
        ['AVIF', isoMedia('avif'), 'avif'],
        ['MOV', isoMedia('qt  '), 'video'],
        ['MP4', isoMedia('isom'), 'video'],
        ['TIFF', asciiBytes('II*\0\x08\0\0\0RAW-DATA'), 'tiff'],
    ])('leaves %s unchanged and says its metadata can\'t be removed', async (_label, bytes, format) => {
        const file = asFile(bytes, 'media', 'application/octet-stream');

        const result = await removePhotoMetadata(file);
        expect(result.status).toBe('unsupported');
        expect(result.file).toBe(file);
        expect(await detectPhotoMetadata(file)).toMatchObject({ format, unremovable: true, removable: [] });
    });

    it('leaves files that aren\'t photos alone, without flagging them', async () => {
        const file = asFile(asciiBytes('%PDF-1.7 Author: Someone'), 'report.pdf', 'application/pdf');

        expect((await removePhotoMetadata(file)).status).toBe('unchanged');
        expect(await detectPhotoMetadata(file)).toMatchObject({ format: 'other', unremovable: false, hasLocation: false });
        expect((await removePhotoMetadata(asFile(new Uint8Array(0), 'empty.txt', 'text/plain'))).status).toBe('unchanged');
    });

    it('tells formats apart by their first bytes, not their name or type', async () => {
        const misnamed = asFile(buildJpeg([segments.exif()]), 'holiday.png', PNG_TYPE);

        expect(await detectPhotoMetadata(misnamed)).toMatchObject({ format: 'jpeg', hasLocation: true });
    });
});

describe('damaged files', () => {
    const withExif = buildJpeg([segments.exif()]);
    const exifLength = u16be(withExif, JPEG_METADATA_OFFSET + HALF);
    const truncatedExif = withExif.subarray(0, JPEG_METADATA_OFFSET + exifLength / HALF);
    const lengthPastEnd = patched(withExif, JPEG_METADATA_OFFSET + HALF, uint16Bytes(MAX_UINT16, false));
    const tooShortLength = concatBytes(BASE_JPEG.subarray(0, SOI_BYTES), asciiBytes('\xff\xe1\0\x01'), BASE_JPEG.subarray(SOI_BYTES));
    // After the first segment: garbage straight after SOI would make the file not a JPEG at all.
    const noMarker = concatBytes(BASE_JPEG.subarray(0, JPEG_METADATA_OFFSET), asciiBytes('NOT-A-MARKER'), BASE_JPEG.subarray(JPEG_METADATA_OFFSET));
    // An EXIF directory claiming 65,535 entries.
    const hugeIfd = buildJpeg([jpegSegment(APP1, concatBytes(asciiBytes('Exif\0\0MM\0*\0\0\0\x08'), uint16Bytes(MAX_UINT16, false)))]);
    const brokenTiff = buildJpeg([jpegSegment(APP1, asciiBytes('Exif\0\0XX-not-tiff'))]);

    const firstAddedPngChunk = PNG_SIGNATURE_BYTES + PNG_CHUNK_OVERHEAD_BYTES + pngChunks(BASE_PNG)[0].data.length;
    const pngChunkPastEnd = patched(buildPng([pngText.tEXt()]), firstAddedPngChunk, uint32Bytes(HUGE_LENGTH, false));
    const pngWithoutEnd = BASE_PNG.subarray(0, BASE_PNG.length - PNG_CHUNK_OVERHEAD_BYTES);

    const webpWithExif = buildWebp(VP8X_EXIF, [webpExtras.exif()]);
    const webpSizePastEnd = patched(webpWithExif, RIFF_SIZE_OFFSET, uint32Bytes(HUGE_LENGTH, true));
    const lastChunkStart = webpWithExif.length - webpChunk('EXIF', buildExif()).length;
    const webpChunkPastEnd = patched(webpWithExif, lastChunkStart + WEBP_CHUNK_SIZE_OFFSET, uint32Bytes(HUGE_LENGTH, true));

    it.each([
        ['a JPEG cut off in the middle of a segment', truncatedExif, JPEG_TYPE],
        ['a JPEG segment length past the end of the file', lengthPastEnd, JPEG_TYPE],
        ['a JPEG segment length below 2', tooShortLength, JPEG_TYPE],
        ['garbage where a JPEG marker should be', noMarker, JPEG_TYPE],
        ['an EXIF directory with 65,535 entries', hugeIfd, JPEG_TYPE],
        ['EXIF that isn\'t TIFF', brokenTiff, JPEG_TYPE],
        ['a PNG chunk length past the end of the file', pngChunkPastEnd, PNG_TYPE],
        ['a PNG without its end chunk', pngWithoutEnd, PNG_TYPE],
        ['a WebP RIFF size past the end of the file', webpSizePastEnd, WEBP_TYPE],
        ['a WebP chunk past the end of the RIFF data', webpChunkPastEnd, WEBP_TYPE],
    ])('%s: comes back unchanged as "failed", quickly', async (_label, bytes, type) => {
        const file = asFile(bytes, 'damaged', type);
        const started = performance.now();

        const result = await removePhotoMetadata(file);
        const report = await detectPhotoMetadata(file);

        expect(result.status).toBe('failed');
        expect(result.file).toBe(file);
        expect(report.unremovable).toBe(true);
        expect(performance.now() - started).toBeLessThan(MAX_FAILURE_MS);
    });
});

describe('memory use', () => {
    it('reads only the headers of a large JPEG, never its image data', async () => {
        const photo = buildJpeg([segments.exif(), segments.xmp({ gps: true })]);
        const large = asFile(concatBytes(photo, new Uint8Array(LARGE_IMAGE_DATA_BYTES)), 'large.jpg', JPEG_TYPE);
        const reads: number[] = [];
        const realArrayBuffer = Blob.prototype.arrayBuffer;
        vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function (this: Blob) {
            const buffer = await realArrayBuffer.call(this);
            reads.push(buffer.byteLength);
            return buffer;
        });

        const report = await detectPhotoMetadata(large);
        const result = await removePhotoMetadata(large);

        expect(report.hasLocation).toBe(true);
        expect(result.status).toBe('stripped');
        expect(reads.reduce((total, bytes) => total + bytes, 0)).toBeLessThan(MAX_HEADER_READ_BYTES);
        expect(result.file.size).toBeGreaterThan(LARGE_IMAGE_DATA_BYTES);
    });
});

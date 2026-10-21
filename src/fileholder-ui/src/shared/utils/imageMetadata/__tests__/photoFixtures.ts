import { asciiBytes, concatBytes, u16be, u32be, u32le, uint16Bytes, uint32Bytes } from '../bytes';
import { pngChunk } from '../png';

/**
 * Sample photos for the tests, built in code around three real 2×2 images (drawn and encoded by Chromium). Every
 * piece of metadata carries a recognisable "secret" string, so a test can check that none of it survives.
 */

// Chromium's 2×2 JPEG (JFIF + ICC profile), PNG (IHDR, IDAT, IEND) and extended WebP (VP8X, ICCP, VP8).
const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAdEAABBQADAQAAAAAAAAAAAAABAAIDBAUGBxEh/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAcEQAABgMAAAAAAAAAAAAAAAAAAQM0crECBAX/2gAMAwEAAhEDEQA/AKo6f4niXepOE2LGNnz2JcOjJJLLVY5z3GuwlxJHpJP30oiKSek9XnlZgLtOFJHY/9k=';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAG0lEQVR4AWK6YGDw3+CCwX+mBIYFDAcUGBgAAAAA//9ltfq9AAAABklEQVQDAEQwBkM/8PY4AAAAAElFTkSuQmCC';
const WEBP_BASE64 = 'UklGRi4CAABXRUJQVlA4WAoAAAAgAAAAAQAAAQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggQAAAANABAJ0BKgIAAgAAwBIliAJ0ATT7tu+AAP75Cf/NPXfFqv+bj/+662knIW48cFpZHmd/82B/7ef+CPP8WoJyAAA=';

const fromBase64 = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
export const BASE_JPEG = fromBase64(JPEG_BASE64);
export const BASE_PNG = fromBase64(PNG_BASE64);
export const BASE_WEBP = fromBase64(WEBP_BASE64);

/** Strings that only metadata carries; none may be left in a cleaned file. */
export const SECRETS = {
    make: 'FileHolderTestCam',
    model: 'SecretModel-42',
    dateTime: '2026:10:21 12:34:56',
    thumbnail: 'THUMBNAIL-SECRET',
    xmpCreator: 'XmpSecretCreator',
    comment: 'CommentSecret',
    iptc: 'IptcSecret',
    pngText: 'PngTextSecret',
    video: 'MOTIONVIDEO-SECRET',
} as const;

/** Whether `bytes` contains `text` (as Latin-1). */
export const containsText = (bytes: Uint8Array, text: string): boolean =>
    String.fromCharCode(...bytes).includes(text);

/** Whether a cleaned file still contains any of the metadata secrets. */
export const leakedSecrets = (bytes: Uint8Array): string[] => Object.values(SECRETS).filter((secret) => containsText(bytes, secret));

// --- EXIF (TIFF) ---

const TIFF_MAGIC = 42;
const TIFF_HEADER_BYTES = 8;
const IFD_COUNT_BYTES = 2;
const IFD_ENTRY_BYTES = 12;
const IFD_NEXT_BYTES = 4;
const INLINE_VALUE_BYTES = 4;
const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_DATE_TIME = 0x0132;
const TAG_GPS_IFD = 0x8825;
const TAG_THUMBNAIL_OFFSET = 0x0201;
const TAG_THUMBNAIL_LENGTH = 0x0202;
const TAG_GPS_LATITUDE_REF = 0x0001;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LONGITUDE_REF = 0x0003;
const TAG_GPS_LONGITUDE = 0x0004;
const ODD = 1;

interface TiffEntry {
    readonly tag: number;
    readonly type: number;
    readonly count: number;
    readonly data: Uint8Array;
}

const asciiEntry = (tag: number, text: string): TiffEntry =>
    ({ tag, type: TYPE_ASCII, count: text.length + 1, data: asciiBytes(`${text}\0`) });
const shortEntry = (tag: number, value: number, le: boolean): TiffEntry =>
    ({ tag, type: TYPE_SHORT, count: 1, data: concatBytes(uint16Bytes(value, le), new Uint8Array(IFD_COUNT_BYTES)) });
const longEntry = (tag: number, value: number, le: boolean): TiffEntry =>
    ({ tag, type: TYPE_LONG, count: 1, data: uint32Bytes(value, le) });
const rationalsEntry = (tag: number, values: readonly (readonly [number, number])[], le: boolean): TiffEntry => ({
    tag,
    type: TYPE_RATIONAL,
    count: values.length,
    data: concatBytes(...values.flatMap(([numerator, denominator]) => [uint32Bytes(numerator, le), uint32Bytes(denominator, le)])),
});

/** A directory at `offset`, its values that don't fit in 4 bytes laid out right after it. */
function ifdBytes(entries: readonly TiffEntry[], offset: number, next: number, le: boolean): Uint8Array {
    const sorted = [...entries].sort((a, b) => a.tag - b.tag);
    const dataStart = offset + IFD_COUNT_BYTES + sorted.length * IFD_ENTRY_BYTES + IFD_NEXT_BYTES;
    const laidOut = sorted.reduce<{ fields: Uint8Array[]; data: Uint8Array }>((acc, entry) => {
        const head = concatBytes(uint16Bytes(entry.tag, le), uint16Bytes(entry.type, le), uint32Bytes(entry.count, le));
        if (entry.data.length <= INLINE_VALUE_BYTES) {
            const inline = concatBytes(entry.data, new Uint8Array(INLINE_VALUE_BYTES - entry.data.length));
            return { fields: [...acc.fields, concatBytes(head, inline)], data: acc.data };
        }
        const pointer = uint32Bytes(dataStart + acc.data.length, le);
        const value = concatBytes(entry.data, new Uint8Array(entry.data.length & ODD));
        return { fields: [...acc.fields, concatBytes(head, pointer)], data: concatBytes(acc.data, value) };
    }, { fields: [], data: new Uint8Array(0) });
    return concatBytes(uint16Bytes(sorted.length, le), ...laidOut.fields, uint32Bytes(next, le), laidOut.data);
}

// 52°31'12.34"N 13°24'56.78"E, as degrees, minutes and seconds (rationals).
const LATITUDE_DEGREES = 52;
const LATITUDE_MINUTES = 31;
const LATITUDE_SECONDS_X100 = 1234;
const LONGITUDE_DEGREES = 13;
const LONGITUDE_MINUTES = 24;
const LONGITUDE_SECONDS_X100 = 5678;
const WHOLE = 1;
const HUNDREDTHS = 100;
const LATITUDE: readonly (readonly [number, number])[] = [[LATITUDE_DEGREES, WHOLE], [LATITUDE_MINUTES, WHOLE], [LATITUDE_SECONDS_X100, HUNDREDTHS]];
const LONGITUDE: readonly (readonly [number, number])[] = [[LONGITUDE_DEGREES, WHOLE], [LONGITUDE_MINUTES, WHOLE], [LONGITUDE_SECONDS_X100, HUNDREDTHS]];
const NO_FIX: readonly (readonly [number, number])[] = [[0, WHOLE], [0, WHOLE], [0, WHOLE]];
// Binary snippets below are written as Latin-1 strings: "\xff\xd8" is a JPEG's start, "\xff\xd9" its end.
const JPEG_START = '\xff\xd8';
const JPEG_END = '\xff\xd9';
/** The thumbnail EXIF embeds: a stand-in JPEG body carrying a secret. */
const THUMBNAIL = asciiBytes(`${JPEG_START}${SECRETS.thumbnail}${JPEG_END}`);

export interface ExifOptions {
    readonly littleEndian?: boolean;
    readonly orientation?: number;
    /** `coordinates`: a real location; `zeros`: a GPS section without a fix; `none`: no GPS section. */
    readonly gps?: 'coordinates' | 'zeros' | 'none';
    readonly thumbnail?: boolean;
}

/** TIFF data as a camera writes it: make, model, time, maybe orientation, GPS and a thumbnail (in IFD1). */
export function buildExif({ littleEndian = false, orientation, gps = 'coordinates', thumbnail = true }: ExifOptions = {}): Uint8Array {
    const le = littleEndian;
    const ifd0 = (gpsOffset: number): TiffEntry[] => [
        asciiEntry(TAG_MAKE, SECRETS.make),
        asciiEntry(TAG_MODEL, SECRETS.model),
        asciiEntry(TAG_DATE_TIME, SECRETS.dateTime),
        ...(orientation === undefined ? [] : [shortEntry(TAG_ORIENTATION, orientation, le)]),
        ...(gps === 'none' ? [] : [longEntry(TAG_GPS_IFD, gpsOffset, le)]),
    ];
    const ifd0Length = ifdBytes(ifd0(0), TIFF_HEADER_BYTES, 0, le).length;
    const gpsOffset = TIFF_HEADER_BYTES + ifd0Length;
    const coordinates = gps === 'zeros' ? NO_FIX : LATITUDE;
    const gpsIfd = gps === 'none' ? new Uint8Array(0) : ifdBytes([
        asciiEntry(TAG_GPS_LATITUDE_REF, 'N'),
        rationalsEntry(TAG_GPS_LATITUDE, coordinates, le),
        asciiEntry(TAG_GPS_LONGITUDE_REF, 'E'),
        rationalsEntry(TAG_GPS_LONGITUDE, gps === 'zeros' ? NO_FIX : LONGITUDE, le),
    ], gpsOffset, 0, le);

    const ifd1Offset = gpsOffset + gpsIfd.length;
    const ifd1 = (thumbnailOffset: number): TiffEntry[] => [
        longEntry(TAG_THUMBNAIL_OFFSET, thumbnailOffset, le),
        longEntry(TAG_THUMBNAIL_LENGTH, THUMBNAIL.length, le),
    ];
    const ifd1Length = ifdBytes(ifd1(0), ifd1Offset, 0, le).length;
    const thumbnailParts = thumbnail ? [ifdBytes(ifd1(ifd1Offset + ifd1Length), ifd1Offset, 0, le), THUMBNAIL] : [];

    return concatBytes(
        asciiBytes(le ? 'II' : 'MM'),
        uint16Bytes(TIFF_MAGIC, le),
        uint32Bytes(TIFF_HEADER_BYTES, le),
        ifdBytes(ifd0(gpsOffset), TIFF_HEADER_BYTES, thumbnail ? ifd1Offset : 0, le),
        gpsIfd,
        ...thumbnailParts,
    );
}

// --- XMP ---

export interface XmpOptions {
    readonly gps?: boolean;
    /** A Motion Photo's video length, in the newer container format or the older MicroVideo one. */
    readonly motion?: { readonly format: 'container' | 'microvideo'; readonly length: number };
}

export function buildXmp({ gps = false, motion }: XmpOptions = {}): string {
    const location = gps ? ' exif:GPSLatitude="52,31.2N" exif:GPSLongitude="13,24.5E"' : '';
    const microVideo = motion?.format === 'microvideo'
        ? ` GCamera:MicroVideo="1" GCamera:MicroVideoVersion="1" GCamera:MicroVideoOffset="${motion.length}"`
        : '';
    const container = motion?.format === 'container'
        ? '<Container:Directory><rdf:Seq>'
          + '<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="0"/></rdf:li>'
          + `<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${motion.length}"/></rdf:li>`
          + '</rdf:Seq></Container:Directory>'
        : '';
    return '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        + `<rdf:Description xmp:CreatorTool="${SECRETS.xmpCreator}"${location}${microVideo}>${container}</rdf:Description>`
        + '</rdf:RDF></x:xmpmeta>';
}

// --- JPEG ---

const MARKER_PREFIX = 0xff;
const SEGMENT_LENGTH_BYTES = 2;
const SOI_BYTES = 2;
const MARKER_BYTES = 2;
const SOS = 0xda;
export const APP0 = 0xe0;
export const APP1 = 0xe1;
export const APP2 = 0xe2;
export const APP3 = 0xe3;
export const APP13 = 0xed;
export const APP14 = 0xee;
export const COM = 0xfe;

export const jpegSegment = (marker: number, payload: Uint8Array): Uint8Array =>
    concatBytes(Uint8Array.of(MARKER_PREFIX, marker), uint16Bytes(payload.length + SEGMENT_LENGTH_BYTES, false), payload);

export const segments = {
    exif: (options?: ExifOptions): Uint8Array => jpegSegment(APP1, concatBytes(asciiBytes('Exif\0\0'), buildExif(options))),
    xmp: (options?: XmpOptions): Uint8Array =>
        jpegSegment(APP1, asciiBytes(`http://ns.adobe.com/xap/1.0/\0${buildXmp(options)}`)),
    extendedXmp: (): Uint8Array => jpegSegment(APP1, asciiBytes(`http://ns.adobe.com/xmp/extension/\0GUID0000000000000000000000000000${buildXmp({ gps: true })}`)),
    iptc: (): Uint8Array => jpegSegment(APP13, asciiBytes(`Photoshop 3.0\x008BIM${SECRETS.iptc}`)),
    comment: (): Uint8Array => jpegSegment(COM, asciiBytes(SECRETS.comment)),
    jfxxThumbnail: (): Uint8Array => jpegSegment(APP0, asciiBytes(`JFXX\0\x10${SECRETS.thumbnail}`)),
    flashPix: (): Uint8Array => jpegSegment(APP2, asciiBytes(`FPXR\0${SECRETS.thumbnail}`)),
    app3: (): Uint8Array => jpegSegment(APP3, asciiBytes(`Meta\0${SECRETS.make}`)),
    adobe: (): Uint8Array => jpegSegment(APP14, asciiBytes('Adobe\0d\0\0\0\0\x01')),
    mpf: (): Uint8Array => jpegSegment(APP2, asciiBytes('MPF\0MM\0*\0\0\0\x08')),
};

/** A gain map stored after the main image, as HDR photos have; it carries no metadata and must stay. */
export const GAIN_MAP = asciiBytes(`${JPEG_START}GAINMAP-IMAGE-DATA${JPEG_END}`);

/** A stand-in MP4 for a Motion Photo: an "ftyp" box, then data carrying a secret. */
export const MOTION_VIDEO = concatBytes(
    uint32Bytes(SEGMENT_LENGTH_BYTES * IFD_ENTRY_BYTES, false),
    asciiBytes('ftypmp42\0\0\0\0isommp42'),
    asciiBytes(SECRETS.video),
);

/** Where the base JPEG's JFIF segment ends (its length field follows SOI and the APP0 marker); metadata goes after it. */
export const JPEG_METADATA_OFFSET = SOI_BYTES + MARKER_BYTES + u16be(BASE_JPEG, SOI_BYTES + MARKER_BYTES);

/** The base JPEG with `extra` segments after its JFIF segment, and `tail` after its end. */
export const buildJpeg = (extra: readonly Uint8Array[], tail: readonly Uint8Array[] = []): Uint8Array =>
    concatBytes(BASE_JPEG.subarray(0, JPEG_METADATA_OFFSET), ...extra, BASE_JPEG.subarray(JPEG_METADATA_OFFSET), ...tail);

/** The 4 identifier bytes after a segment's marker and length, e.g. "MPF\0" or "FPXR". */
export const segmentId = (segment: Uint8Array): string =>
    String.fromCharCode(...segment.subarray(SEGMENT_HEADER_BYTES, SEGMENT_HEADER_BYTES + SEGMENT_ID_BYTES));

const SEGMENT_HEADER_BYTES = MARKER_BYTES + SEGMENT_LENGTH_BYTES;
const SEGMENT_ID_BYTES = 4;

export interface JpegSegmentInfo {
    readonly marker: number;
    readonly bytes: Uint8Array;
}

/** The segments before the image data, and the image data itself (from SOS to the end of the file). */
export function splitJpeg(bytes: Uint8Array): { segments: JpegSegmentInfo[]; imageData: Uint8Array } {
    const walk = (offset: number, found: JpegSegmentInfo[]): { segments: JpegSegmentInfo[]; imageData: Uint8Array } => {
        const marker = bytes[offset + 1];
        if (marker === SOS) return { segments: found, imageData: bytes.subarray(offset) };
        const end = offset + MARKER_BYTES + u16be(bytes, offset + MARKER_BYTES);
        return walk(end, [...found, { marker, bytes: bytes.subarray(offset, end) }]);
    };
    return walk(SOI_BYTES, []);
}

// --- PNG ---

const PNG_SIGNATURE_BYTES = 8;
const PNG_LENGTH_BYTES = 4;
const PNG_TYPE_BYTES = 4;
const PNG_CRC_BYTES = 4;
const APNG_FRAMES = 2;
const APNG_LOOP_FOREVER = 0;
const FCTL_BYTES = 26;

export interface PngChunkInfo {
    readonly type: string;
    readonly data: Uint8Array;
    readonly crc: number;
}

export function pngChunks(bytes: Uint8Array): PngChunkInfo[] {
    const walk = (offset: number, found: PngChunkInfo[]): PngChunkInfo[] => {
        if (offset >= bytes.length) return found;
        const length = u32be(bytes, offset);
        const type = String.fromCharCode(...bytes.subarray(offset + PNG_LENGTH_BYTES, offset + PNG_LENGTH_BYTES + PNG_TYPE_BYTES));
        const dataStart = offset + PNG_LENGTH_BYTES + PNG_TYPE_BYTES;
        const chunk = { type, data: bytes.subarray(dataStart, dataStart + length), crc: u32be(bytes, dataStart + length) };
        const next = [...found, chunk];
        return type === 'IEND' ? next : walk(dataStart + length + PNG_CRC_BYTES, next);
    };
    return walk(PNG_SIGNATURE_BYTES, []);
}

export const pngText = {
    exif: (options?: ExifOptions): Uint8Array => pngChunk('eXIf', buildExif(options)),
    tEXt: (): Uint8Array => pngChunk('tEXt', asciiBytes(`Comment\0${SECRETS.pngText}`)),
    zTXt: (): Uint8Array => pngChunk('zTXt', asciiBytes(`Author\0\0${SECRETS.pngText}`)),
    xmp: (options?: XmpOptions): Uint8Array => pngChunk('iTXt', asciiBytes(`XML:com.adobe.xmp\0\0\0\0\0${buildXmp(options)}`)),
    // 2026-10-21 12:34:56: year (2 bytes), month, day, hour, minute, second.
    tIME: (): Uint8Array => pngChunk('tIME', asciiBytes('\x07\xea\x0a\x15\x0c\x22\x38')),
    iCCP: (): Uint8Array => pngChunk('iCCP', asciiBytes('sRGB profile\0\0COMPRESSED-PROFILE')),
    // 2835 pixels per metre (72 dpi) both ways, unit: metres.
    pHYs: (): Uint8Array => pngChunk('pHYs', asciiBytes('\0\0\x0b\x13\0\0\x0b\x13\x01')),
    acTL: (): Uint8Array => pngChunk('acTL', concatBytes(uint32Bytes(APNG_FRAMES, false), uint32Bytes(APNG_LOOP_FOREVER, false))),
    fcTL: (): Uint8Array => pngChunk('fcTL', new Uint8Array(FCTL_BYTES)),
    fdAT: (): Uint8Array => pngChunk('fdAT', asciiBytes('\0\0\0\x02FRAME-TWO-DATA')),
};

const rawChunk = (chunk: PngChunkInfo): Uint8Array =>
    concatBytes(uint32Bytes(chunk.data.length, false), asciiBytes(chunk.type), chunk.data, uint32Bytes(chunk.crc, false));

/** The base PNG with `beforeIdat` chunks after IHDR, `afterIdat` chunks before IEND, and `trailing` bytes after it. */
export function buildPng(beforeIdat: readonly Uint8Array[], afterIdat: readonly Uint8Array[] = [], trailing: readonly Uint8Array[] = []): Uint8Array {
    const chunks = pngChunks(BASE_PNG);
    const header = chunks.filter((chunk) => chunk.type === 'IHDR').map(rawChunk);
    const image = chunks.filter((chunk) => chunk.type !== 'IHDR' && chunk.type !== 'IEND').map(rawChunk);
    const end = chunks.filter((chunk) => chunk.type === 'IEND').map(rawChunk);
    return concatBytes(BASE_PNG.subarray(0, PNG_SIGNATURE_BYTES), ...header, ...beforeIdat, ...image, ...afterIdat, ...end, ...trailing);
}

// --- WebP ---

const RIFF_HEADER_BYTES = 12;
const RIFF_SIZE_FIELD_END = 8;
const FOURCC_BYTES = 4;
const WEBP_CHUNK_HEADER_BYTES = 8;
export const VP8X_ICC = 0x20;
export const VP8X_EXIF = 0x08;
export const VP8X_XMP = 0x04;
export const VP8X_ANIMATION = 0x02;
const ANIM_BYTES = 6;
const ANMF_HEADER_BYTES = 16;

export interface WebpChunkInfo {
    readonly type: string;
    readonly data: Uint8Array;
}

export function webpChunks(bytes: Uint8Array): WebpChunkInfo[] {
    const end = RIFF_SIZE_FIELD_END + u32le(bytes, FOURCC_BYTES);
    const walk = (offset: number, found: WebpChunkInfo[]): WebpChunkInfo[] => {
        if (offset >= end) return found;
        const type = String.fromCharCode(...bytes.subarray(offset, offset + FOURCC_BYTES));
        const size = u32le(bytes, offset + FOURCC_BYTES);
        const dataStart = offset + WEBP_CHUNK_HEADER_BYTES;
        return walk(dataStart + size + (size & ODD), [...found, { type, data: bytes.subarray(dataStart, dataStart + size) }]);
    };
    return walk(RIFF_HEADER_BYTES, []);
}

export const webpChunk = (type: string, data: Uint8Array): Uint8Array =>
    concatBytes(asciiBytes(type), uint32Bytes(data.length, true), data, new Uint8Array(data.length & ODD));

export const webpExtras = {
    exif: (options?: ExifOptions): Uint8Array => webpChunk('EXIF', buildExif(options)),
    xmp: (options?: XmpOptions): Uint8Array => webpChunk('XMP ', asciiBytes(buildXmp(options))),
};

/**
 * The base WebP with `extraFlags` set in VP8X and `extra` chunks after its image. `animated` replaces the still image
 * with an ANIM chunk and two ANMF frames, as an animated WebP has.
 */
export function buildWebp(extraFlags: number, extra: readonly Uint8Array[], { animated = false }: { animated?: boolean } = {}): Uint8Array {
    const chunks = webpChunks(BASE_WEBP);
    const vp8x = chunks.find((chunk) => chunk.type === 'VP8X')!;
    const flags = vp8x.data[0] | extraFlags | (animated ? VP8X_ANIMATION : 0);
    const image = chunks.find((chunk) => chunk.type === 'VP8 ')!;
    const imageChunks = animated
        ? [
            webpChunk('ANIM', new Uint8Array(ANIM_BYTES)),
            webpChunk('ANMF', concatBytes(new Uint8Array(ANMF_HEADER_BYTES), webpChunk('VP8 ', image.data))),
            webpChunk('ANMF', asciiBytes('SECOND-FRAME-0000')),
        ]
        : [webpChunk('VP8 ', image.data)];
    const body = concatBytes(
        webpChunk('VP8X', concatBytes(Uint8Array.of(flags), vp8x.data.subarray(1))),
        ...chunks.filter((chunk) => chunk.type === 'ICCP').map((chunk) => webpChunk(chunk.type, chunk.data)),
        ...imageChunks,
        ...extra,
    );
    return concatBytes(asciiBytes('RIFF'), uint32Bytes(body.length + FOURCC_BYTES, true), asciiBytes('WEBP'), body);
}

/** A File of `bytes`, as the browser would hand it to the page. */
export const asFile = (bytes: Uint8Array, name: string, type: string): File =>
    new File([bytes as BlobPart], name, { type, lastModified: LAST_MODIFIED });

const LAST_MODIFIED = Date.parse('2026-10-21T08:00:00Z');

/** The bytes of a Blob. */
export const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

import { asciiBytes, concatBytes, MetadataParseError, readUint, startsWithAscii, uint16Bytes, uint32Bytes } from './bytes';

/**
 * EXIF is a TIFF structure: a byte-order mark ("II" little-endian, "MM" big-endian), the number 42, and the offset of
 * the first directory (IFD0). Each directory lists 12-byte entries: tag, type, count, then the value itself when it
 * fits in 4 bytes, or else the offset of the value.
 */
const LITTLE_ENDIAN_MARK = 'II';
const BIG_ENDIAN_MARK = 'MM';
const TIFF_MAGIC = 42;
const TIFF_HEADER_BYTES = 8;
const MAGIC_OFFSET = 2;
const IFD0_POINTER_OFFSET = 4;
const ENTRY_COUNT_BYTES = 2;
const ENTRY_BYTES = 12;
const ENTRY_TYPE_OFFSET = 2;
const ENTRY_COUNT_OFFSET = 4;
const ENTRY_VALUE_OFFSET = 8;
const NEXT_IFD_POINTER_BYTES = 4;
const UINT16 = 2;
const UINT32 = 4;
// A real IFD0 or GPS directory has a few dozen entries; anything past this is a damaged or hostile file.
const MAX_ENTRIES = 1000;

const TAG_ORIENTATION = 0x0112;
const TAG_GPS_IFD = 0x8825;
const TAG_GPS_LATITUDE = 0x0002;
const TAG_GPS_LONGITUDE = 0x0004;
const TYPE_SHORT = 3;
const TYPE_RATIONAL = 5;
const RATIONAL_BYTES = 8;
const COORDINATE_PARTS = 3;
const MIN_ORIENTATION = 1;
const MAX_ORIENTATION = 8;
/** The orientation that needs no rotation: no EXIF is written back for it. */
export const UPRIGHT = 1;

/** The "Exif\0\0" that starts EXIF in a JPEG APP1 segment (and, from some tools, in a WebP EXIF chunk). */
export const EXIF_PREFIX = 'Exif\0\0';

export interface ExifInfo {
    /** 1–8 when the photo records one; undefined otherwise. */
    readonly orientation?: number;
    /** The GPS section holds coordinates (a latitude or longitude that isn't all zeros). */
    readonly hasLocation: boolean;
}

interface IfdEntry {
    readonly tag: number;
    readonly type: number;
    readonly count: number;
    /** Offset of the entry's value field, within the TIFF data. */
    readonly valueOffset: number;
}

/** The entries of the directory at `offset`. */
function readIfd(tiff: Uint8Array, offset: number, littleEndian: boolean): IfdEntry[] {
    const count = readUint(tiff, offset, UINT16, littleEndian);
    if (count > MAX_ENTRIES) {
        throw new MetadataParseError(`An EXIF directory claims ${count} entries.`);
    }
    const entriesStart = offset + ENTRY_COUNT_BYTES;
    if (entriesStart + count * ENTRY_BYTES + NEXT_IFD_POINTER_BYTES > tiff.length) {
        throw new MetadataParseError('An EXIF directory runs past the end of its section.');
    }
    return Array.from({ length: count }, (_, index) => {
        const entry = entriesStart + index * ENTRY_BYTES;
        return {
            tag: readUint(tiff, entry, UINT16, littleEndian),
            type: readUint(tiff, entry + ENTRY_TYPE_OFFSET, UINT16, littleEndian),
            count: readUint(tiff, entry + ENTRY_COUNT_OFFSET, UINT32, littleEndian),
            valueOffset: entry + ENTRY_VALUE_OFFSET,
        };
    });
}

/**
 * Whether a GPS latitude or longitude entry holds a real coordinate. Cameras without a fix sometimes write 0/1, 0/1,
 * 0/1. An entry that can't be read is counted as a location: better a needless warning than a missed one.
 */
function holdsCoordinate(tiff: Uint8Array, entry: IfdEntry, littleEndian: boolean): boolean {
    if (entry.type !== TYPE_RATIONAL || entry.count < COORDINATE_PARTS) return true;
    try {
        const valuesAt = readUint(tiff, entry.valueOffset, UINT32, littleEndian);
        return Array.from({ length: COORDINATE_PARTS }, (_, part) =>
            readUint(tiff, valuesAt + part * RATIONAL_BYTES, UINT32, littleEndian)).some((numerator) => numerator !== 0);
    } catch {
        return true;
    }
}

/** Reads the orientation and whether there is a location, from TIFF data (EXIF without its "Exif\0\0" prefix). */
export function readExif(tiff: Uint8Array): ExifInfo {
    const littleEndian = startsWithAscii(tiff, LITTLE_ENDIAN_MARK);
    if (!littleEndian && !startsWithAscii(tiff, BIG_ENDIAN_MARK)) {
        throw new MetadataParseError('EXIF data has no TIFF byte-order mark.');
    }
    if (readUint(tiff, MAGIC_OFFSET, UINT16, littleEndian) !== TIFF_MAGIC) {
        throw new MetadataParseError('EXIF data is not TIFF.');
    }

    const ifd0 = readIfd(tiff, readUint(tiff, IFD0_POINTER_OFFSET, UINT32, littleEndian), littleEndian);

    const orientationEntry = ifd0.find((entry) => entry.tag === TAG_ORIENTATION && entry.type === TYPE_SHORT);
    const orientationValue = orientationEntry ? readUint(tiff, orientationEntry.valueOffset, UINT16, littleEndian) : undefined;
    const orientation = orientationValue !== undefined && orientationValue >= MIN_ORIENTATION && orientationValue <= MAX_ORIENTATION
        ? orientationValue
        : undefined;

    const gpsPointer = ifd0.find((entry) => entry.tag === TAG_GPS_IFD);
    const gps = gpsPointer ? readIfd(tiff, readUint(tiff, gpsPointer.valueOffset, UINT32, littleEndian), littleEndian) : [];
    const hasLocation = gps.some((entry) =>
        (entry.tag === TAG_GPS_LATITUDE || entry.tag === TAG_GPS_LONGITUDE) && holdsCoordinate(tiff, entry, littleEndian));

    return { orientation, hasLocation };
}

/** TIFF data without the "Exif\0\0" prefix some writers put in front of it. */
export const withoutExifPrefix = (data: Uint8Array): Uint8Array =>
    startsWithAscii(data, EXIF_PREFIX) ? data.subarray(EXIF_PREFIX.length) : data;

/**
 * The smallest EXIF that keeps a photo's orientation: a big-endian TIFF header and one directory with one entry,
 * 26 bytes in all. Nothing else from the original (no GPS, device or time) is carried over.
 */
export function minimalOrientationExif(orientation: number): Uint8Array {
    const bigEndian = false;
    const singleEntry = 1;
    const noNextIfd = 0;
    // A SHORT fills the first 2 of the 4 value bytes; the other 2 are padding.
    const valuePadding = 0;
    return concatBytes(
        asciiBytes(BIG_ENDIAN_MARK),
        uint16Bytes(TIFF_MAGIC, bigEndian),
        uint32Bytes(TIFF_HEADER_BYTES, bigEndian),
        uint16Bytes(singleEntry, bigEndian),
        uint16Bytes(TAG_ORIENTATION, bigEndian),
        uint16Bytes(TYPE_SHORT, bigEndian),
        uint32Bytes(singleEntry, bigEndian),
        uint16Bytes(orientation, bigEndian),
        uint16Bytes(valuePadding, bigEndian),
        uint32Bytes(noNextIfd, bigEndian),
    );
}

/** Whether a photo with this orientation needs it written back after its EXIF is removed. */
export const needsOrientation = (orientation: number | undefined): orientation is number =>
    orientation !== undefined && orientation !== UPRIGHT;

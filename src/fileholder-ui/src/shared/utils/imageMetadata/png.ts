import { ascii, asciiBytes, concatBytes, FileAssembler, MetadataParseError, readBytes, u32be, uint32Bytes } from './bytes';
import { minimalOrientationExif, needsOrientation, readExif, withoutExifPrefix } from './exif';
import { decodeText, type FormatScan, MAX_INSPECTED_BYTES, MAX_SECTIONS } from './formatScan';
import { xmpHasLocation } from './xmp';

/**
 * A PNG is an 8-byte signature and then chunks: a 4-byte big-endian length, a 4-character type, the data and a CRC
 * over type and data. Each chunk has its own CRC, so dropping some leaves the others valid. Metadata chunks may come
 * after the image data, so every chunk header is read (8 bytes each), but no image data is.
 */
const SIGNATURE_BYTES = 8;
const LENGTH_BYTES = 4;
const TYPE_BYTES = 4;
const CRC_BYTES = 4;
const CHUNK_HEADER_BYTES = LENGTH_BYTES + TYPE_BYTES;
const CHUNK_OVERHEAD_BYTES = CHUNK_HEADER_BYTES + CRC_BYTES;
// The PNG specification caps chunk lengths at 2^31 - 1.
const MAX_CHUNK_LENGTH = 0x7fffffff;
const END_CHUNK = 'IEND';

const XMP_KEYWORD = 'XML:com.adobe.xmp';
const TEXT_SEPARATOR = 0;
const UNCOMPRESSED = 0;
// iTXt: keyword \0, compression flag, compression method, language tag \0, translated keyword \0, text.
const ITXT_FLAG_FIELDS = 2;

/** Chunks removed, and what to call them. Everything else (colour profile, animation, physical size…) stays. */
const REMOVED_CHUNKS: Readonly<Record<string, string>> = {
    eXIf: 'EXIF',
    tEXt: 'Text',
    zTXt: 'Text',
    iTXt: 'Text',
    tIME: 'Timestamp',
};

const CRC_POLYNOMIAL = 0xedb88320;
const CRC_INITIAL = 0xffffffff;
const BITS_PER_BYTE = 8;
const BYTE_VALUES = 256;
const BYTE_MASK = 0xff;
let crcTable: readonly number[] | null = null;

/** The standard CRC-32 that PNG chunks carry. */
export function crc32(data: Uint8Array): number {
    crcTable ??= Array.from({ length: BYTE_VALUES }, (_, n) =>
        Array.from({ length: BITS_PER_BYTE }).reduce<number>((c) => ((c & 1) ? (CRC_POLYNOMIAL ^ (c >>> 1)) : (c >>> 1)), n));
    const table = crcTable;
    return (data.reduce((crc, byte) => table[(crc ^ byte) & BYTE_MASK] ^ (crc >>> BITS_PER_BYTE), CRC_INITIAL) ^ CRC_INITIAL) >>> 0;
}

/** A complete PNG chunk of `type` holding `data`. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const typeAndData = concatBytes(asciiBytes(type), data);
    return concatBytes(uint32Bytes(data.length, false), typeAndData, uint32Bytes(crc32(typeAndData), false));
}

/** The text of an uncompressed iTXt chunk, or undefined when it is compressed or malformed. */
function itxtText(data: Uint8Array): string | undefined {
    const keywordEnd = data.indexOf(TEXT_SEPARATOR);
    if (keywordEnd < 0 || data[keywordEnd + 1] !== UNCOMPRESSED) return undefined;
    const languageEnd = data.indexOf(TEXT_SEPARATOR, keywordEnd + 1 + ITXT_FLAG_FIELDS);
    const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(TEXT_SEPARATOR, languageEnd + 1);
    return translatedEnd < 0 ? undefined : decodeText(data.subarray(translatedEnd + 1));
}

class PngScanner {
    private readonly assembler: FileAssembler;
    private readonly removed = new Set<string>();
    private hasLocation = false;
    private orientationWritten = false;
    private readonly file: Blob;

    constructor(file: Blob) {
        this.file = file;
        this.assembler = new FileAssembler(file);
    }

    async scan(): Promise<FormatScan> {
        this.assembler.keep(0, SIGNATURE_BYTES);
        await this.walk(SIGNATURE_BYTES, 0);
        return { removed: [...this.removed], hasLocation: this.hasLocation, isMotionPhoto: false, parts: this.assembler.build() };
    }

    private async walk(offset: number, count: number): Promise<void> {
        if (count > MAX_SECTIONS) {
            throw new MetadataParseError('Too many PNG chunks.');
        }
        const header = await readBytes(this.file, offset, CHUNK_HEADER_BYTES);
        const length = u32be(header, 0);
        const type = ascii(header, LENGTH_BYTES, TYPE_BYTES);
        const end = offset + CHUNK_OVERHEAD_BYTES + length;
        if (length > MAX_CHUNK_LENGTH || end > this.file.size) {
            throw new MetadataParseError(`The PNG chunk "${type}" at ${offset} runs past the end of the file.`);
        }

        const label = REMOVED_CHUNKS[type];
        if (label === undefined) {
            this.assembler.keep(offset, end);
        } else {
            this.removed.add(await this.inspect(type, offset + CHUNK_HEADER_BYTES, length, label));
        }

        if (type !== END_CHUNK) return this.walk(end, count + 1);
        // Anything after IEND isn't part of the image; some tools hide data there.
        if (end < this.file.size) this.removed.add('Data after the image');
    }

    /** Looks inside a removed chunk for a location (and, in eXIf, the orientation); returns its label. */
    private async inspect(type: string, dataStart: number, length: number, label: string): Promise<string> {
        if (length > MAX_INSPECTED_BYTES) return label;
        if (type === 'eXIf') {
            const exif = readExif(withoutExifPrefix(await readBytes(this.file, dataStart, length)));
            this.hasLocation ||= exif.hasLocation;
            if (needsOrientation(exif.orientation) && !this.orientationWritten) {
                this.assembler.add(pngChunk('eXIf', minimalOrientationExif(exif.orientation)));
                this.orientationWritten = true;
            }
            return label;
        }
        if (type === 'iTXt') {
            const data = await readBytes(this.file, dataStart, length);
            if (ascii(data, 0, Math.min(XMP_KEYWORD.length + 1, data.length)) !== `${XMP_KEYWORD}\0`) return label;
            const xmp = itxtText(data);
            this.hasLocation ||= xmp !== undefined && xmpHasLocation(xmp);
            return 'XMP';
        }
        return label;
    }
}

/** Scans a PNG's chunks. Throws MetadataParseError when the file can't be read safely. */
export const scanPng = (file: Blob): Promise<FormatScan> => new PngScanner(file).scan();

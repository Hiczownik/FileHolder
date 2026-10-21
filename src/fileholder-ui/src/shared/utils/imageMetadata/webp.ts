import { ascii, asciiBytes, concatBytes, FileAssembler, MetadataParseError, readBytes, u32le, uint32Bytes } from './bytes';
import { minimalOrientationExif, needsOrientation, readExif, withoutExifPrefix } from './exif';
import { decodeText, type FormatScan, MAX_INSPECTED_BYTES, MAX_SECTIONS } from './formatScan';
import { xmpHasLocation } from './xmp';

/**
 * A WebP is a RIFF file: "RIFF", a 4-byte little-endian size (of everything after it), "WEBP", then chunks of a
 * 4-character type, a 4-byte little-endian size and the data, padded to an even length. Extended files start with a
 * VP8X chunk whose flags say whether EXIF and XMP chunks follow; those flags and the RIFF size are rewritten.
 */
const RIFF = 'RIFF';
const WEBP = 'WEBP';
const RIFF_HEADER_BYTES = 12;
const RIFF_SIZE_OFFSET = 4;
const RIFF_SIZE_FIELD_END = 8;
const FORMAT_OFFSET = 8;
const FOURCC_BYTES = 4;
const CHUNK_HEADER_BYTES = 8;
const VP8X = 'VP8X';
const VP8X_PAYLOAD_BYTES = 10;
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;
const EXIF_CHUNK = 'EXIF';
const XMP_CHUNK = 'XMP ';
const ODD = 1;

/** The chunk's data padded to an even length, as RIFF requires. */
const padded = (size: number): number => size + (size & ODD);

/** A complete WebP chunk of `type` holding `data`. */
const webpChunk = (type: string, data: Uint8Array): Uint8Array =>
    concatBytes(asciiBytes(type), uint32Bytes(data.length, true), data, new Uint8Array(padded(data.length) - data.length));

class WebpScanner {
    // Everything after the VP8X chunk; the RIFF header and VP8X are rebuilt in front of it.
    private readonly body: FileAssembler;
    private readonly removed = new Set<string>();
    private hasLocation = false;
    private orientationWritten = false;
    private vp8x: { readonly start: number; readonly end: number; readonly payload: Uint8Array } | null = null;
    private riffEnd = 0;
    private readonly file: Blob;

    constructor(file: Blob) {
        this.file = file;
        this.body = new FileAssembler(file);
    }

    async scan(): Promise<FormatScan> {
        const header = await readBytes(this.file, 0, RIFF_HEADER_BYTES);
        if (ascii(header, 0, FOURCC_BYTES) !== RIFF || ascii(header, FORMAT_OFFSET, FOURCC_BYTES) !== WEBP) {
            throw new MetadataParseError('Not a WebP file.');
        }
        this.riffEnd = RIFF_SIZE_FIELD_END + u32le(header, RIFF_SIZE_OFFSET);
        if (this.riffEnd < RIFF_HEADER_BYTES || this.riffEnd > this.file.size) {
            throw new MetadataParseError('The WebP\'s RIFF size doesn\'t match the file.');
        }

        await this.walk(RIFF_HEADER_BYTES, 0);
        if (this.riffEnd < this.file.size) this.removed.add('Data after the image');

        return { removed: [...this.removed], hasLocation: this.hasLocation, isMotionPhoto: false, parts: this.assemble() };
    }

    private async walk(offset: number, count: number): Promise<void> {
        if (offset >= this.riffEnd) return;
        if (count > MAX_SECTIONS) {
            throw new MetadataParseError('Too many WebP chunks.');
        }
        const header = await readBytes(this.file, offset, CHUNK_HEADER_BYTES);
        const type = ascii(header, 0, FOURCC_BYTES);
        const size = u32le(header, FOURCC_BYTES);
        const dataStart = offset + CHUNK_HEADER_BYTES;
        if (dataStart + size > this.riffEnd) {
            throw new MetadataParseError(`The WebP chunk "${type}" at ${offset} runs past the end of the file.`);
        }
        // Some writers leave out the padding byte of the very last chunk.
        const end = Math.min(dataStart + padded(size), this.riffEnd);

        if (type === VP8X && count === 0) {
            if (size < VP8X_PAYLOAD_BYTES) throw new MetadataParseError('The WebP\'s VP8X chunk is too short.');
            this.vp8x = { start: offset, end, payload: await readBytes(this.file, dataStart, VP8X_PAYLOAD_BYTES) };
        } else if (type === EXIF_CHUNK) {
            await this.inspectExif(dataStart, size);
            this.removed.add('EXIF');
        } else if (type === XMP_CHUNK) {
            if (size <= MAX_INSPECTED_BYTES) {
                this.hasLocation ||= xmpHasLocation(decodeText(await readBytes(this.file, dataStart, size)));
            }
            this.removed.add('XMP');
        } else {
            this.body.keep(offset, end);
        }
        return this.walk(end, count + 1);
    }

    private async inspectExif(dataStart: number, size: number): Promise<void> {
        if (size > MAX_INSPECTED_BYTES) return;
        const exif = readExif(withoutExifPrefix(await readBytes(this.file, dataStart, size)));
        this.hasLocation ||= exif.hasLocation;
        if (needsOrientation(exif.orientation) && !this.orientationWritten) {
            this.body.add(webpChunk(EXIF_CHUNK, minimalOrientationExif(exif.orientation)));
            this.orientationWritten = true;
        }
    }

    /** The RIFF header with its new size, the VP8X chunk with corrected flags, then everything else. */
    private assemble(): BlobPart[] {
        const vp8xParts = this.rebuiltVp8x();
        const vp8xSize = vp8xParts.reduce((total, part) => total + (part instanceof Blob ? part.size : (part as Uint8Array).length), 0);
        const riffSize = RIFF_HEADER_BYTES - RIFF_SIZE_FIELD_END + vp8xSize + this.body.size;
        const header = concatBytes(asciiBytes(RIFF), uint32Bytes(riffSize, true), asciiBytes(WEBP));
        return [header as BlobPart, ...vp8xParts, ...this.body.build()];
    }

    private rebuiltVp8x(): BlobPart[] {
        if (!this.vp8x) return [];
        const { start, end, payload } = this.vp8x;
        const flags = (payload[0] & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG)) | (this.orientationWritten ? VP8X_EXIF_FLAG : 0);
        const newPayload = concatBytes(Uint8Array.of(flags), payload.subarray(1));
        const headerAndPayloadEnd = start + CHUNK_HEADER_BYTES + VP8X_PAYLOAD_BYTES;
        // Anything past the 10 defined bytes (there shouldn't be any) is kept as it is.
        return [
            this.file.slice(start, start + CHUNK_HEADER_BYTES),
            newPayload as BlobPart,
            this.file.slice(headerAndPayloadEnd, end),
        ];
    }
}

/** Scans a WebP's chunks. Throws MetadataParseError when the file can't be read safely. */
export const scanWebp = (file: Blob): Promise<FormatScan> => new WebpScanner(file).scan();

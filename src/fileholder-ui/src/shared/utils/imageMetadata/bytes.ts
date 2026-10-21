/** Thrown for anything a parser can't make sense of; the file is then left as it is. */
export class MetadataParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MetadataParseError';
    }
}

const UINT16_BYTES = 2;
const UINT32_BYTES = 4;

/**
 * Reads `length` bytes at `start`. Every read goes through here, so no parser can read past the end of the file,
 * and only the bytes asked for are ever loaded.
 */
export async function readBytes(blob: Blob, start: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > blob.size) {
        throw new MetadataParseError(`Read of ${length} bytes at ${start} is outside the file (${blob.size} bytes).`);
    }
    return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

const viewOf = (bytes: Uint8Array, offset: number, size: number): DataView => {
    if (offset < 0 || offset + size > bytes.length) {
        throw new MetadataParseError(`Offset ${offset} is outside a ${bytes.length}-byte section.`);
    }
    return new DataView(bytes.buffer, bytes.byteOffset + offset, size);
};

export const u16be = (bytes: Uint8Array, offset: number): number => viewOf(bytes, offset, UINT16_BYTES).getUint16(0, false);
export const u16le = (bytes: Uint8Array, offset: number): number => viewOf(bytes, offset, UINT16_BYTES).getUint16(0, true);
export const u32be = (bytes: Uint8Array, offset: number): number => viewOf(bytes, offset, UINT32_BYTES).getUint32(0, false);
export const u32le = (bytes: Uint8Array, offset: number): number => viewOf(bytes, offset, UINT32_BYTES).getUint32(0, true);

/** Reads an unsigned 16- or 32-bit value in the given byte order, as TIFF (EXIF) data needs. */
export const readUint = (bytes: Uint8Array, offset: number, size: typeof UINT16_BYTES | typeof UINT32_BYTES, littleEndian: boolean): number =>
    size === UINT16_BYTES
        ? viewOf(bytes, offset, size).getUint16(0, littleEndian)
        : viewOf(bytes, offset, size).getUint32(0, littleEndian);

/** The bytes at `offset` read as Latin-1 text, e.g. a chunk type or a segment's identifier. */
export const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));

/** Whether `bytes` holds exactly `text` (as Latin-1) at `offset`. */
export const startsWithAscii = (bytes: Uint8Array, text: string, offset = 0): boolean =>
    bytes.length >= offset + text.length && ascii(bytes, offset, text.length) === text;

export const asciiBytes = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

export const uint16Bytes = (value: number, littleEndian: boolean): Uint8Array => {
    const bytes = new Uint8Array(UINT16_BYTES);
    new DataView(bytes.buffer).setUint16(0, value, littleEndian);
    return bytes;
};

export const uint32Bytes = (value: number, littleEndian: boolean): Uint8Array => {
    const bytes = new Uint8Array(UINT32_BYTES);
    new DataView(bytes.buffer).setUint32(0, value, littleEndian);
    return bytes;
};

/** The pieces joined into one array. */
export const concatBytes = (...pieces: readonly Uint8Array[]): Uint8Array => {
    const joined = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
    pieces.reduce((offset, piece) => {
        joined.set(piece, offset);
        return offset + piece.length;
    }, 0);
    return joined;
};

/**
 * Collects the pieces of a cleaned file: ranges of the original, which stay unread `Blob` slices (so a large photo
 * costs almost no memory), and small new byte arrays. Touching ranges are merged into one slice.
 */
export class FileAssembler {
    private readonly parts: BlobPart[] = [];
    private pending: { start: number; end: number } | null = null;
    private bytes = 0;
    private readonly source: Blob;

    constructor(source: Blob) {
        this.source = source;
    }

    /** Keeps the original's bytes start..end (end exclusive). */
    keep(start: number, end: number): void {
        if (end <= start) return;
        this.bytes += end - start;
        if (this.pending && this.pending.end === start) {
            this.pending = { start: this.pending.start, end };
            return;
        }
        this.flush();
        this.pending = { start, end };
    }

    /** Adds new bytes, e.g. a minimal EXIF section that keeps the photo's orientation. */
    add(data: Uint8Array): void {
        this.flush();
        this.parts.push(data as BlobPart);
        this.bytes += data.length;
    }

    get size(): number {
        return this.bytes;
    }

    build(): BlobPart[] {
        this.flush();
        return [...this.parts];
    }

    private flush(): void {
        if (!this.pending) return;
        this.parts.push(this.source.slice(this.pending.start, this.pending.end));
        this.pending = null;
    }
}

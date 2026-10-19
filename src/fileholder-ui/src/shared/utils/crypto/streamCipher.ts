import { base64Url } from './cryptoUtils';

/**
 * Chunked AES-GCM ("STREAM", Hoang et al. 2015; the same layout as Tink's streaming AEAD), so files are
 * encrypted and decrypted a chunk at a time instead of whole in memory.
 *
 * A file's ciphertext is only its chunks, each `chunkSize` bytes of plaintext (the last one 0..chunkSize)
 * followed by a 16-byte tag. There is no header: the parameters below live in the file's manifest entry,
 * which the manifest's own AES-GCM authenticates. That keeps chunks aligned with multipart upload parts.
 *
 * Each chunk's nonce is noncePrefix (7 random bytes) | chunk index (4 bytes, big-endian) | last flag (1 byte):
 * - the index stops chunks from being reordered or moved between positions;
 * - the last flag stops truncation (dropping trailing chunks) and extension (appending chunks);
 * - the random prefix keeps nonces unique even if a per-file key were ever reused by mistake.
 * Every chunk also authenticates the format version and chunk size as additional data.
 */

const ALGORITHM = 'AES-GCM';
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const CHUNK_SIZE_MIB = 4;
const MIN_CHUNK_SIZE_KIB = 1;
const MAX_CHUNK_SIZE_MIB = 16;

export const STREAM_FORMAT_VERSION = 1;
export const STREAM_CHUNK_SIZE = CHUNK_SIZE_MIB * BYTES_PER_MIB;
export const STREAM_TAG_BYTES = 16;

// Bounds on a chunk size read from a manifest. The uploader writes the manifest, and the decryptor buffers a
// whole chunk before it can be authenticated, so an unbounded size would let a bundle exhaust memory.
export const MIN_STREAM_CHUNK_SIZE = MIN_CHUNK_SIZE_KIB * BYTES_PER_KIB;
export const MAX_STREAM_CHUNK_SIZE = MAX_CHUNK_SIZE_MIB * BYTES_PER_MIB;

const NONCE_PREFIX_BYTES = 7;
const INDEX_BYTES = 4;
const NONCE_BYTES = NONCE_PREFIX_BYTES + INDEX_BYTES + 1;
const LAST_CHUNK_FLAG = 1;
const MORE_CHUNKS_FLAG = 0;
// The largest value the 4-byte index field holds; past it a nonce would repeat. At 4 MiB per chunk that's 16 PiB.
const MAX_CHUNK_COUNT = 0xffff_ffff;
const AAD_BYTES = 1 + INDEX_BYTES;

export interface StreamParams {
    readonly version: typeof STREAM_FORMAT_VERSION;
    readonly chunkSize: number;
    readonly noncePrefix: Uint8Array;
}

/** How a file's stream parameters are stored in its (encrypted) manifest entry. */
export interface SerializedStreamParams {
    readonly v: number;
    readonly chunkSize: number;
    readonly noncePrefix: string;
}

export function createStreamParams(chunkSize: number = STREAM_CHUNK_SIZE): StreamParams {
    assertValidChunkSize(chunkSize);
    return {
        version: STREAM_FORMAT_VERSION,
        chunkSize,
        noncePrefix: crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_BYTES)),
    };
}

export function serializeStreamParams(params: StreamParams): SerializedStreamParams {
    return { v: params.version, chunkSize: params.chunkSize, noncePrefix: base64Url.encode(params.noncePrefix) };
}

/** Validates parameters read from a manifest, which the uploader controls. */
export function parseStreamParams(serialized: SerializedStreamParams): StreamParams {
    if (serialized.v !== STREAM_FORMAT_VERSION) {
        throw new Error(`Unsupported encryption format version: ${String(serialized.v)}.`);
    }
    assertValidChunkSize(serialized.chunkSize);

    const noncePrefix = base64Url.decode(serialized.noncePrefix);
    if (noncePrefix.byteLength !== NONCE_PREFIX_BYTES) {
        throw new Error('Malformed encryption parameters: the nonce prefix has the wrong length.');
    }

    return { version: STREAM_FORMAT_VERSION, chunkSize: serialized.chunkSize, noncePrefix };
}

function assertValidChunkSize(chunkSize: number): void {
    if (!Number.isInteger(chunkSize) || chunkSize < MIN_STREAM_CHUNK_SIZE || chunkSize > MAX_STREAM_CHUNK_SIZE) {
        throw new Error(`Chunk size must be a whole number of bytes between ${MIN_STREAM_CHUNK_SIZE} and ${MAX_STREAM_CHUNK_SIZE}.`);
    }
}

/** A file always has at least one chunk, so even an empty file carries a tag and can't be forged. */
export function chunkCount(plaintextSize: number, chunkSize: number = STREAM_CHUNK_SIZE): number {
    return Math.max(1, Math.ceil(plaintextSize / chunkSize));
}

/** Known before encrypting, so an upload can be presigned (and its size signed) up front. */
export function encryptedSize(plaintextSize: number, chunkSize: number = STREAM_CHUNK_SIZE): number {
    return plaintextSize + chunkCount(plaintextSize, chunkSize) * STREAM_TAG_BYTES;
}

/** Exported for tests: the nonce for one chunk. */
export function chunkNonce(params: StreamParams, index: number, isLast: boolean): Uint8Array {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNK_COUNT) {
        throw new Error(`Chunk index ${index} is out of range.`);
    }

    const nonce = new Uint8Array(NONCE_BYTES);
    nonce.set(params.noncePrefix, 0);
    new DataView(nonce.buffer).setUint32(NONCE_PREFIX_BYTES, index, false);
    nonce[NONCE_BYTES - 1] = isLast ? LAST_CHUNK_FLAG : MORE_CHUNKS_FLAG;
    return nonce;
}

function additionalData(params: StreamParams): Uint8Array {
    const aad = new Uint8Array(AAD_BYTES);
    aad[0] = params.version;
    new DataView(aad.buffer).setUint32(1, params.chunkSize, false);
    return aad;
}

export async function encryptChunk(
    key: CryptoKey,
    params: StreamParams,
    index: number,
    isLast: boolean,
    plaintext: Uint8Array
): Promise<Uint8Array> {
    const ciphertext = await crypto.subtle.encrypt(
        {
            name: ALGORITHM,
            iv: chunkNonce(params, index, isLast) as BufferSource,
            additionalData: additionalData(params) as BufferSource,
        },
        key,
        plaintext as BufferSource
    );
    return new Uint8Array(ciphertext);
}

export async function decryptChunk(
    key: CryptoKey,
    params: StreamParams,
    index: number,
    isLast: boolean,
    ciphertext: Uint8Array
): Promise<Uint8Array> {
    try {
        const plaintext = await crypto.subtle.decrypt(
            {
                name: ALGORITHM,
                iv: chunkNonce(params, index, isLast) as BufferSource,
                additionalData: additionalData(params) as BufferSource,
            },
            key,
            ciphertext as BufferSource
        );
        return new Uint8Array(plaintext);
    } catch (err: unknown) {
        // WebCrypto reports a failed tag as an OperationError with an empty message.
        throw new Error(`Decryption failed at chunk ${index}: the file is corrupted, incomplete or was tampered with.`, { cause: err });
    }
}

/**
 * Encrypts chunks firstChunk..firstChunk+count-1 of `source`, reading only that part of it. Consecutive
 * ranges concatenate to the same bytes as encrypting the whole file, so each multipart upload part can be
 * encrypted on its own just before it is sent.
 */
export async function encryptChunkRange(
    key: CryptoKey,
    params: StreamParams,
    source: Blob,
    firstChunk: number,
    count: number
): Promise<Uint8Array> {
    const totalChunks = chunkCount(source.size, params.chunkSize);
    if (!Number.isInteger(firstChunk) || !Number.isInteger(count) || firstChunk < 0 || count < 1 || firstChunk + count > totalChunks) {
        throw new Error(`Chunk range ${firstChunk}+${count} is outside this file's ${totalChunks} chunks.`);
    }

    const start = firstChunk * params.chunkSize;
    const plaintext = new Uint8Array(await source.slice(start, Math.min(start + count * params.chunkSize, source.size)).arrayBuffer());

    const encryptedChunks = await Promise.all(
        Array.from({ length: count }, (_, offset) => {
            const index = firstChunk + offset;
            const chunk = plaintext.subarray(offset * params.chunkSize, (offset + 1) * params.chunkSize);
            return encryptChunk(key, params, index, index === totalChunks - 1, chunk);
        })
    );

    const output = new Uint8Array(encryptedChunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    encryptedChunks.reduce((offset, chunk) => {
        output.set(chunk, offset);
        return offset + chunk.byteLength;
    }, 0);
    return output;
}

/**
 * Decrypts a ciphertext stream, emitting each chunk's plaintext only after its tag has been verified.
 *
 * Whether a chunk is the last one is only known once more bytes arrive or the stream ends, so a full chunk is
 * held until then. Memory stays at one chunk whatever the file size. Any failure errors the stream, so a
 * consumer writing to disk can abort instead of keeping a file that looks complete but isn't.
 */
export function createDecryptionStream(key: CryptoKey, params: StreamParams): TransformStream<Uint8Array, Uint8Array> {
    const encryptedChunkSize = params.chunkSize + STREAM_TAG_BYTES;
    const buffer = new Uint8Array(encryptedChunkSize);
    let filled = 0;
    let index = 0;

    const consume = async (piece: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): Promise<void> => {
        if (piece.byteLength === 0) {
            return;
        }

        // More bytes follow a full chunk, so that chunk wasn't the last one.
        if (filled === encryptedChunkSize) {
            controller.enqueue(await decryptChunk(key, params, index, false, buffer));
            index++;
            filled = 0;
        }

        const taken = Math.min(encryptedChunkSize - filled, piece.byteLength);
        buffer.set(piece.subarray(0, taken), filled);
        filled += taken;
        return consume(piece.subarray(taken), controller);
    };

    return new TransformStream<Uint8Array, Uint8Array>({
        transform: (piece, controller) => consume(piece, controller),
        flush: async (controller) => {
            if (filled < STREAM_TAG_BYTES) {
                throw new Error('Decryption failed: the file ends in the middle of a chunk, so it is incomplete.');
            }
            controller.enqueue(await decryptChunk(key, params, index, true, buffer.subarray(0, filled)));
        },
    });
}

import { describe, it, expect } from 'vitest';
import {
    chunkCount,
    chunkNonce,
    createDecryptionStream,
    createStreamParams,
    encryptChunkRange,
    encryptedSize,
    MAX_STREAM_CHUNK_SIZE,
    MIN_STREAM_CHUNK_SIZE,
    parseStreamParams,
    serializeStreamParams,
    STREAM_CHUNK_SIZE,
    STREAM_TAG_BYTES,
    type StreamParams,
} from '../streamCipher';

// Small chunks keep the tests fast while exercising every boundary; one test uses the real 4 MiB size.
const CHUNK = MIN_STREAM_CHUNK_SIZE;
const ENCRYPTED_CHUNK = CHUNK + STREAM_TAG_BYTES;
const PATTERN_MODULUS = 251;
const ODD_PIECE_SIZE = 7;
const PARTIAL_TAIL = 100;
const FULL_CHUNKS_IN_TAMPER_FILE = 3;
const TAMPER_FILE_SIZE = FULL_CHUNKS_IN_TAMPER_FILE * CHUNK + PARTIAL_TAIL; // 4 chunks, the last one partial
const BYTES_TO_CUT = 10;
const NONCE_FLAG_OFFSET = 11;
const CHUNKS_IN_NONCE_TEST = 5;
const DOUBLE = 2;
const AES_KEY_BITS = 256;
const FIRST_INDEX_PAST_THE_FIELD = 0xffff_ffff;
const HALF = 0.5;
const HEX_RADIX = 16;
const DEFAULT_SIZE_TEST_BYTES = DOUBLE * STREAM_CHUNK_SIZE + PARTIAL_TAIL; // two full 4 MiB chunks and a partial one

const generateKey = (): Promise<CryptoKey> =>
    crypto.subtle.generateKey({ name: 'AES-GCM', length: AES_KEY_BITS }, false, ['encrypt', 'decrypt']);

const patternBytes = (size: number): Uint8Array => new Uint8Array(size).map((_, i) => i % PATTERN_MODULUS);

const encryptWhole = (key: CryptoKey, params: StreamParams, plaintext: Uint8Array): Promise<Uint8Array> =>
    encryptChunkRange(key, params, new Blob([plaintext as BlobPart]), 0, chunkCount(plaintext.byteLength, params.chunkSize));

const splitIntoPieces = (bytes: Uint8Array, pieceSize: number): Uint8Array[] =>
    Array.from({ length: Math.ceil(bytes.byteLength / pieceSize) }, (_, i) => bytes.subarray(i * pieceSize, (i + 1) * pieceSize));

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    parts.reduce((offset, part) => {
        output.set(part, offset);
        return offset + part.byteLength;
    }, 0);
    return output;
};

/** Reads into `received` as it goes, so what arrived before an error is still there afterwards. */
const readAll = async (reader: ReadableStreamDefaultReader<Uint8Array>, received: Uint8Array[]): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) return;
    received.push(value);
    return readAll(reader, received);
};

// vitest's toEqual compares typed arrays element by element, which takes seconds for megabytes; digests don't.
const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) => b.toString(HEX_RADIX).padStart(DOUBLE, '0')).join('');

interface DecryptOutcome {
    readonly plaintext: Uint8Array;
    readonly error: unknown;
}

/** Feeds the ciphertext in pieces, the way a network stream delivers it, and collects what comes out. */
const decryptInPieces = async (key: CryptoKey, params: StreamParams, ciphertext: Uint8Array, pieceSize: number): Promise<DecryptOutcome> => {
    const pieces = splitIntoPieces(ciphertext, pieceSize);
    const source = new ReadableStream<Uint8Array>({
        start: (controller) => {
            pieces.forEach((piece) => controller.enqueue(piece));
            controller.close();
        },
    });
    const received: Uint8Array[] = [];
    const reader = source.pipeThrough(createDecryptionStream(key, params)).getReader();

    try {
        await readAll(reader, received);
        return { plaintext: concat(received), error: null };
    } catch (error: unknown) {
        return { plaintext: concat(received), error };
    }
};

const decrypt = async (key: CryptoKey, params: StreamParams, ciphertext: Uint8Array): Promise<Uint8Array> => {
    const { plaintext, error } = await decryptInPieces(key, params, ciphertext, ciphertext.byteLength || 1);
    if (error) throw error;
    return plaintext;
};

const chunkAt = (ciphertext: Uint8Array, index: number): Uint8Array =>
    ciphertext.subarray(index * ENCRYPTED_CHUNK, (index + 1) * ENCRYPTED_CHUNK);

describe('encryptedSize', () => {
    it.each([
        [0, STREAM_TAG_BYTES],
        [1, 1 + STREAM_TAG_BYTES],
        [CHUNK, CHUNK + STREAM_TAG_BYTES],
        [CHUNK + 1, CHUNK + 1 + DOUBLE * STREAM_TAG_BYTES],
    ])('of %i plaintext bytes is %i', (plaintextSize, expected) => {
        expect(encryptedSize(plaintextSize, CHUNK)).toBe(expected);
    });

    it('matches the bytes actually produced', async () => {
        const key = await generateKey();
        const params = createStreamParams(CHUNK);
        const ciphertext = await encryptWhole(key, params, patternBytes(TAMPER_FILE_SIZE));

        expect(ciphertext.byteLength).toBe(encryptedSize(TAMPER_FILE_SIZE, CHUNK));
    });
});

describe('round trip', () => {
    it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, FULL_CHUNKS_IN_TAMPER_FILE * CHUNK])(
        'restores %i bytes, whatever size pieces the ciphertext arrives in',
        async (size) => {
            const key = await generateKey();
            const params = createStreamParams(CHUNK);
            const plaintext = patternBytes(size);
            const ciphertext = await encryptWhole(key, params, plaintext);

            const pieceSizes = [1, ODD_PIECE_SIZE, ENCRYPTED_CHUNK, ciphertext.byteLength];
            const outcomes = await Promise.all(pieceSizes.map((pieceSize) => decryptInPieces(key, params, ciphertext, pieceSize)));

            outcomes.forEach((outcome) => {
                expect(outcome.error).toBeNull();
                expect(outcome.plaintext).toEqual(plaintext);
            });
        }
    );

    it('works with the default 4 MiB chunk size', async () => {
        const key = await generateKey();
        const params = createStreamParams();
        const plaintext = patternBytes(DEFAULT_SIZE_TEST_BYTES);

        const ciphertext = await encryptWhole(key, params, plaintext);

        expect(params.chunkSize).toBe(STREAM_CHUNK_SIZE);
        expect(await sha256Hex(await decrypt(key, params, ciphertext))).toBe(await sha256Hex(plaintext));
    });

    it('encrypts ranges that concatenate to exactly the whole-file ciphertext, so upload parts can be encrypted separately', async () => {
        const key = await generateKey();
        const params = createStreamParams(CHUNK);
        const source = new Blob([patternBytes(TAMPER_FILE_SIZE) as BlobPart]);

        const whole = await encryptChunkRange(key, params, source, 0, chunkCount(TAMPER_FILE_SIZE, CHUNK));
        const inParts = concat([
            await encryptChunkRange(key, params, source, 0, 1),
            await encryptChunkRange(key, params, source, 1, DOUBLE),
            await encryptChunkRange(key, params, source, FULL_CHUNKS_IN_TAMPER_FILE, 1),
        ]);

        expect(inParts).toEqual(whole);
    });

    it('rejects a chunk range outside the file', async () => {
        const key = await generateKey();
        const params = createStreamParams(CHUNK);
        const source = new Blob([patternBytes(CHUNK + 1) as BlobPart]);

        await expect(encryptChunkRange(key, params, source, 1, DOUBLE)).rejects.toThrow('outside');
        await expect(encryptChunkRange(key, params, source, 0, 0)).rejects.toThrow('outside');
    });
});

describe('tampering is always detected', () => {
    const setup = async () => {
        const key = await generateKey();
        const params = createStreamParams(CHUNK);
        const plaintext = patternBytes(TAMPER_FILE_SIZE);
        return { key, params, plaintext, ciphertext: await encryptWhole(key, params, plaintext) };
    };

    it('a flipped byte', async () => {
        const { key, params, ciphertext } = await setup();
        const tampered = ciphertext.slice();
        tampered[ENCRYPTED_CHUNK + 1] ^= 1;

        await expect(decrypt(key, params, tampered)).rejects.toThrow('Decryption failed at chunk 1');
    });

    it('two chunks swapped', async () => {
        const { key, params, ciphertext } = await setup();
        const swapped = concat([chunkAt(ciphertext, 0), chunkAt(ciphertext, DOUBLE), chunkAt(ciphertext, 1), ciphertext.subarray(FULL_CHUNKS_IN_TAMPER_FILE * ENCRYPTED_CHUNK)]);

        await expect(decrypt(key, params, swapped)).rejects.toThrow('Decryption failed');
    });

    it('the last chunk dropped', async () => {
        const { key, params, ciphertext } = await setup();

        await expect(decrypt(key, params, ciphertext.subarray(0, FULL_CHUNKS_IN_TAMPER_FILE * ENCRYPTED_CHUNK)))
            .rejects.toThrow('Decryption failed');
    });

    it('cut off in the middle of a chunk', async () => {
        const { key, params, ciphertext } = await setup();

        await expect(decrypt(key, params, ciphertext.subarray(0, ciphertext.byteLength - BYTES_TO_CUT))).rejects.toThrow('Decryption failed');
    });

    it('a chunk appended', async () => {
        const { key, params, ciphertext } = await setup();

        await expect(decrypt(key, params, concat([ciphertext, chunkAt(ciphertext, 0)]))).rejects.toThrow('Decryption failed');
    });

    it('nothing at all', async () => {
        const { key, params } = await setup();

        await expect(decrypt(key, params, new Uint8Array(0))).rejects.toThrow('incomplete');
    });

    it('a different nonce prefix, chunk size or key', async () => {
        const { key, params, ciphertext } = await setup();
        const otherPrefix = { ...params, noncePrefix: createStreamParams(CHUNK).noncePrefix };
        const otherChunkSize = { ...params, chunkSize: CHUNK * DOUBLE };

        await expect(decrypt(key, otherPrefix, ciphertext)).rejects.toThrow('Decryption failed');
        await expect(decrypt(key, otherChunkSize, ciphertext)).rejects.toThrow('Decryption failed');
        await expect(decrypt(await generateKey(), params, ciphertext)).rejects.toThrow('Decryption failed');
    });

    it('never emits plaintext from the tampered chunk or after it', async () => {
        const { key, params, plaintext, ciphertext } = await setup();
        const tampered = ciphertext.slice();
        tampered[DOUBLE * ENCRYPTED_CHUNK] ^= 1;

        const outcome = await decryptInPieces(key, params, tampered, ODD_PIECE_SIZE);

        // An errored stream drops chunks queued but not yet read, so how many of the two good chunks arrive
        // depends on timing. What must hold: everything received is verified plaintext from before chunk 2.
        expect(outcome.error).toBeInstanceOf(Error);
        expect(outcome.plaintext.byteLength).toBeLessThanOrEqual(DOUBLE * CHUNK);
        expect(outcome.plaintext).toEqual(plaintext.subarray(0, outcome.plaintext.byteLength));
    });
});

describe('nonces', () => {
    it('never repeat across chunks or between a last and a non-last chunk', () => {
        const params = createStreamParams(CHUNK);
        const nonces = Array.from({ length: CHUNKS_IN_NONCE_TEST }, (_, index) => [
            chunkNonce(params, index, false),
            chunkNonce(params, index, true),
        ]).flat().map((nonce) => nonce.join(','));

        expect(new Set(nonces).size).toBe(nonces.length);
        expect(chunkNonce(params, 0, true)[NONCE_FLAG_OFFSET]).toBe(1);
        expect(chunkNonce(params, 0, false)[NONCE_FLAG_OFFSET]).toBe(0);
    });

    it('use a fresh random prefix for every file', () => {
        expect(createStreamParams().noncePrefix).not.toEqual(createStreamParams().noncePrefix);
    });

    it('refuse an index that would overflow', () => {
        expect(() => chunkNonce(createStreamParams(), FIRST_INDEX_PAST_THE_FIELD, false)).toThrow('out of range');
    });
});

describe('stream parameters in the manifest', () => {
    it('survive serialization', () => {
        const params = createStreamParams();

        expect(parseStreamParams(serializeStreamParams(params))).toEqual(params);
    });

    it.each([
        ['an unknown version', { v: DOUBLE }],
        ['a zero chunk size', { chunkSize: 0 }],
        ['a chunk size below the minimum', { chunkSize: MIN_STREAM_CHUNK_SIZE - 1 }],
        ['a chunk size above the maximum', { chunkSize: MAX_STREAM_CHUNK_SIZE + 1 }],
        ['a fractional chunk size', { chunkSize: CHUNK + HALF }],
        ['a short nonce prefix', { noncePrefix: 'AAAAAAAA' }],
    ])('reject %s', (_, override) => {
        const serialized = { ...serializeStreamParams(createStreamParams()), ...override };

        expect(() => parseStreamParams(serialized)).toThrow();
    });
});

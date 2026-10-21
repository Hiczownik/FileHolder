import { describe, expect } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import {
    chunkCount, createDecryptionStream, encryptChunk, encryptChunkRange, encryptedSize, MIN_STREAM_CHUNK_SIZE,
    parseStreamParams, STREAM_TAG_BYTES, type SerializedStreamParams, type StreamParams,
} from '../streamCipher';
import { base64Url } from '../cryptoUtils';

/**
 * Rules the chunked file encryption keeps for any key, nonce prefix, chunk size and plaintext. Chunks are kept small
 * (1–4 KiB) so each run stays quick; the format doesn't depend on the size.
 */

const KEY_BYTES = 32;
const NONCE_PREFIX_BYTES = 7;
const MAX_TEST_CHUNK_SIZE_KIB = 4;
const MAX_TEST_CHUNK_SIZE = MAX_TEST_CHUNK_SIZE_KIB * MIN_STREAM_CHUNK_SIZE;
const LAST_BIT = 7;
const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const TOO_LONG_PREFIX_BYTES = NONCE_PREFIX_BYTES + NONCE_PREFIX_BYTES;
const MAX_FULL_CHUNKS = 3;
const FORMAT_VERSION = 1;
// Each run encrypts and decrypts whole files, so these properties try fewer inputs than the others.
const CRYPTO_RUN_SHARE = 4;
const MIN_CRYPTO_RUNS = 20;
const cryptoRuns = (): number => Math.max(MIN_CRYPTO_RUNS, Math.floor((fc.readConfigureGlobal().numRuns ?? MIN_CRYPTO_RUNS) / CRYPTO_RUN_SHARE));

// Matches the cipher's own failure messages, for corrupted or cut-off ciphertext: "Decryption failed at chunk 2: ..."
// and "Decryption failed: the file ends ..." match; "OperationError" doesn't.
// https://regex101.com/?regex=%5EDecryption%20failed&testString=Decryption%20failed%20at%20chunk%202%0AOperationError
const DECRYPTION_FAILED = /^Decryption failed/;

const importKey = (raw: Uint8Array): Promise<CryptoKey> =>
    crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);

interface TestFile {
    readonly key: Uint8Array;
    readonly noncePrefix: Uint8Array;
    readonly chunkSize: number;
    readonly plaintext: Uint8Array;
    /** How the ciphertext arrives: in pieces of this size, as a network delivers it. */
    readonly pieceSize: number;
}

// Pieces of up to two chunks, so some fill a chunk exactly and some straddle two.
const MAX_PIECE_CHUNKS = 2;

/**
 * A key, the stream settings, and a plaintext of up to 3 full chunks plus a partial one, its length spread evenly
 * (fast-check's own sizes favour short arrays, which would rarely span a chunk). `multiChunk` asks for more than one.
 */
const fileArb = ({ multiChunk = false } = {}): fc.Arbitrary<TestFile> =>
    fc.integer({ min: MIN_STREAM_CHUNK_SIZE, max: MAX_TEST_CHUNK_SIZE }).chain((chunkSize) => fc.record({
        key: fc.uint8Array({ minLength: KEY_BYTES, maxLength: KEY_BYTES }),
        noncePrefix: fc.uint8Array({ minLength: NONCE_PREFIX_BYTES, maxLength: NONCE_PREFIX_BYTES }),
        chunkSize: fc.constant(chunkSize),
        plaintext: fc.integer({ min: multiChunk ? chunkSize + 1 : 0, max: MAX_FULL_CHUNKS * chunkSize + chunkSize - 1 })
            .chain((length) => fc.uint8Array({ minLength: length, maxLength: length })),
        pieceSize: fc.integer({ min: 1, max: MAX_PIECE_CHUNKS * chunkSize }),
    }));

const paramsOf = (file: TestFile, noncePrefix = file.noncePrefix): StreamParams =>
    ({ version: FORMAT_VERSION, chunkSize: file.chunkSize, noncePrefix });

const encryptWhole = async (key: CryptoKey, params: StreamParams, plaintext: Uint8Array): Promise<Uint8Array> =>
    encryptChunkRange(key, params, new Blob([plaintext as BlobPart]), 0, chunkCount(plaintext.byteLength, params.chunkSize));

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    parts.reduce((offset, part) => {
        output.set(part, offset);
        return offset + part.byteLength;
    }, 0);
    return output;
};

const readAll = async (reader: ReadableStreamDefaultReader<Uint8Array>, parts: Uint8Array[]): Promise<Uint8Array> => {
    const { done, value } = await reader.read();
    if (done) return concat(parts);
    parts.push(value);
    return readAll(reader, parts);
};

/** Decrypts `ciphertext` as it would arrive over a network, in pieces of `pieceSize` bytes. */
const decrypt = (key: CryptoKey, params: StreamParams, ciphertext: Uint8Array, pieceSize: number): Promise<Uint8Array> => {
    const pieces = Array.from({ length: Math.ceil(ciphertext.byteLength / pieceSize) }, (_, index) =>
        ciphertext.slice(index * pieceSize, (index + 1) * pieceSize));
    const source = new ReadableStream<Uint8Array>({
        start: (controller) => {
            pieces.forEach((piece) => controller.enqueue(piece));
            controller.close();
        },
    });
    return readAll(source.pipeThrough(createDecryptionStream(key, params)).getReader(), []);
};

/** The encrypted chunks of a ciphertext, each chunkSize + 16 bytes except perhaps the last. */
const chunksOf = (ciphertext: Uint8Array, chunkSize: number): Uint8Array[] => {
    const size = chunkSize + STREAM_TAG_BYTES;
    return Array.from({ length: Math.ceil(ciphertext.byteLength / size) }, (_, index) => ciphertext.slice(index * size, (index + 1) * size));
};

const expectRejected = async (decrypting: Promise<Uint8Array>): Promise<void> => {
    await expect(decrypting).rejects.toThrow(DECRYPTION_FAILED);
};

describe('stream cipher', () => {
    test.prop([fileArb()], { numRuns: cryptoRuns() })('decrypts what it encrypted, however the ciphertext arrives', async (file) => {
        const key = await importKey(file.key);
        const ciphertext = await encryptWhole(key, paramsOf(file), file.plaintext);

        expect(ciphertext.byteLength).toBe(encryptedSize(file.plaintext.byteLength, file.chunkSize));
        expect(await decrypt(key, paramsOf(file), ciphertext, file.pieceSize)).toEqual(file.plaintext);
    });

    test.prop([fileArb(), fc.nat(), fc.integer({ min: 0, max: LAST_BIT })], { numRuns: cryptoRuns() })(
        'detects any single flipped bit', async (file, position, bit) => {
            const key = await importKey(file.key);
            const ciphertext = await encryptWhole(key, paramsOf(file), file.plaintext);
            const tampered = ciphertext.slice();
            tampered[position % tampered.byteLength] ^= 1 << bit;

            await expectRejected(decrypt(key, paramsOf(file), tampered, file.pieceSize));
        });

    test.prop([fileArb({ multiChunk: true })], { numRuns: cryptoRuns() })(
        'detects a file cut short by whole chunks (truncation)', async (file) => {
            const key = await importKey(file.key);
            const chunks = chunksOf(await encryptWhole(key, paramsOf(file), file.plaintext), file.chunkSize);

            await expectRejected(decrypt(key, paramsOf(file), concat(chunks.slice(0, -1)), file.pieceSize));
        });

    test.prop([fileArb(), fc.uint8Array({ maxLength: MIN_STREAM_CHUNK_SIZE })], { numRuns: cryptoRuns() })(
        'detects a valid-looking chunk appended (extension)', async (file, extra) => {
            const key = await importKey(file.key);
            const params = paramsOf(file);
            const ciphertext = await encryptWhole(key, params, file.plaintext);
            // Encrypted under the same key as the next chunk, marked as the last one.
            const appended = await encryptChunk(key, params, chunkCount(file.plaintext.byteLength, file.chunkSize), true, extra);

            await expectRejected(decrypt(key, params, concat([ciphertext, appended]), file.pieceSize));
        });

    test.prop([fileArb({ multiChunk: true }), fc.nat(), fc.nat()], { numRuns: cryptoRuns() })(
        'detects two chunks swapped', async (file, first, second) => {
            const key = await importKey(file.key);
            const chunks = chunksOf(await encryptWhole(key, paramsOf(file), file.plaintext), file.chunkSize);
            const i = first % chunks.length;
            const j = (i + 1 + (second % (chunks.length - 1))) % chunks.length;
            const swapped = chunks.map((chunk, index) => {
                if (index === i) return chunks[j];
                return index === j ? chunks[i] : chunk;
            });

            await expectRejected(decrypt(key, paramsOf(file), concat(swapped), file.pieceSize));
        });

    test.prop([fileArb(), fc.uint8Array({ minLength: NONCE_PREFIX_BYTES, maxLength: NONCE_PREFIX_BYTES }), fc.nat()], { numRuns: cryptoRuns() })(
        'detects a chunk taken from another file under the same key', async (file, otherPrefix, which) => {
            fc.pre(!otherPrefix.every((byte, index) => byte === file.noncePrefix[index]));
            const key = await importKey(file.key);
            const chunks = chunksOf(await encryptWhole(key, paramsOf(file), file.plaintext), file.chunkSize);
            const others = chunksOf(await encryptWhole(key, paramsOf(file, otherPrefix), file.plaintext), file.chunkSize);
            const index = which % chunks.length;
            const mixed = chunks.map((chunk, position) => (position === index ? others[index] : chunk));

            await expectRejected(decrypt(key, paramsOf(file), concat(mixed), file.pieceSize));
        });

    test.prop([fileArb(), fc.array(fc.integer({ min: 1, max: MAX_FULL_CHUNKS + 1 }), { minLength: 1 })], { numRuns: cryptoRuns() })(
        'encrypts consecutive ranges of chunks to the same bytes as the whole file (multipart parts)', async (file, rangeSizes) => {
            const key = await importKey(file.key);
            const params = paramsOf(file);
            const source = new Blob([file.plaintext as BlobPart]);
            const total = chunkCount(file.plaintext.byteLength, file.chunkSize);
            // Consecutive ranges covering every chunk, as multipart parts do.
            const ranges = rangeSizes.reduce<{ first: number; count: number }[]>((taken, size) => {
                const first = taken.reduce((sum, range) => sum + range.count, 0);
                return first >= total ? taken : [...taken, { first, count: Math.min(size, total - first) }];
            }, []);
            const covered = ranges.reduce((sum, range) => sum + range.count, 0);
            const allRanges = covered < total ? [...ranges, { first: covered, count: total - covered }] : ranges;

            const parts = await Promise.all(allRanges.map((range) => encryptChunkRange(key, params, source, range.first, range.count)));

            expect(concat(parts)).toEqual(await encryptWhole(key, params, file.plaintext));
        });
});

describe('encryptedSize', () => {
    test.prop([fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), fc.integer({ min: MIN_STREAM_CHUNK_SIZE, max: MAX_TEST_CHUNK_SIZE })])(
        'adds one tag per chunk, at least one, exactly (while the result is a safe integer)', (size, chunkSize) => {
            const chunks = (BigInt(size) + BigInt(chunkSize) - BIG_ONE) / BigInt(chunkSize);
            const exact = BigInt(size) + (chunks > BIG_ZERO ? chunks : BIG_ONE) * BigInt(STREAM_TAG_BYTES);
            fc.pre(exact <= BigInt(Number.MAX_SAFE_INTEGER));

            expect(BigInt(encryptedSize(size, chunkSize))).toBe(exact);
        });
});

/** Anything a manifest entry could hold in place of the stream settings: right, wrong and nonsense. */
const serializedArb: fc.Arbitrary<SerializedStreamParams> = fc.record({
    v: fc.oneof(fc.constant(FORMAT_VERSION), fc.integer(), fc.double(), fc.constant(Number.NaN)),
    chunkSize: fc.oneof(
        fc.integer({ min: MIN_STREAM_CHUNK_SIZE, max: MAX_TEST_CHUNK_SIZE }),
        fc.integer(),
        fc.double(),
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -0)),
    noncePrefix: fc.oneof(
        fc.uint8Array({ minLength: NONCE_PREFIX_BYTES, maxLength: NONCE_PREFIX_BYTES }).map((bytes) => base64Url.encode(bytes)),
        fc.uint8Array({ maxLength: TOO_LONG_PREFIX_BYTES }).map((bytes) => base64Url.encode(bytes)),
        fc.string(),
        fc.string({ unit: 'binary' })),
}) as fc.Arbitrary<SerializedStreamParams>;

// The errors parseStreamParams itself throws.
// Matches "Unsupported encryption format version: 2." and "Chunk size must be ..."; rejects "InvalidCharacterError".
// https://regex101.com/?regex=%5E(Unsupported%20encryption%20format%20version%7CChunk%20size%20must%20be%7CMalformed%20encryption%20parameters)&testString=Chunk%20size%20must%20be%20a%20whole%20number%0AInvalidCharacterError
const OWN_ERROR = /^(Unsupported encryption format version|Chunk size must be|Malformed encryption parameters)/;

describe('parseStreamParams', () => {
    test.prop([serializedArb])('accepts valid settings, and refuses anything else with its own error', (serialized) => {
        try {
            const params = parseStreamParams(serialized);
            expect(params.chunkSize).toBe(serialized.chunkSize);
            expect(params.noncePrefix).toHaveLength(NONCE_PREFIX_BYTES);
        } catch (err: unknown) {
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message, JSON.stringify(serialized)).toMatch(OWN_ERROR);
        }
    });
});

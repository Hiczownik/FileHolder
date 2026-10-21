import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { useFileDownload } from '../useFileDownload';
import { downloadApi } from '../../api/downloadApi';
import { downloadSessionStore } from '../../services/downloadSessionStore';
import { cryptoEngine } from '../../../../shared/utils/crypto/cryptoUtils';
import { chunkCount, createStreamParams, encryptChunkRange, MIN_STREAM_CHUNK_SIZE, serializeStreamParams, STREAM_TAG_BYTES } from '../../../../shared/utils/crypto/streamCipher';
import { MAX_IN_MEMORY_BYTES, saveStreamToDisk } from '../../../../shared/utils/download/streamSaving';
import type { FileGroupMetadataResponse } from '../../types';

vi.mock('../../../../shared/utils/downloadUtils', () => ({
    saveBlobAsFile: vi.fn(),
    triggerDirectDownload: vi.fn(),
}));

vi.mock('../../../../shared/utils/download/streamSaving', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../shared/utils/download/streamSaving')>()),
    saveStreamToDisk: vi.fn(),
}));

const PASSWORD = 'ZipPass123!';
const SHARE_TOKEN = 'stream_zip_token';
const SESSION_TTL_MS = 900_000;
const CHUNK = MIN_STREAM_CHUNK_SIZE;
const PIECE_SIZE = 500;
const PATTERN_MODULUS = 251;
const FULL_CHUNKS_IN_LARGE_FILE = 3;
const PARTIAL_TAIL = 100;
const LARGE_FILE_BYTES = FULL_CHUNKS_IN_LARGE_FILE * CHUNK + PARTIAL_TAIL;
const SMALL_FILE_BYTES = 50;
const LARGE_SEED = 1;
const SMALL_SEED = 2;

interface PlainFile {
    readonly manifestId: string;
    readonly serverId: string;
    readonly fileName: string;
    readonly bytes: Uint8Array;
}

const pattern = (size: number, seed: number): Uint8Array => new Uint8Array(size).map((_, i) => (i + seed) % PATTERN_MODULUS);

const FILES: readonly PlainFile[] = [
    { manifestId: 'uuid-a', serverId: 'srv-a', fileName: 'report.pdf', bytes: pattern(LARGE_FILE_BYTES, LARGE_SEED) },
    { manifestId: 'uuid-b', serverId: 'srv-b', fileName: 'notes.txt', bytes: pattern(SMALL_FILE_BYTES, SMALL_SEED) },
];

/** `claimedSizeOf` is what the manifest states for each file; by default its real size. */
const buildBundle = async (files: readonly PlainFile[], claimedSizeOf: (file: PlainFile) => number = (file) => file.bytes.byteLength) => {
    const salt = cryptoEngine.generateSalt();
    const { kWrap } = await cryptoEngine.deriveDualKeys(PASSWORD, salt);
    const masterKey = await cryptoEngine.generateKey();
    const encrypted = await Promise.all(files.map(async (file) => {
        const params = createStreamParams(CHUNK);
        const fileKey = await cryptoEngine.deriveFileKey(masterKey, file.manifestId);
        const ciphertext = await encryptChunkRange(fileKey, params, new Blob([file.bytes as BlobPart]), 0, chunkCount(file.bytes.byteLength, CHUNK));
        return { file, params, ciphertext };
    }));

    // An encrypted bundle has no plain title; it arrives encrypted, and only once unlocked.
    const locked: FileGroupMetadataResponse = {
        shareToken: SHARE_TOKEN,
        totalSizeBytes: 0,
        fileCount: files.length,
        requiresPassword: true,
        isUnlocked: false,
        isEncrypted: true,
        keySalt: cryptoEngine.base64Url.encode(salt),
        isExpired: false,
        files: [],
    };
    const unlocked: FileGroupMetadataResponse = {
        ...locked,
        isUnlocked: true,
        encryptedTitle: await cryptoEngine.encryptJson(masterKey, 'Streamed Zip'),
        keyEnvelope: await cryptoEngine.wrapMasterKey(masterKey, kWrap),
        encryptedManifest: await cryptoEngine.encryptJson(masterKey, encrypted.map(({ file, params }) => ({
            id: file.manifestId, fileName: file.fileName, sizeBytes: claimedSizeOf(file), contentType: 'application/octet-stream', stream: serializeStreamParams(params),
        }))),
        files: encrypted.map(({ file, ciphertext }) => ({
            id: file.serverId, fileName: `${file.manifestId}.enc`, sizeBytes: ciphertext.byteLength, contentType: 'application/octet-stream',
        })),
    };
    return { locked, unlocked, ciphertexts: new Map(encrypted.map(({ file, ciphertext }) => [file.serverId, ciphertext])) };
};

const readAll = async (reader: ReadableStreamDefaultReader<Uint8Array>, parts: Uint8Array[]): Promise<Uint8Array[]> => {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
    return readAll(reader, parts);
};

/**
 * Serves each file's ciphertext in pieces, as the network would, recording when each download opens and
 * when it has been read to the end, so the test can tell whether files were fetched one after another.
 */
const serveCiphertexts = (ciphertexts: ReadonlyMap<string, Uint8Array>, events: string[]) => {
    vi.spyOn(downloadApi, 'getDownloadUrl').mockImplementation(async (_token, fileId) => `storage://${fileId}`);
    vi.spyOn(downloadApi, 'openCiphertextStream').mockImplementation(async (url) => {
        const serverId = url.replace('storage://', '');
        const bytes = ciphertexts.get(serverId)!;
        events.push(`open ${serverId}`);
        let offset = 0;
        return new ReadableStream<Uint8Array>({
            pull: (controller) => {
                if (offset >= bytes.byteLength) {
                    events.push(`end ${serverId}`);
                    controller.close();
                    return;
                }
                controller.enqueue(bytes.slice(offset, offset + PIECE_SIZE));
                offset += PIECE_SIZE;
            },
        });
    });
};

const unlockAndDownloadAll = async (bundle: Awaited<ReturnType<typeof buildBundle>>) => {
    vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(bundle.locked);
    vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(bundle.unlocked);
    vi.spyOn(downloadApi, 'openDownloadSession').mockResolvedValue({
        downloadSessionId: 'session', expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(), remainingDownloads: null,
    });

    const { result } = renderHook(() => useFileDownload(SHARE_TOKEN));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.setPassword(PASSWORD));
    await act(async () => {
        await result.current.handleUnlock({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });
    await act(async () => {
        await result.current.handleDownloadAllZip();
    });
    return result;
};

describe('useFileDownload streaming ZIP of an encrypted bundle', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.mocked(saveStreamToDisk).mockReset();
        downloadSessionStore.clear(SHARE_TOKEN);
    });

    it('streams a ZIP of every decrypted file, fetching them one after another in one session', async () => {
        const bundle = await buildBundle(FILES);
        const events: string[] = [];
        serveCiphertexts(bundle.ciphertexts, events);
        let zipBytes = new Uint8Array(0);
        vi.mocked(saveStreamToDisk).mockImplementation(async (open) => {
            zipBytes = new Uint8Array(await new Blob(await readAll((await open()).getReader(), []) as BlobPart[]).arrayBuffer());
            return { method: 'service-worker', skipped: [] };
        });

        const result = await unlockAndDownloadAll(bundle);

        expect(result.current.error).toBeNull();
        // The size handed to the saving method is exactly what was written, ZIP headers included (issue #26).
        expect(vi.mocked(saveStreamToDisk).mock.calls[0][1]).toEqual({ fileName: `Streamed_Zip_${SHARE_TOKEN}.zip`, sizeBytes: zipBytes.byteLength });
        expect(downloadApi.openDownloadSession).toHaveBeenCalledTimes(1);
        // Lazy and sequential: the next file is only fetched once the previous one has been read to the end.
        expect(events).toEqual(['open srv-a', 'end srv-a', 'open srv-b', 'end srv-b']);

        const zip = await JSZip.loadAsync(zipBytes);
        expect(Object.keys(zip.files)).toEqual(FILES.map((file) => file.fileName));
        const contents = await Promise.all(FILES.map((file) => zip.file(file.fileName)!.async('uint8array')));
        expect(contents).toEqual(FILES.map((file) => file.bytes));
    });

    it('fails the ZIP, and shows an error, when a file in it was tampered with', async () => {
        const bundle = await buildBundle(FILES);
        const tampered = bundle.ciphertexts.get('srv-a')!.slice();
        tampered[CHUNK + STREAM_TAG_BYTES] ^= 1;
        serveCiphertexts(new Map([...bundle.ciphertexts, ['srv-a', tampered]]), []);
        vi.mocked(saveStreamToDisk).mockImplementation(async (open) => {
            await readAll((await open()).getReader(), []);
            return { method: 'memory', skipped: [] };
        });

        const result = await unlockAndDownloadAll(bundle);

        expect(result.current.error).toContain('Decryption failed at chunk 1');
    });

    it('refuses a ZIP over what this browser can save in memory, before using up a download', async () => {
        // Each file fits under the cap on its own; together they don't.
        const justOverHalfTheCap = MAX_IN_MEMORY_BYTES / FILES.length + 1;
        const bundle = await buildBundle(FILES, () => justOverHalfTheCap);
        serveCiphertexts(bundle.ciphertexts, []);

        const result = await unlockAndDownloadAll(bundle);

        expect(result.current.error).toContain('can only save up to 1 GB');
        expect(downloadApi.openDownloadSession).not.toHaveBeenCalled();
        expect(saveStreamToDisk).not.toHaveBeenCalled();
    });
});

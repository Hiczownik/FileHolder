import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFileDownload } from '../useFileDownload';
import { downloadApi } from '../../api/downloadApi';
import { downloadSessionStore } from '../../services/downloadSessionStore';
import { cryptoEngine } from '../../../../shared/utils/crypto/cryptoUtils';
import { chunkCount, createStreamParams, encryptChunkRange, MIN_STREAM_CHUNK_SIZE, serializeStreamParams, STREAM_TAG_BYTES } from '../../../../shared/utils/crypto/streamCipher';
import { DownloadCancelledError, MAX_IN_MEMORY_BYTES, saveStreamToDisk } from '../../../../shared/utils/download/streamSaving';
import type { FileGroupMetadataResponse } from '../../types';

vi.mock('../../../../shared/utils/downloadUtils', () => ({
    saveBlobAsFile: vi.fn(),
    triggerDirectDownload: vi.fn(),
}));

vi.mock('../../../../shared/utils/download/streamSaving', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../shared/utils/download/streamSaving')>()),
    saveStreamToDisk: vi.fn(),
}));

const PASSWORD = 'StreamPass123!';
const MANIFEST_ID = 'uuid-stream-file';
const SERVER_ID = 'srv-stream';
const FILE_NAME = 'report.pdf';
const SESSION_TTL_MS = 900_000;
// Small chunks, so a modest file still spans several of them.
const CHUNK = MIN_STREAM_CHUNK_SIZE;
const FULL_CHUNKS = 3;
const PARTIAL_TAIL = 100;
const FILE_SIZE = FULL_CHUNKS * CHUNK + PARTIAL_TAIL;
const PIECE_SIZE = 777;
const PATTERN_MODULUS = 251;

const plaintext = new Uint8Array(FILE_SIZE).map((_, i) => i % PATTERN_MODULUS);

// What a manifest may claim for a file: more than a memory-only browser (as the test environment is) can save.
const OVER_MEMORY_CAP = MAX_IN_MEMORY_BYTES + 1;

/** `claimedSize` is the plaintext size the manifest states; the real content is always FILE_SIZE bytes. */
const buildStreamBundle = async (claimedSize: number = FILE_SIZE) => {
    const salt = cryptoEngine.generateSalt();
    const { kAuth, kWrap } = await cryptoEngine.deriveDualKeys(PASSWORD, salt);
    const masterKey = await cryptoEngine.generateKey();
    const params = createStreamParams(CHUNK);
    const fileKey = await cryptoEngine.deriveFileKey(masterKey, MANIFEST_ID);
    const ciphertext = await encryptChunkRange(fileKey, params, new Blob([plaintext as BlobPart]), 0, chunkCount(FILE_SIZE, CHUNK));
    const manifest = [{ id: MANIFEST_ID, fileName: FILE_NAME, sizeBytes: claimedSize, contentType: 'application/pdf', stream: serializeStreamParams(params) }];

    const locked: FileGroupMetadataResponse = {
        shareToken: 'stream_token',
        title: 'Streamed',
        totalSizeBytes: 0,
        fileCount: 1,
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
        keyEnvelope: await cryptoEngine.wrapMasterKey(masterKey, kWrap),
        encryptedManifest: await cryptoEngine.encryptJson(masterKey, manifest),
        files: [{ id: SERVER_ID, fileName: `${MANIFEST_ID}.enc`, sizeBytes: ciphertext.byteLength, contentType: 'application/octet-stream' }],
    };
    return { locked, unlocked, ciphertext, kAuth };
};

/** Delivers the ciphertext in uneven pieces, the way a network response does. */
const asNetworkStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start: (controller) => {
            Array.from({ length: Math.ceil(bytes.byteLength / PIECE_SIZE) }, (_, i) => bytes.slice(i * PIECE_SIZE, (i + 1) * PIECE_SIZE))
                .forEach((piece) => controller.enqueue(piece));
            controller.close();
        },
    });

const readAll = async (reader: ReadableStreamDefaultReader<Uint8Array>, parts: Uint8Array[]): Promise<Uint8Array[]> => {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
    return readAll(reader, parts);
};

const unlockAndDownload = async (bundle: Awaited<ReturnType<typeof buildStreamBundle>>, ciphertext: Uint8Array) => {
    vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(bundle.locked);
    vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(bundle.unlocked);
    vi.spyOn(downloadApi, 'openDownloadSession').mockResolvedValue({
        downloadSessionId: 'session', expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(), remainingDownloads: null,
    });
    vi.spyOn(downloadApi, 'getDownloadUrl').mockResolvedValue('storage://stream');
    vi.spyOn(downloadApi, 'openCiphertextStream').mockResolvedValue(asNetworkStream(ciphertext));

    const { result } = renderHook(() => useFileDownload(bundle.locked.shareToken));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.setPassword(PASSWORD));
    await act(async () => {
        await result.current.handleUnlock({ preventDefault: vi.fn() } as unknown as React.FormEvent);
    });
    await act(async () => {
        await result.current.handleDownloadFile(SERVER_ID);
    });
    return result;
};

describe('useFileDownload streaming decryption', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.mocked(saveStreamToDisk).mockReset();
        downloadSessionStore.clear('stream_token');
    });

    it('decrypts a chunk-encrypted file as it downloads and hands the plaintext stream to the saver', async () => {
        const bundle = await buildStreamBundle();
        const saved: Uint8Array[] = [];
        vi.mocked(saveStreamToDisk).mockImplementation(async (stream) => {
            saved.push(...(await readAll(stream.getReader(), [])));
            return { method: 'service-worker', skipped: [] };
        });

        const result = await unlockAndDownload(bundle, bundle.ciphertext);

        expect(result.current.error).toBeNull();
        expect(vi.mocked(saveStreamToDisk).mock.calls[0][1]).toEqual({ fileName: FILE_NAME, sizeBytes: FILE_SIZE });
        expect(result.current.lastSaveReport).toBe(`Saved "${FILE_NAME}" via service-worker.`);
        expect(new Uint8Array(await new Blob(saved as BlobPart[]).arrayBuffer())).toEqual(plaintext);
    });

    it('reports decrypted bytes while the download runs, and clears them when it ends', async () => {
        const bundle = await buildStreamBundle();
        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(bundle.locked);
        vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(bundle.unlocked);
        vi.spyOn(downloadApi, 'openDownloadSession').mockResolvedValue({
            downloadSessionId: 'session', expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(), remainingDownloads: null,
        });
        vi.spyOn(downloadApi, 'getDownloadUrl').mockResolvedValue('storage://stream');
        vi.spyOn(downloadApi, 'openCiphertextStream').mockResolvedValue(asNetworkStream(bundle.ciphertext));
        // The saver reads one decrypted chunk, then waits, so the test can look at the progress mid-download.
        let releaseSaver: () => void = () => undefined;
        const saverMayFinish = new Promise<void>((resolve) => { releaseSaver = resolve; });
        vi.mocked(saveStreamToDisk).mockImplementation(async (stream) => {
            const reader = stream.getReader();
            await reader.read();
            await saverMayFinish;
            await readAll(reader, []);
            return { method: 'opfs', skipped: [] };
        });

        const { result } = renderHook(() => useFileDownload(bundle.locked.shareToken));
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        act(() => result.current.setPassword(PASSWORD));
        await act(async () => {
            await result.current.handleUnlock({ preventDefault: vi.fn() } as unknown as React.FormEvent);
        });
        let downloading: Promise<void> = Promise.resolve();
        act(() => {
            downloading = result.current.handleDownloadFile(SERVER_ID);
        });

        await waitFor(() => expect(result.current.downloadProgress).toEqual({ receivedBytes: CHUNK, totalBytes: FILE_SIZE }));

        releaseSaver();
        await act(async () => {
            await downloading;
        });
        expect(result.current.downloadProgress).toBeNull();
        expect(result.current.error).toBeNull();
    });

    it('shows an error when the downloaded file was tampered with', async () => {
        const bundle = await buildStreamBundle();
        const tampered = bundle.ciphertext.slice();
        // The first byte of the second encrypted chunk (each is CHUNK plaintext bytes plus a tag).
        tampered[CHUNK + STREAM_TAG_BYTES] ^= 1;
        vi.mocked(saveStreamToDisk).mockImplementation(async (stream) => {
            await readAll(stream.getReader(), []);
            return { method: 'memory', skipped: [] };
        });

        const result = await unlockAndDownload(bundle, tampered);

        expect(result.current.error).toContain('Decryption failed at chunk 1');
    });

    it('treats a cancelled download as the user\'s choice, not an error', async () => {
        const bundle = await buildStreamBundle();
        vi.mocked(saveStreamToDisk).mockRejectedValue(new DownloadCancelledError());

        const result = await unlockAndDownload(bundle, bundle.ciphertext);

        expect(result.current.error).toBeNull();
    });

    it('refuses a file this browser can only save in memory, before using up a download', async () => {
        const bundle = await buildStreamBundle(OVER_MEMORY_CAP);

        const result = await unlockAndDownload(bundle, bundle.ciphertext);

        expect(result.current.error).toContain('can only save up to 1 GB');
        expect(downloadApi.openDownloadSession).not.toHaveBeenCalled();
        expect(downloadApi.getDownloadUrl).not.toHaveBeenCalled();
        expect(saveStreamToDisk).not.toHaveBeenCalled();
    });
});

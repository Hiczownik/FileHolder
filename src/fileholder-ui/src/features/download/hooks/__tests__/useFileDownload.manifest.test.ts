import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFileDownload } from '../useFileDownload';
import { downloadApi } from '../../api/downloadApi';
import { downloadSessionStore } from '../../services/downloadSessionStore';
import { cryptoEngine } from '../../../../shared/utils/crypto/cryptoUtils';
import { chunkCount, createStreamParams, encryptChunkRange, MIN_STREAM_CHUNK_SIZE, serializeStreamParams } from '../../../../shared/utils/crypto/streamCipher';
import { saveStreamToDisk } from '../../../../shared/utils/download/streamSaving';
import type { FileGroupMetadataResponse } from '../../types';
import { openShareLinkWithNewKey } from './linkKeyFixture';
import { FAST_KDF_PARAMS } from '../../../../test/kdf';

vi.mock('../../../../shared/utils/downloadUtils', () => ({
    saveBlobAsFile: vi.fn(),
    triggerDirectDownload: vi.fn(),
}));

vi.mock('../../../../shared/utils/download/streamSaving', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../shared/utils/download/streamSaving')>()),
    saveStreamToDisk: vi.fn(),
}));

const PASSWORD = 'VaultPass123!';
const SHARE_TOKEN = 'e2ee_order_token';
const SESSION_ID = 'e2ee_order_session';
const SESSION_TTL_MS = 900_000;

interface PlainFile {
    readonly manifestId: string;
    readonly serverId: string;
    readonly fileName: string;
    readonly content: string;
}

const FILE_A: PlainFile = { manifestId: 'uuid-file-a', serverId: 'srv-a', fileName: 'doc1.txt', content: 'Payload of the first file' };
const FILE_B: PlainFile = { manifestId: 'uuid-file-b', serverId: 'srv-b', fileName: 'doc2.txt', content: 'Payload of the second file' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// jsdom's Blob has no .stream(), so streams are built by hand.
const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start: (controller) => {
            controller.enqueue(bytes);
            controller.close();
        },
    });

const readAll = async (reader: ReadableStreamDefaultReader<Uint8Array>, parts: Uint8Array[]): Promise<Uint8Array> => {
    const { done, value } = await reader.read();
    if (!done) {
        parts.push(value);
        return readAll(reader, parts);
    }
    return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
};


/**
 * Builds an encrypted bundle exactly like the upload flow does: each file chunk-encrypted with its own key and
 * stream settings, keyed by manifest ID. `withStreamSettings: false` makes a manifest in the older, whole-file
 * format, which can no longer be opened.
 */
const buildEncryptedBundle = async (files: readonly PlainFile[], withStreamSettings = true) => {
    const salt = cryptoEngine.generateSalt();
    const { kWrap } = await openShareLinkWithNewKey(salt, PASSWORD);
    const masterKey = await cryptoEngine.generateKey();

    const encrypted = await Promise.all(files.map(async (file) => {
        const params = createStreamParams(MIN_STREAM_CHUNK_SIZE);
        const fileKey = await cryptoEngine.deriveFileKey(masterKey, file.manifestId);
        const bytes = encoder.encode(file.content);
        const ciphertext = await encryptChunkRange(fileKey, params, new Blob([bytes as BlobPart]), 0, chunkCount(bytes.byteLength, MIN_STREAM_CHUNK_SIZE));
        return { file, params, ciphertext };
    }));
    const ciphertexts = new Map(encrypted.map(({ file, ciphertext }) => [file.serverId, ciphertext]));

    const manifest = encrypted.map(({ file, params }) => ({
        id: file.manifestId,
        fileName: file.fileName,
        sizeBytes: encoder.encode(file.content).byteLength,
        contentType: 'text/plain',
        ...(withStreamSettings ? { stream: serializeStreamParams(params) } : {}),
    }));

    return {
        keySalt: cryptoEngine.base64Url.encode(salt),
        keyEnvelope: await cryptoEngine.wrapMasterKey(masterKey, kWrap),
        encryptedManifest: await cryptoEngine.encryptJson(masterKey, manifest),
        ciphertexts,
    };
};

describe('useFileDownload E2EE manifest-to-file matching', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.mocked(saveStreamToDisk).mockReset();
        downloadSessionStore.clear(SHARE_TOKEN);
    });

    it('decrypts each file with its own key when the server lists files in a different order than the manifest', async () => {
        const bundle = await buildEncryptedBundle([FILE_A, FILE_B]);

        const locked: FileGroupMetadataResponse = {
            shareToken: SHARE_TOKEN,
            title: 'Encrypted Drop',
            totalSizeBytes: 0,
            fileCount: [FILE_A, FILE_B].length,
            requiresPassword: true,
            isUnlocked: false,
            isEncrypted: true,
            keySalt: bundle.keySalt,
            keyMode: 'LinkKeyAndPasskey',
            kdfParams: FAST_KDF_PARAMS,
            isExpired: false,
            files: [],
        };

        // Server order is the reverse of the manifest (upload) order
        const unlocked: FileGroupMetadataResponse = {
            ...locked,
            isUnlocked: true,
            keyEnvelope: bundle.keyEnvelope,
            encryptedManifest: bundle.encryptedManifest,
            files: [FILE_B, FILE_A].map((file) => ({
                id: file.serverId,
                fileName: `${file.manifestId}.enc`,
                sizeBytes: bundle.ciphertexts.get(file.serverId)!.byteLength,
                contentType: 'application/octet-stream',
            })),
        };

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(locked);
        vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(unlocked);
        const openSessionSpy = vi.spyOn(downloadApi, 'openDownloadSession').mockResolvedValue({
            downloadSessionId: SESSION_ID,
            expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
            remainingDownloads: null,
        });
        const urlSpy = vi.spyOn(downloadApi, 'getDownloadUrl').mockImplementation(async (_token, fileId) => `storage://${fileId}`);
        vi.spyOn(downloadApi, 'openCiphertextStream').mockImplementation(
            async (url) => streamOf(bundle.ciphertexts.get(url.replace('storage://', ''))!)
        );
        const saved: (readonly [string, string])[] = [];
        vi.mocked(saveStreamToDisk).mockImplementation(async (open, file) => {
            saved.push([file.fileName, decoder.decode(await readAll((await open()).getReader(), []))]);
            return { method: 'memory', skipped: [] };
        });

        const { result } = renderHook(() => useFileDownload(SHARE_TOKEN));
        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        act(() => {
            result.current.setPassword(PASSWORD);
        });
        await act(async () => {
            await result.current.handleUnlock({ preventDefault: vi.fn() } as unknown as React.FormEvent);
        });

        expect(result.current.error).toBeNull();
        expect(result.current.metadata?.files.map((file) => [file.id, file.fileName])).toEqual([
            [FILE_A.serverId, FILE_A.fileName],
            [FILE_B.serverId, FILE_B.fileName],
        ]);

        await act(async () => {
            await result.current.handleDownloadFile(FILE_B.serverId);
        });

        await act(async () => {
            await result.current.handleDownloadFile(FILE_A.serverId);
        });

        expect(result.current.error).toBeNull();
        expect(saved).toEqual([
            [FILE_B.fileName, FILE_B.content],
            [FILE_A.fileName, FILE_A.content],
        ]);

        // Both files are fetched through the single download session opened by the first click
        expect(openSessionSpy).toHaveBeenCalledTimes(1);
        expect(urlSpy).toHaveBeenCalledWith(SHARE_TOKEN, FILE_B.serverId, SESSION_ID);
        expect(urlSpy).toHaveBeenCalledWith(SHARE_TOKEN, FILE_A.serverId, SESSION_ID);
    });

    it('never sends the passkey itself when the bundle has no derived kAuth', async () => {
        // A different bundle than the other tests, never unlocked in this tab, so it has no kAuth anywhere.
        const neverUnlockedToken = 'e2ee_never_unlocked_token';
        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue({
            shareToken: neverUnlockedToken,
            title: 'Encrypted Drop',
            totalSizeBytes: 0,
            fileCount: 1,
            requiresPassword: true,
            isUnlocked: true,
            isEncrypted: true,
            isExpired: false,
            files: [{ id: FILE_A.serverId, fileName: FILE_A.fileName, sizeBytes: 1, contentType: 'text/plain' }],
        });
        const openSessionSpy = vi.spyOn(downloadApi, 'openDownloadSession');
        // Like a real saving method, opens the download once it is ready to write it.
        vi.mocked(saveStreamToDisk).mockImplementation(async (open) => {
            await (await open()).cancel();
            return { method: 'memory', skipped: [] };
        });

        const { result } = renderHook(() => useFileDownload(neverUnlockedToken));
        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });
        act(() => {
            result.current.setPassword(PASSWORD);
        });

        await act(async () => {
            await result.current.handleDownloadFile(FILE_A.serverId);
        });

        expect(openSessionSpy).not.toHaveBeenCalled();
        expect(result.current.error).toContain('unlocked again');
    });

    it('refuses a bundle in the older whole-file format at unlock, with advice instead of a decryption error', async () => {
        const bundle = await buildEncryptedBundle([FILE_A], false);
        const locked: FileGroupMetadataResponse = {
            shareToken: SHARE_TOKEN,
            title: 'Old Drop',
            totalSizeBytes: 0,
            fileCount: 1,
            requiresPassword: true,
            isUnlocked: false,
            isEncrypted: true,
            keySalt: bundle.keySalt,
            keyMode: 'LinkKeyAndPasskey',
            kdfParams: FAST_KDF_PARAMS,
            isExpired: false,
            files: [],
        };
        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(locked);
        vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue({
            ...locked,
            isUnlocked: true,
            keyEnvelope: bundle.keyEnvelope,
            encryptedManifest: bundle.encryptedManifest,
            files: [{ id: FILE_A.serverId, fileName: `${FILE_A.manifestId}.enc`, sizeBytes: 1, contentType: 'application/octet-stream' }],
        });

        const { result } = renderHook(() => useFileDownload(SHARE_TOKEN));
        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });
        act(() => {
            result.current.setPassword(PASSWORD);
        });
        await act(async () => {
            await result.current.handleUnlock({ preventDefault: vi.fn() } as unknown as React.FormEvent);
        });

        expect(result.current.error).toContain('older version of FileHolder');
        expect(result.current.metadata?.files).toEqual([]);
    });
});

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFileDownload } from '../useFileDownload';
import { downloadApi } from '../../api/downloadApi';
import { downloadSessionStore } from '../../services/downloadSessionStore';
import { cryptoEngine } from '../../../../shared/utils/crypto/cryptoUtils';
import { saveBlobAsFile } from '../../../../shared/utils/downloadUtils';
import type { FileGroupMetadataResponse } from '../../types';

vi.mock('../../../../shared/utils/downloadUtils', () => ({
    saveBlobAsFile: vi.fn(),
    triggerDirectDownload: vi.fn(),
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

/** Builds an encrypted bundle exactly like the upload flow does, keyed by manifest ID. */
const buildEncryptedBundle = async (files: readonly PlainFile[]) => {
    const salt = cryptoEngine.generateSalt();
    const { kWrap } = await cryptoEngine.deriveDualKeys(PASSWORD, salt);
    const masterKey = await cryptoEngine.generateKey();

    const ciphertexts = new Map<string, ArrayBuffer>(
        await Promise.all(files.map(async (file): Promise<[string, ArrayBuffer]> => {
            const fileKey = await cryptoEngine.deriveFileKey(masterKey, file.manifestId);
            const packed = await cryptoEngine.encryptBytes(fileKey, encoder.encode(file.content));
            return [file.serverId, packed.slice().buffer];
        }))
    );

    const manifest = files.map((file) => ({
        id: file.manifestId,
        fileName: file.fileName,
        sizeBytes: encoder.encode(file.content).byteLength,
        contentType: 'text/plain',
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
        vi.mocked(saveBlobAsFile).mockClear();
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
        vi.spyOn(downloadApi, 'downloadCiphertextBlob').mockImplementation(
            async (url) => bundle.ciphertexts.get(url.replace('storage://', ''))!
        );

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
        const saved = await Promise.all(
            vi.mocked(saveBlobAsFile).mock.calls.map(async ([blob, name]) => [name, await blob.text()])
        );
        expect(saved).toEqual([
            [FILE_B.fileName, FILE_B.content],
            [FILE_A.fileName, FILE_A.content],
        ]);

        // Both files are fetched through the single download session opened by the first click
        expect(openSessionSpy).toHaveBeenCalledTimes(1);
        expect(urlSpy).toHaveBeenCalledWith(SHARE_TOKEN, FILE_B.serverId, SESSION_ID);
        expect(urlSpy).toHaveBeenCalledWith(SHARE_TOKEN, FILE_A.serverId, SESSION_ID);
    });
});

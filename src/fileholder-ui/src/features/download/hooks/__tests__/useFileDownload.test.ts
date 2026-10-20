import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { useFileDownload } from '../useFileDownload';
import { downloadApi } from '../../api/downloadApi';
import { cryptoEngine } from '../../../../shared/utils/crypto/cryptoUtils';
import { createStreamParams, serializeStreamParams } from '../../../../shared/utils/crypto/streamCipher';
import type { FileGroupMetadataResponse } from '../../types';

describe('useFileDownload Hook Lifecycle & Cryptographic States', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        window.location.hash = '';
    });

    afterEach(() => {
        window.location.hash = '';
    });

    it('1. Hydrates unencrypted metadata on mount (Happy path)', async () => {
        const mockMetadata: FileGroupMetadataResponse = {
            shareToken: 'token_123',
            title: 'Public Research Papers',
            totalSizeBytes: 300,
            fileCount: 2,
            requiresPassword: false,
            isUnlocked: true,
            isEncrypted: false,
            isExpired: false,
            files: [
                { id: 'f1', fileName: 'paper1.pdf', sizeBytes: 100, contentType: 'application/pdf' },
                { id: 'f2', fileName: 'paper2.pdf', sizeBytes: 200, contentType: 'application/pdf' },
            ],
        };

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(mockMetadata);

        const { result } = renderHook(() => useFileDownload('token_123'));

        expect(result.current.isLoading).toBe(true);

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        expect(result.current.metadata).toEqual(mockMetadata);
        expect(result.current.metadata?.files).toHaveLength(2);
        expect(result.current.error).toBeNull();
    });

    it('2. Challenge-Response: Starts locked, unlocks manifest on handleUnlock()', async () => {
        const lockedMetadata: FileGroupMetadataResponse = {
            shareToken: 'vault_token',
            title: 'Protected Vault',
            totalSizeBytes: 0,
            fileCount: 2,
            requiresPassword: true,
            isUnlocked: false,
            isEncrypted: false,
            isExpired: false,
            files: [],
        };

        const unlockedMetadata: FileGroupMetadataResponse = {
            ...lockedMetadata,
            totalSizeBytes: 500,
            isUnlocked: true,
            files: [
                { id: 'f1', fileName: 'payroll.xlsx', sizeBytes: 500, contentType: 'application/vnd.ms-excel' },
            ],
        };

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(lockedMetadata);
        const unlockSpy = vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(unlockedMetadata);

        const { result } = renderHook(() => useFileDownload('vault_token'));

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        expect(result.current.metadata?.requiresPassword).toBe(true);
        expect(result.current.metadata?.isUnlocked).toBe(false);
        expect(result.current.metadata?.files).toHaveLength(0);

        act(() => {
            result.current.setPassword('VaultPass123!');
        });

        const mockEvent = { preventDefault: vi.fn() } as unknown as React.FormEvent;

        await act(async () => {
            await result.current.handleUnlock(mockEvent);
        });

        expect(unlockSpy).toHaveBeenCalledWith('vault_token', 'VaultPass123!');
        expect(result.current.metadata?.isUnlocked).toBe(true);
        expect(result.current.metadata?.files).toHaveLength(1);
        expect(result.current.metadata?.files[0].fileName).toBe('payroll.xlsx');
    });

    it('3. Zero-Knowledge E2EE: Starts locked, unlocks and decrypts manifest on handleUnlock() with passkey', async () => {
        const password = 'VaultPass123!';
        const salt = cryptoEngine.generateSalt();
        const { kAuth, kWrap } = await cryptoEngine.deriveDualKeys(password, salt);
        const masterKey = await cryptoEngine.generateKey();
        const keyEnvelope = await cryptoEngine.wrapMasterKey(masterKey, kWrap);

        const plaintextManifest = [
            { id: 'file_uuid_1', fileName: 'secret.txt', sizeBytes: 100, contentType: 'text/plain', stream: serializeStreamParams(createStreamParams()) },
        ];
        const encryptedManifestCiphertext = await cryptoEngine.encryptJson(masterKey, plaintextManifest);

        const lockedGroup: FileGroupMetadataResponse = {
            shareToken: 'e2ee_token',
            title: 'Encrypted Drop',
            totalSizeBytes: 0,
            fileCount: 1,
            requiresPassword: true,
            isUnlocked: false,
            isEncrypted: true,
            keySalt: cryptoEngine.base64Url.encode(salt),
            isExpired: false,
            files: [],
        };

        const unlockedGroup: FileGroupMetadataResponse = {
            ...lockedGroup,
            isUnlocked: true,
            keyEnvelope,
            encryptedManifest: encryptedManifestCiphertext,
            files: [
                { id: 'server_blob_1', fileName: 'file_uuid_1.enc', sizeBytes: 128, contentType: 'application/octet-stream' },
            ],
        };

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(lockedGroup);
        const unlockSpy = vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(unlockedGroup);

        const { result } = renderHook(() => useFileDownload('e2ee_token'));

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        expect(result.current.metadata?.requiresPassword).toBe(true);
        expect(result.current.metadata?.isUnlocked).toBe(false);
        expect(result.current.metadata?.files).toHaveLength(0);

        act(() => {
            result.current.setPassword(password);
        });

        const mockEvent = { preventDefault: vi.fn() } as unknown as React.FormEvent;
        await act(async () => {
            await result.current.handleUnlock(mockEvent);
        });

        expect(unlockSpy).toHaveBeenCalledWith('e2ee_token', kAuth);
        expect(result.current.metadata?.isUnlocked).toBe(true);
        expect(result.current.metadata?.files).toHaveLength(1);
        expect(result.current.metadata?.files[0].fileName).toBe('secret.txt');
        expect(result.current.metadata?.totalSizeBytes).toBe(100);
        expect(result.current.error).toBeNull();
    });

    it('4. Zero-Knowledge E2EE: Sets error state when incorrect passkey is provided', async () => {
        const lockedGroup: FileGroupMetadataResponse = {
            shareToken: 'e2ee_token_wrong',
            title: 'Encrypted Drop',
            totalSizeBytes: 0,
            fileCount: 1,
            requiresPassword: true,
            isUnlocked: false,
            isEncrypted: true,
            keySalt: cryptoEngine.base64Url.encode(cryptoEngine.generateSalt()),
            isExpired: false,
            files: [],
        };

        const mock401Error = new AxiosError(
            'Request failed with status code 401',
            'ERR_BAD_REQUEST',
            undefined,
            undefined,
            {
                status: 401,
                statusText: 'Unauthorized',
                data: { detail: 'Incorrect password. Please try again.' },
                headers: {},
                config: { headers: new AxiosHeaders() },
            }
        );

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(lockedGroup);
        vi.spyOn(downloadApi, 'unlockGroup').mockRejectedValue(mock401Error);

        const { result } = renderHook(() => useFileDownload('e2ee_token_wrong'));

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        act(() => {
            result.current.setPassword('WrongPass123!');
        });

        const mockEvent = { preventDefault: vi.fn() } as unknown as React.FormEvent;
        await act(async () => {
            await result.current.handleUnlock(mockEvent);
        });

        expect(result.current.error).toMatch(/incorrect password/i);
        expect(result.current.metadata?.isUnlocked).toBe(false);
    });

    it('5. Zero-Knowledge E2EE: Fails gracefully when key envelope is malformed or corrupted', async () => {
        const password = 'VaultPass123!';
        const salt = cryptoEngine.generateSalt();

        const lockedGroup: FileGroupMetadataResponse = {
            shareToken: 'e2ee_token_corrupt',
            title: 'Encrypted Drop',
            totalSizeBytes: 0,
            fileCount: 1,
            requiresPassword: true,
            isUnlocked: false,
            isEncrypted: true,
            keySalt: cryptoEngine.base64Url.encode(salt),
            isExpired: false,
            files: [],
        };

        const corruptedUnlockedGroup: FileGroupMetadataResponse = {
            ...lockedGroup,
            isUnlocked: true,
            keyEnvelope: 'INVALID_BASE64_OR_CORRUPT_ENVELOPE',
            encryptedManifest: 'dummy_cipher',
            files: [],
        };

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(lockedGroup);
        vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(corruptedUnlockedGroup);

        const { result } = renderHook(() => useFileDownload('e2ee_token_corrupt'));

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        act(() => {
            result.current.setPassword(password);
        });

        const mockEvent = { preventDefault: vi.fn() } as unknown as React.FormEvent;
        await act(async () => {
            await result.current.handleUnlock(mockEvent);
        });

        expect(result.current.error).toMatch(/malformed key envelope|decryption failed|corrupted/i);
    });
});
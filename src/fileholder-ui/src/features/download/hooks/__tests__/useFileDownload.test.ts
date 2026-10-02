import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useFileDownload } from '../useFileDownload';
import { downloadApi } from '../../api/downloadApi';
import { cryptoEngine } from '../../../../shared/utils/crypto/cryptoUtils';
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

    it('3. E2EE: Decrypts manifest when #key=... is present in location.hash', async () => {
        const key = await cryptoEngine.generateKey();
        const base64Key = await cryptoEngine.exportKeyToBase64Url(key);
        window.location.hash = `#key=${base64Key}`;

        const plaintextManifest = [
            { id: 'manifest_1', fileName: 'secret.txt', sizeBytes: 100, contentType: 'text/plain' },
        ];
        const encryptedManifestCiphertext = await cryptoEngine.encryptJson(key, plaintextManifest);

        const encryptedGroup: FileGroupMetadataResponse = {
            shareToken: 'e2ee_token',
            title: 'Encrypted Drop',
            totalSizeBytes: 0,
            fileCount: 1,
            requiresPassword: false,
            isUnlocked: true,
            isEncrypted: true,
            encryptedManifest: encryptedManifestCiphertext,
            isExpired: false,
            files: [
                { id: 'server_blob_1', fileName: 'fileGroup.enc', sizeBytes: 150, contentType: 'application/octet-stream' },
            ],
        };

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(encryptedGroup);

        const { result } = renderHook(() => useFileDownload('e2ee_token'));

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        expect(result.current.error).toBeNull();
        expect(result.current.metadata?.files).toHaveLength(1);
        expect(result.current.metadata?.files[0].fileName).toBe('secret.txt');
        expect(result.current.metadata?.totalSizeBytes).toBe(100);
    });

    it('4. E2EE Negative: Sets error state when #key=... is missing', async () => {
        window.location.hash = '';

        const encryptedGroup: FileGroupMetadataResponse = {
            shareToken: 'e2ee_token_nokey',
            title: 'Encrypted Drop',
            totalSizeBytes: 0,
            fileCount: 1,
            requiresPassword: false,
            isUnlocked: true,
            isEncrypted: true,
            isExpired: false,
            files: [],
        };

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(encryptedGroup);

        const { result } = renderHook(() => useFileDownload('e2ee_token_nokey'));

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        expect(result.current.error).toMatch(/no decryption key was found/i);
        expect(result.current.metadata).toBeNull();
    });

    it('5. E2EE Negative: Rejects malformed Base64Url key gracefully', async () => {
        window.location.hash = '#key=INVALID_CHARACTERS!@#$';

        const encryptedGroup: FileGroupMetadataResponse = {
            shareToken: 'e2ee_token_badkey',
            title: 'Encrypted Drop',
            totalSizeBytes: 0,
            fileCount: 1,
            requiresPassword: false,
            isUnlocked: true,
            isEncrypted: true,
            encryptedManifest: 'dummy_cipher',
            isExpired: false,
            files: [],
        };

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(encryptedGroup);

        const { result } = renderHook(() => useFileDownload('e2ee_token_badkey'));

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        expect(result.current.error).toMatch(/Invalid cryptographic key format|Decryption failed|malformed/i);
        expect(result.current.metadata).toBeNull();
    });
});
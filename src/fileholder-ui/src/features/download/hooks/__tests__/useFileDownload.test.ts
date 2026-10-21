import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { DAMAGED_LINK_MESSAGE, INCOMPLETE_LINK_MESSAGE, useFileDownload, WRONG_PASSKEY_MESSAGE } from '../useFileDownload';
import { downloadApi } from '../../api/downloadApi';
import { linkKeyStore } from '../../services/linkKeyStore';
import { OLD_FORMAT_MESSAGE } from '../../services/bundleDecryptionService';
import { cryptoEngine } from '../../../../shared/utils/crypto/cryptoUtils';
import { createStreamParams, serializeStreamParams } from '../../../../shared/utils/crypto/streamCipher';
import type { FileGroupMetadataResponse, KeyMode } from '../../types';
import { openShareLinkWithNewKey, putLinkKeyInAddressBar } from './linkKeyFixture';

const PASSKEY = 'VaultPass123!';
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const MANIFEST_FILE_BYTES = 100;
const SERVER_FILE_BYTES = 128;
const PAPER_1_BYTES = 100;
const PAPER_2_BYTES = 200;
const PAYROLL_BYTES = 500;
const PUBLIC_FILE_COUNT = 2;
// Characters dropped from the end of a link key, as when a link is cut off while being copied.
const TRUNCATED_CHARS = 2;

const httpError = (status: number, detail: string): AxiosError => new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_REQUEST',
    undefined,
    undefined,
    { status, statusText: '', data: { detail }, headers: {}, config: { headers: new AxiosHeaders() } }
);

const unlockEvent = (): React.FormEvent => ({ preventDefault: vi.fn() }) as unknown as React.FormEvent;

/** A locked encrypted bundle and its unlocked form, encrypted with keys derived from `linkKey` (and `passkey`). */
const buildEncryptedBundle = async (shareToken: string, keyMode: KeyMode, keys: { kWrap: CryptoKey }, salt: Uint8Array) => {
    const masterKey = await cryptoEngine.generateKey();
    const manifest = [
        { id: 'file_uuid_1', fileName: 'secret.txt', sizeBytes: MANIFEST_FILE_BYTES, contentType: 'text/plain', stream: serializeStreamParams(createStreamParams()) },
    ];
    const locked: FileGroupMetadataResponse = {
        shareToken,
        totalSizeBytes: 0,
        fileCount: 1,
        requiresPassword: true,
        isUnlocked: false,
        isEncrypted: true,
        keySalt: cryptoEngine.base64Url.encode(salt),
        keyMode,
        isExpired: false,
        files: [],
    };
    const unlocked: FileGroupMetadataResponse = {
        ...locked,
        isUnlocked: true,
        keyEnvelope: await cryptoEngine.wrapMasterKey(masterKey, keys.kWrap),
        encryptedManifest: await cryptoEngine.encryptJson(masterKey, manifest),
        files: [{ id: 'server_blob_1', fileName: 'file_uuid_1.enc', sizeBytes: SERVER_FILE_BYTES, contentType: 'application/octet-stream' }],
    };
    return { locked, unlocked };
};

const renderLoaded = async (shareToken: string) => {
    const rendered = renderHook(() => useFileDownload(shareToken));
    await waitFor(() => expect(rendered.result.current.isLoading).toBe(false));
    return rendered;
};

describe('useFileDownload Hook Lifecycle & Cryptographic States', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        window.history.replaceState(null, '', '/');
        sessionStorage.clear();
        ['e2ee_token', 'e2ee_token_wrong', 'e2ee_token_corrupt', 'link_token', 'old_token', 'gone_token'].forEach((token) => linkKeyStore.clear(token));
    });

    afterEach(() => {
        window.history.replaceState(null, '', '/');
    });

    it('1. Hydrates unencrypted metadata on mount (Happy path)', async () => {
        const mockMetadata: FileGroupMetadataResponse = {
            shareToken: 'token_123',
            title: 'Public Research Papers',
            totalSizeBytes: PAPER_1_BYTES + PAPER_2_BYTES,
            fileCount: PUBLIC_FILE_COUNT,
            requiresPassword: false,
            isUnlocked: true,
            isEncrypted: false,
            isExpired: false,
            files: [
                { id: 'f1', fileName: 'paper1.pdf', sizeBytes: PAPER_1_BYTES, contentType: 'application/pdf' },
                { id: 'f2', fileName: 'paper2.pdf', sizeBytes: PAPER_2_BYTES, contentType: 'application/pdf' },
            ],
        };

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(mockMetadata);

        const { result } = renderHook(() => useFileDownload('token_123'));

        expect(result.current.isLoading).toBe(true);

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false);
        });

        expect(result.current.metadata).toEqual(mockMetadata);
        expect(result.current.metadata?.files).toHaveLength(PUBLIC_FILE_COUNT);
        expect(result.current.error).toBeNull();
        expect(result.current.promptFor).toBeNull();
    });

    it('2. Challenge-Response: Starts locked, unlocks manifest on handleUnlock()', async () => {
        const lockedMetadata: FileGroupMetadataResponse = {
            shareToken: 'vault_token',
            title: 'Protected Vault',
            totalSizeBytes: 0,
            fileCount: PUBLIC_FILE_COUNT,
            requiresPassword: true,
            isUnlocked: false,
            isEncrypted: false,
            isExpired: false,
            files: [],
        };

        const unlockedMetadata: FileGroupMetadataResponse = {
            ...lockedMetadata,
            totalSizeBytes: PAYROLL_BYTES,
            isUnlocked: true,
            files: [
                { id: 'f1', fileName: 'payroll.xlsx', sizeBytes: PAYROLL_BYTES, contentType: 'application/vnd.ms-excel' },
            ],
        };

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(lockedMetadata);
        const unlockSpy = vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(unlockedMetadata);

        const { result } = await renderLoaded('vault_token');

        expect(result.current.metadata?.requiresPassword).toBe(true);
        expect(result.current.metadata?.isUnlocked).toBe(false);
        expect(result.current.metadata?.files).toHaveLength(0);
        expect(result.current.promptFor).toBe('password');

        act(() => {
            result.current.setPassword('VaultPass123!');
        });

        await act(async () => {
            await result.current.handleUnlock(unlockEvent());
        });

        expect(unlockSpy).toHaveBeenCalledWith('vault_token', 'VaultPass123!');
        expect(result.current.metadata?.isUnlocked).toBe(true);
        expect(result.current.metadata?.files).toHaveLength(1);
        expect(result.current.metadata?.files[0].fileName).toBe('payroll.xlsx');
    });

    it('3. Link key + passkey: asks for the passkey only, and unlocks with keys from both', async () => {
        const salt = cryptoEngine.generateSalt();
        const keys = await openShareLinkWithNewKey(salt, PASSKEY);
        const bundle = await buildEncryptedBundle('e2ee_token', 'LinkKeyAndPasskey', keys, salt);

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(bundle.locked);
        const unlockSpy = vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(bundle.unlocked);

        const { result } = await renderLoaded('e2ee_token');

        expect(result.current.promptFor).toBe('passkey');
        expect(unlockSpy).not.toHaveBeenCalled();

        act(() => {
            result.current.setPassword(PASSKEY);
        });
        await act(async () => {
            await result.current.handleUnlock(unlockEvent());
        });

        expect(unlockSpy).toHaveBeenCalledWith('e2ee_token', keys.kAuth);
        expect(result.current.metadata?.isUnlocked).toBe(true);
        expect(result.current.metadata?.files).toHaveLength(1);
        expect(result.current.metadata?.files[0].fileName).toBe('secret.txt');
        expect(result.current.metadata?.totalSizeBytes).toBe(MANIFEST_FILE_BYTES);
        expect(result.current.error).toBeNull();
    });

    it('4. Link key + passkey: a refused passkey says so, and that the link may be damaged', async () => {
        const salt = cryptoEngine.generateSalt();
        const keys = await openShareLinkWithNewKey(salt, PASSKEY);
        const bundle = await buildEncryptedBundle('e2ee_token_wrong', 'LinkKeyAndPasskey', keys, salt);

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(bundle.locked);
        vi.spyOn(downloadApi, 'unlockGroup').mockRejectedValue(httpError(HTTP_UNAUTHORIZED, 'Incorrect password. Please try again.'));

        const { result } = await renderLoaded('e2ee_token_wrong');

        act(() => {
            result.current.setPassword('WrongPass123!');
        });
        await act(async () => {
            await result.current.handleUnlock(unlockEvent());
        });

        expect(result.current.error).toBe(WRONG_PASSKEY_MESSAGE);
        expect(result.current.metadata?.isUnlocked).toBe(false);
        expect(result.current.promptFor).toBe('passkey');
    });

    it('5. Fails gracefully when the key envelope is malformed or corrupted', async () => {
        const salt = cryptoEngine.generateSalt();
        const keys = await openShareLinkWithNewKey(salt, PASSKEY);
        const bundle = await buildEncryptedBundle('e2ee_token_corrupt', 'LinkKeyAndPasskey', keys, salt);

        vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(bundle.locked);
        vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue({
            ...bundle.unlocked,
            keyEnvelope: 'INVALID_BASE64_OR_CORRUPT_ENVELOPE',
            encryptedManifest: 'dummy_cipher',
            files: [],
        });

        const { result } = await renderLoaded('e2ee_token_corrupt');

        act(() => {
            result.current.setPassword(PASSKEY);
        });
        await act(async () => {
            await result.current.handleUnlock(unlockEvent());
        });

        // https://regex101.com/?regex=malformed%20key%20envelope%7Cdecryption%20failed%7Ccorrupted&flags=i&testString=Malformed%20key%20envelope.%0AWrong%20passkey
        // Any of the three ways a corrupt envelope is reported: matches "Malformed key envelope."; rejects "Wrong passkey".
        expect(result.current.error).toMatch(/malformed key envelope|decryption failed|corrupted/i);
    });

    describe('link keys (#61)', () => {
        it('opens a link-only bundle on its own, and takes the key out of the address bar', async () => {
            const salt = cryptoEngine.generateSalt();
            const keys = await openShareLinkWithNewKey(salt);
            const bundle = await buildEncryptedBundle('link_token', 'LinkKey', keys, salt);

            vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(bundle.locked);
            const unlockSpy = vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(bundle.unlocked);

            const { result } = await renderLoaded('link_token');

            await waitFor(() => expect(result.current.metadata?.isUnlocked).toBe(true));
            expect(unlockSpy).toHaveBeenCalledWith('link_token', keys.kAuth);
            expect(result.current.promptFor).toBeNull();
            expect(result.current.metadata?.files[0].fileName).toBe('secret.txt');
            expect(window.location.hash).toBe('');
            expect(linkKeyStore.get('link_token')).toBe(keys.linkKey);
        });

        it('opens it again after a reload, from the key kept for this tab', async () => {
            const salt = cryptoEngine.generateSalt();
            const keys = await openShareLinkWithNewKey(salt);
            const bundle = await buildEncryptedBundle('link_token', 'LinkKey', keys, salt);
            // The first load took the key out of the address bar; a reload then has none there.
            linkKeyStore.save('link_token', keys.linkKey);
            window.history.replaceState(null, '', '/f/link_token');

            vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(bundle.locked);
            const unlockSpy = vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(bundle.unlocked);

            const { result } = await renderLoaded('link_token');

            await waitFor(() => expect(result.current.metadata?.isUnlocked).toBe(true));
            expect(unlockSpy).toHaveBeenCalledWith('link_token', keys.kAuth);
        });

        it.each<[string, KeyMode, (linkKey: string) => void]>([
            ['missing from a link-only bundle\'s link', 'LinkKey', () => undefined],
            ['missing from a passkey bundle\'s link', 'LinkKeyAndPasskey', () => undefined],
            ['cut short', 'LinkKey', (linkKey) => putLinkKeyInAddressBar(linkKey.slice(0, -TRUNCATED_CHARS))],
        ])('says the link is incomplete, never asks the server, when the key is %s', async (_label, keyMode, placeKey) => {
            const salt = cryptoEngine.generateSalt();
            const keys = await openShareLinkWithNewKey(salt, keyMode === 'LinkKey' ? undefined : PASSKEY);
            const bundle = await buildEncryptedBundle('link_token', keyMode, keys, salt);
            window.history.replaceState(null, '', '/f/link_token');
            placeKey(keys.linkKey);

            vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(bundle.locked);
            const unlockSpy = vi.spyOn(downloadApi, 'unlockGroup');

            const { result } = await renderLoaded('link_token');

            expect(result.current.error).toBe(INCOMPLETE_LINK_MESSAGE);
            expect(result.current.promptFor).toBeNull();
            expect(unlockSpy).not.toHaveBeenCalled();
        });

        it('says the link is damaged when the server refuses a well-formed but wrong key', async () => {
            const salt = cryptoEngine.generateSalt();
            const keys = await cryptoEngine.deriveLinkKeys(cryptoEngine.generateLinkKey(), salt);
            const bundle = await buildEncryptedBundle('link_token', 'LinkKey', keys, salt);
            putLinkKeyInAddressBar(cryptoEngine.generateLinkKey());

            vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(bundle.locked);
            vi.spyOn(downloadApi, 'unlockGroup').mockRejectedValue(httpError(HTTP_UNAUTHORIZED, 'Incorrect password. Please try again.'));

            const { result } = await renderLoaded('link_token');

            await waitFor(() => expect(result.current.error).toBe(DAMAGED_LINK_MESSAGE));
            expect(result.current.promptFor).toBeNull();
        });

        it('refuses an encrypted bundle from before link keys without asking for anything', async () => {
            const salt = cryptoEngine.generateSalt();
            const keys = await openShareLinkWithNewKey(salt, PASSKEY);
            const { locked } = await buildEncryptedBundle('old_token', 'LinkKeyAndPasskey', keys, salt);

            vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue({ ...locked, keyMode: null });
            const unlockSpy = vi.spyOn(downloadApi, 'unlockGroup');

            const { result } = await renderLoaded('old_token');

            expect(result.current.error).toBe(OLD_FORMAT_MESSAGE);
            expect(result.current.promptFor).toBeNull();
            expect(unlockSpy).not.toHaveBeenCalled();
        });

        it('keeps ?diagnostics in the address bar while removing the key', async () => {
            const salt = cryptoEngine.generateSalt();
            const linkKey = cryptoEngine.generateLinkKey();
            const keys = await cryptoEngine.deriveLinkKeys(linkKey, salt);
            const bundle = await buildEncryptedBundle('link_token', 'LinkKey', keys, salt);
            window.history.replaceState(null, '', `/f/link_token?diagnostics#k=${linkKey}`);

            vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(bundle.locked);
            vi.spyOn(downloadApi, 'unlockGroup').mockResolvedValue(bundle.unlocked);

            const { result } = await renderLoaded('link_token');

            await waitFor(() => expect(result.current.metadata?.isUnlocked).toBe(true));
            expect(window.location.pathname).toBe('/f/link_token');
            expect(window.location.search).toBe('?diagnostics');
            expect(window.location.hash).toBe('');
        });

        it('forgets the key once the bundle turns out to be gone or expired', async () => {
            const salt = cryptoEngine.generateSalt();
            const keys = await openShareLinkWithNewKey(salt);
            const bundle = await buildEncryptedBundle('gone_token', 'LinkKey', keys, salt);
            vi.spyOn(downloadApi, 'getGroupMetadata').mockRejectedValue(httpError(HTTP_NOT_FOUND, 'Not found'));

            await renderLoaded('gone_token');
            expect(linkKeyStore.get('gone_token')).toBeNull();

            linkKeyStore.save('gone_token', keys.linkKey);
            vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue({ ...bundle.locked, isExpired: true });
            const unlockSpy = vi.spyOn(downloadApi, 'unlockGroup');

            await renderLoaded('gone_token');
            expect(linkKeyStore.get('gone_token')).toBeNull();
            expect(unlockSpy).not.toHaveBeenCalled();
        });
    });
});

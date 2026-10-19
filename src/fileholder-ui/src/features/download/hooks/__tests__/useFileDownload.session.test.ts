import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { useFileDownload } from '../useFileDownload';
import { downloadApi } from '../../api/downloadApi';
import { downloadSessionStore } from '../../services/downloadSessionStore';
import type { DownloadSessionResponse, FileGroupMetadataResponse } from '../../types';

vi.mock('../../../../shared/utils/downloadUtils', () => ({
    saveBlobAsFile: vi.fn(),
    triggerDirectDownload: vi.fn(),
}));

const HTTP_UNAUTHORIZED = 401;
const SESSION_TTL_MS = 900_000;
const SECONDS_LEFT_ON_EXPIRING_SESSION_MS = 10_000;
const BUNDLE_FILE_COUNT = 2;
const SECOND_CALL = 2;
const FILE_SIZE_BYTES = 1024;
const INITIAL_REMAINING_DOWNLOADS = 3;
const REMAINING_AFTER_SESSION = 2;
const PRESIGNED_URL = 'http://localhost:9000/fileholder-bucket/key?sig=abc';

const createPlainBundle = (shareToken: string): FileGroupMetadataResponse => ({
    shareToken,
    title: 'Session Bundle',
    totalSizeBytes: FILE_SIZE_BYTES * BUNDLE_FILE_COUNT,
    fileCount: BUNDLE_FILE_COUNT,
    requiresPassword: false,
    isUnlocked: true,
    isEncrypted: false,
    isExpired: false,
    remainingDownloads: INITIAL_REMAINING_DOWNLOADS,
    files: [
        { id: 'f1', fileName: 'one.pdf', sizeBytes: FILE_SIZE_BYTES, contentType: 'application/pdf' },
        { id: 'f2', fileName: 'two.pdf', sizeBytes: FILE_SIZE_BYTES, contentType: 'application/pdf' },
    ],
});

const createSession = (downloadSessionId: string): DownloadSessionResponse => ({
    downloadSessionId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    remainingDownloads: REMAINING_AFTER_SESSION,
});

const createUnauthorizedError = (): AxiosError => new AxiosError(
    'Request failed with status code 401',
    'ERR_BAD_REQUEST',
    undefined,
    undefined,
    {
        status: HTTP_UNAUTHORIZED,
        statusText: 'Unauthorized',
        data: { detail: 'The download session is missing or has expired. Start a new download.' },
        headers: {},
        config: { headers: new AxiosHeaders() },
    }
);

const renderLoadedHook = async (shareToken: string) => {
    vi.spyOn(downloadApi, 'getGroupMetadata').mockResolvedValue(createPlainBundle(shareToken));
    const hook = renderHook(() => useFileDownload(shareToken));
    await waitFor(() => {
        expect(hook.result.current.isLoading).toBe(false);
    });
    return hook;
};

describe('useFileDownload per-bundle download sessions', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('opens a single download session for several file downloads of the same bundle', async () => {
        const shareToken = 'session_reuse_token';
        downloadSessionStore.clear(shareToken);
        const openSpy = vi.spyOn(downloadApi, 'openDownloadSession').mockResolvedValue(createSession('session_1'));
        const urlSpy = vi.spyOn(downloadApi, 'getDownloadUrl').mockResolvedValue(PRESIGNED_URL);

        const { result } = await renderLoadedHook(shareToken);

        await act(async () => {
            await result.current.handleDownloadFile('f1');
        });
        await act(async () => {
            await result.current.handleDownloadFile('f2');
        });

        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(urlSpy).toHaveBeenNthCalledWith(1, shareToken, 'f1', 'session_1');
        expect(urlSpy).toHaveBeenNthCalledWith(SECOND_CALL, shareToken, 'f2', 'session_1');
        expect(result.current.metadata?.remainingDownloads).toBe(REMAINING_AFTER_SESSION);
        expect(result.current.error).toBeNull();
    });

    it('replaces a stored session once when the server rejects it as expired', async () => {
        const shareToken = 'session_stale_token';
        downloadSessionStore.save(shareToken, createSession('stale_session'));
        const openSpy = vi.spyOn(downloadApi, 'openDownloadSession').mockResolvedValue(createSession('fresh_session'));
        const urlSpy = vi.spyOn(downloadApi, 'getDownloadUrl')
            .mockRejectedValueOnce(createUnauthorizedError())
            .mockResolvedValueOnce(PRESIGNED_URL);

        const { result } = await renderLoadedHook(shareToken);

        await act(async () => {
            await result.current.handleDownloadFile('f1');
        });

        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(urlSpy).toHaveBeenNthCalledWith(1, shareToken, 'f1', 'stale_session');
        expect(urlSpy).toHaveBeenNthCalledWith(SECOND_CALL, shareToken, 'f1', 'fresh_session');
        expect(result.current.error).toBeNull();
    });

    it('never opens a second session when a freshly opened one is rejected', async () => {
        const shareToken = 'session_rejected_token';
        downloadSessionStore.clear(shareToken);
        const openSpy = vi.spyOn(downloadApi, 'openDownloadSession').mockResolvedValue(createSession('new_session'));
        vi.spyOn(downloadApi, 'getDownloadUrl').mockRejectedValue(createUnauthorizedError());

        const { result } = await renderLoadedHook(shareToken);

        await act(async () => {
            await result.current.handleDownloadFile('f1');
        });

        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(result.current.error).toContain('download session');
    });

    it('uses the bundle download session for the server-side ZIP', async () => {
        const shareToken = 'session_zip_token';
        downloadSessionStore.clear(shareToken);
        const openSpy = vi.spyOn(downloadApi, 'openDownloadSession').mockResolvedValue(createSession('zip_session'));
        const zipSpy = vi.spyOn(downloadApi, 'downloadAllZip').mockReturnValue();

        const { result } = await renderLoadedHook(shareToken);

        await act(async () => {
            await result.current.handleDownloadAllZip();
        });

        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(zipSpy).toHaveBeenCalledWith(shareToken, 'zip_session');
    });

    it('reuses a stored session for the server-side ZIP while it has time left', async () => {
        const shareToken = 'session_zip_reuse_token';
        downloadSessionStore.save(shareToken, createSession('stored_session'));
        const openSpy = vi.spyOn(downloadApi, 'openDownloadSession');
        const zipSpy = vi.spyOn(downloadApi, 'downloadAllZip').mockReturnValue();

        const { result } = await renderLoadedHook(shareToken);

        await act(async () => {
            await result.current.handleDownloadAllZip();
        });

        expect(openSpy).not.toHaveBeenCalled();
        expect(zipSpy).toHaveBeenCalledWith(shareToken, 'stored_session');
    });

    it('opens a fresh session for the server-side ZIP when the stored one is about to expire', async () => {
        // The ZIP is a page navigation: if the session lapsed mid-request, the error would replace the page.
        const shareToken = 'session_zip_expiring_token';
        downloadSessionStore.save(shareToken, {
            downloadSessionId: 'expiring_session',
            expiresAt: new Date(Date.now() + SECONDS_LEFT_ON_EXPIRING_SESSION_MS).toISOString(),
            remainingDownloads: REMAINING_AFTER_SESSION,
        });
        vi.spyOn(downloadApi, 'openDownloadSession').mockResolvedValue(createSession('fresh_session'));
        const zipSpy = vi.spyOn(downloadApi, 'downloadAllZip').mockReturnValue();

        const { result } = await renderLoadedHook(shareToken);

        await act(async () => {
            await result.current.handleDownloadAllZip();
        });

        expect(zipSpy).toHaveBeenCalledWith(shareToken, 'fresh_session');
    });
});

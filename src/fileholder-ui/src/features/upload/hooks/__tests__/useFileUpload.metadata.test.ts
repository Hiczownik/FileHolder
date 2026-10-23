import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileUpload } from '../useFileUpload';
import { uploadApi } from '../../api/uploadApi';
import { cleanPhotos, type CleanedFiles } from '../../services/photoCleaning';
import type { UploadFormValues } from '../../types';

// The real cleaning, wrapped so one test can hold it open to see the "preparing" phase.
vi.mock('../../services/photoCleaning', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../services/photoCleaning')>();
    return { ...actual, cleanPhotos: vi.fn(actual.cleanPhotos) };
});
import {
    asFile, buildJpeg, bytesOf, leakedSecrets, segments,
} from '../../../../shared/utils/imageMetadata/__tests__/photoFixtures';

const EXPIRE_IN_HOURS = 24;
const MAX_DOWNLOADS = 5;
const FORM: UploadFormValues = { title: 'Holiday', expireInHours: EXPIRE_IN_HOURS, maxDownloads: MAX_DOWNLOADS };

/** A promise and its resolve function, so a test can decide when it settles. */
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
};

const photo = (): File => asFile(buildJpeg([segments.exif(), segments.xmp({ gps: true })]), 'IMG_0001.jpg', 'image/jpeg');

/** Fakes the API for a single-file plain upload; returns the spies. */
const fakeApi = () => ({
    presign: vi.spyOn(uploadApi, 'getPresignedUrl').mockResolvedValue({
        uploadToken: 'token',
        items: [{ fileName: 'IMG_0001.jpg', uploadUrl: 'http://storage/put', storageKey: 'uploads/key', uploadMode: 'Single' }],
    }),
    put: vi.spyOn(uploadApi, 'uploadDirectToS3').mockResolvedValue(),
    confirm: vi.spyOn(uploadApi, 'confirmUpload').mockResolvedValue('share_token'),
});

describe('useFileUpload photo metadata removal', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('uploads the cleaned photo, presigned for its cleaned size, and sums up what it removed', async () => {
        const api = fakeApi();
        const original = photo();
        const { result } = renderHook(() => useFileUpload());

        await act(async () => {
            await result.current.upload({ ...FORM, stripImageMetadata: true }, [original]);
        });

        const uploaded = api.put.mock.calls[0][1] as File;
        expect(uploaded.name).toBe(original.name);
        expect(uploaded.type).toBe(original.type);
        expect(uploaded.lastModified).toBe(original.lastModified);
        expect(uploaded.size).toBeLessThan(original.size);
        expect(leakedSecrets(await bytesOf(uploaded))).toEqual([]);
        expect(api.presign.mock.calls[0][0].files[0].sizeBytes).toBe(uploaded.size);
        expect(api.confirm.mock.calls[0][0].files[0].sizeBytes).toBe(uploaded.size);
        expect(result.current.uploadState).toMatchObject({
            status: 'success',
            metadataSummary: { cleaned: 1, notCleaned: [], motionPhotos: 0 },
        });
    });

    it('uploads the original, untouched, when removal is off', async () => {
        const api = fakeApi();
        const original = photo();
        const { result } = renderHook(() => useFileUpload());

        await act(async () => {
            await result.current.upload({ ...FORM, stripImageMetadata: false }, [original]);
        });

        expect(api.put.mock.calls[0][1]).toBe(original);
        expect(api.presign.mock.calls[0][0].files[0].sizeBytes).toBe(original.size);
        expect(result.current.uploadState).toEqual({
            status: 'success',
            shareLink: expect.stringContaining('/f/share_token'),
            bundle: expect.objectContaining({ fileCount: 1, totalBytes: original.size }),
            keyMode: undefined,
            passkey: undefined,
            metadataSummary: undefined,
        });
    });

    it('shows a "preparing" phase while cleaning, which ends before the upload starts', async () => {
        const api = fakeApi();
        const file = photo();
        const cleaning = deferred<CleanedFiles>();
        vi.mocked(cleanPhotos).mockImplementationOnce(() => cleaning.promise);
        const presign = deferred<Awaited<ReturnType<typeof uploadApi.getPresignedUrl>>>();
        api.presign.mockImplementationOnce(() => presign.promise);
        const { result } = renderHook(() => useFileUpload());

        let uploading: Promise<void> = Promise.resolve();
        act(() => {
            uploading = result.current.upload({ ...FORM, stripImageMetadata: true }, [file]);
        });
        await waitFor(() => expect(result.current.uploadState).toEqual({ status: 'uploading', progress: 0, preparing: 'photos' }));

        await act(async () => {
            cleaning.resolve({ files: [file], summary: { cleaned: 0, notCleaned: [], motionPhotos: 0 } });
        });
        // Cleaning is done and presign hasn't answered yet: uploading, no longer preparing.
        await waitFor(() => expect(result.current.uploadState).toEqual({ status: 'uploading', progress: 0 }));

        await act(async () => {
            presign.resolve({ uploadToken: 'token', items: [{ fileName: file.name, uploadUrl: 'http://storage/put', storageKey: 'uploads/key', uploadMode: 'Single' }] });
            await uploading;
        });
        expect(result.current.uploadState.status).toBe('success');
    });

    it('also cleans photos in encrypted bundles, since their recipients see the files', async () => {
        const api = fakeApi();
        vi.spyOn(uploadApi, 'getPresignedUrl').mockResolvedValue({
            uploadToken: 'token',
            items: [{ fileName: 'x.enc', uploadUrl: 'http://storage/put', storageKey: 'uploads/key', uploadMode: 'Single' }],
        });
        const original = photo();
        const { result } = renderHook(() => useFileUpload());

        await act(async () => {
            await result.current.upload({ ...FORM, isEncrypted: true, stripImageMetadata: true }, [original]);
        });

        expect(result.current.uploadState).toMatchObject({ status: 'success', metadataSummary: { cleaned: 1 } });
        expect(api.confirm).toHaveBeenCalledTimes(1);
    });
});

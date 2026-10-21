import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeStandardUploadWorkflow } from '../uploadWorkflow';
import { uploadApi } from '../../api/uploadApi';
import type { CreatePresignedUrlRequest, PresignedItem } from '../../../download/types';

const PART_SIZE_BYTES = 4;
const MANY_PARTS = 40;
const ONE_PART = 1;
const PART_DELAY_MS = 20;
const LATE_FAILURE_MS = 50;
const EXPIRE_IN_HOURS = 24;
const MAX_DOWNLOADS = 5;
const FORM_VALUES = { title: 'Stops', expireInHours: EXPIRE_IN_HOURS, maxDownloads: MAX_DOWNLOADS, isEncrypted: false, password: '' } as const;

// The workflow sends multipart files by size; here the presign mock decides, by the file's name.
const isMultipartName = (name: string): boolean => name.startsWith('big');

const fileOf = (name: string, parts: number): File => new File(['x'.repeat(PART_SIZE_BYTES * parts)], name);

const mockPresign = (): void => {
    vi.spyOn(uploadApi, 'getPresignedUrl').mockImplementation(async (request: CreatePresignedUrlRequest) => ({
        uploadToken: 'upload_token',
        items: request.files.map((file, i): PresignedItem => (isMultipartName(file.fileName)
            ? {
                fileName: file.fileName,
                storageKey: `uploads/${i}`,
                uploadMode: 'Multipart',
                uploadId: `upload_${file.fileName}`,
                partSizeBytes: PART_SIZE_BYTES,
                totalParts: Math.ceil(file.sizeBytes / PART_SIZE_BYTES),
            }
            : { fileName: file.fileName, storageKey: `uploads/${i}`, uploadMode: 'Single', uploadUrl: `single://${file.fileName}` })),
    }));
    vi.spyOn(uploadApi, 'presignPartBatch').mockImplementation(async (request) => ({
        parts: Array.from({ length: request.count }, (_, i) => ({ partNumber: request.startPartNumber + i, uploadUrl: `part_${i}` })),
    }));
};

/** Resolves after `ms`, or rejects at once when the upload is cancelled, like a real request would. */
const waitOrCancel = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('canceled', 'AbortError'));
        }, { once: true });
    });

describe('a bundle upload that fails or is cancelled part way', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mockPresign();
        vi.spyOn(uploadApi, 'completeMultipartUpload').mockResolvedValue(true);
        vi.spyOn(uploadApi, 'abortMultipartUpload').mockResolvedValue(true);
        vi.spyOn(uploadApi, 'confirmUpload').mockResolvedValue('share_token');
    });

    it('stops the other files on the first failure, aborts their multipart uploads and reports that failure', async () => {
        const partSignals: (AbortSignal | undefined)[] = [];
        vi.spyOn(uploadApi, 'uploadMultipartChunkDirectToS3').mockImplementation(async (_url, _chunk, signal) => {
            partSignals.push(signal);
            await waitOrCancel(PART_DELAY_MS, signal);
            return 'etag';
        });
        vi.spyOn(uploadApi, 'uploadDirectToS3').mockRejectedValue(new Error('storage refused small.txt'));

        await expect(executeStandardUploadWorkflow(FORM_VALUES, [fileOf('big.bin', MANY_PARTS), fileOf('small.txt', ONE_PART)], vi.fn()))
            .rejects.toThrow('storage refused small.txt');

        // The part in flight was cancelled, and no further parts were sent.
        expect(partSignals.every((signal) => signal?.aborted)).toBe(true);
        expect(partSignals.length).toBeLessThan(MANY_PARTS);
        expect(uploadApi.completeMultipartUpload).not.toHaveBeenCalled();
        expect(uploadApi.abortMultipartUpload).toHaveBeenCalledWith({ uploadToken: 'upload_token', storageKey: 'uploads/0', uploadId: 'upload_big.bin' });
        expect(uploadApi.confirmUpload).not.toHaveBeenCalled();
    });

    it('leaves multipart uploads that already finished alone', async () => {
        vi.spyOn(uploadApi, 'uploadMultipartChunkDirectToS3').mockResolvedValue('etag');
        vi.spyOn(uploadApi, 'uploadDirectToS3').mockImplementation(async () => {
            await waitOrCancel(LATE_FAILURE_MS);
            throw new Error('late failure');
        });

        await expect(executeStandardUploadWorkflow(FORM_VALUES, [fileOf('big.bin', ONE_PART), fileOf('small.txt', ONE_PART)], vi.fn()))
            .rejects.toThrow('late failure');

        expect(uploadApi.completeMultipartUpload).toHaveBeenCalledTimes(1);
        expect(uploadApi.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('aborts the started multipart uploads when the user cancels', async () => {
        const controller = new AbortController();
        vi.spyOn(uploadApi, 'uploadMultipartChunkDirectToS3').mockImplementation(async (_url, _chunk, signal) => {
            controller.abort();
            await waitOrCancel(PART_DELAY_MS, signal);
            return 'etag';
        });

        await expect(executeStandardUploadWorkflow(FORM_VALUES, [fileOf('big.bin', MANY_PARTS)], vi.fn(), controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });

        expect(uploadApi.abortMultipartUpload).toHaveBeenCalledTimes(1);
        expect(uploadApi.confirmUpload).not.toHaveBeenCalled();
    });

    it('still reports the original failure when aborting a multipart upload fails too', async () => {
        vi.spyOn(uploadApi, 'uploadMultipartChunkDirectToS3').mockImplementation(async (_url, _chunk, signal) => {
            await waitOrCancel(PART_DELAY_MS, signal);
            return 'etag';
        });
        vi.spyOn(uploadApi, 'uploadDirectToS3').mockRejectedValue(new Error('storage refused small.txt'));
        vi.spyOn(uploadApi, 'abortMultipartUpload').mockRejectedValue(new Error('abort failed'));

        await expect(executeStandardUploadWorkflow(FORM_VALUES, [fileOf('big.bin', MANY_PARTS), fileOf('small.txt', ONE_PART)], vi.fn()))
            .rejects.toThrow('storage refused small.txt');
    });
});

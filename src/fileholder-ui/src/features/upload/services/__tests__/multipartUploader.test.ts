import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeMultipartUpload, fileSource, PART_URL_MAX_AGE_MS, type UploadSource } from '../multipartUploader';
import { uploadApi } from '../../api/uploadApi';
import type { PresignPartBatchRequest, PresignedItem } from '../../../download/types';

const PART_SIZE_BYTES = 4;
const UPLOAD_TOKEN = 'token_mp';
const ONE_MINUTE_MS = 60_000;
const CONCURRENCY = 4;
const TWO_PARTS = 2;
const PRESIGN_CALLS_WITH_ONE_RETRY = 2;
const MAX_ATTEMPTS_PER_PART = 3;

const createItem = (totalParts: number): PresignedItem => ({
    fileName: 'big.bin',
    storageKey: 'uploads/big.bin',
    uploadMode: 'Multipart',
    uploadId: 'upload_1',
    partSizeBytes: PART_SIZE_BYTES,
    totalParts,
});

const createFile = (totalParts: number): UploadSource => fileSource(new File(['x'.repeat(PART_SIZE_BYTES * totalParts)], 'big.bin'));

/** Signs URLs that say which batch signed them: "part_3_sig1" is part 3 from the first presign call. */
const mockPresign = () => {
    const presignSpy = vi.spyOn(uploadApi, 'presignPartBatch').mockImplementation(async (req: PresignPartBatchRequest) => ({
        parts: Array.from({ length: req.count }, (_, i) => ({
            partNumber: req.startPartNumber + i,
            uploadUrl: `part_${req.startPartNumber + i}_sig${presignSpy.mock.calls.length}`,
        })),
    }));
    return presignSpy;
};

describe('executeMultipartUpload', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(uploadApi, 'completeMultipartUpload').mockResolvedValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('signs one batch for workers that need parts of it at the same time', async () => {
        const totalParts = 8;
        const presignSpy = mockPresign();
        vi.spyOn(uploadApi, 'uploadMultipartChunkDirectToS3').mockResolvedValue('etag');

        await executeMultipartUpload(createFile(totalParts), createItem(totalParts), UPLOAD_TOKEN, { concurrency: CONCURRENCY });

        expect(presignSpy).toHaveBeenCalledTimes(1);
        expect(presignSpy.mock.calls[0][0]).toMatchObject({ startPartNumber: 1, count: totalParts });
    });

    it('retries a failed part with a freshly signed URL', async () => {
        const presignSpy = mockPresign();
        const uploadSpy = vi.spyOn(uploadApi, 'uploadMultipartChunkDirectToS3')
            .mockRejectedValueOnce(new Error('403 Forbidden'))
            .mockResolvedValue('etag');

        await executeMultipartUpload(createFile(1), createItem(1), UPLOAD_TOKEN, { concurrency: 1 });

        expect(presignSpy).toHaveBeenCalledTimes(PRESIGN_CALLS_WITH_ONE_RETRY);
        expect(uploadSpy.mock.calls.map((call) => call[0])).toEqual(['part_1_sig1', 'part_1_sig2']);
    });

    it('signs a part again when its URL has grown too old to be used', async () => {
        const startTime = Date.now();
        let now = startTime;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const presignSpy = mockPresign();
        const uploadSpy = vi.spyOn(uploadApi, 'uploadMultipartChunkDirectToS3').mockImplementation(async () => {
            // Uploading part 1 is slow: by the time part 2 starts, the batch's URLs are past their safe age.
            now = startTime + PART_URL_MAX_AGE_MS + ONE_MINUTE_MS;
            return 'etag';
        });

        await executeMultipartUpload(createFile(TWO_PARTS), createItem(TWO_PARTS), UPLOAD_TOKEN, { concurrency: 1 });

        expect(presignSpy.mock.calls.map((call) => call[0].startPartNumber)).toEqual([1, TWO_PARTS]);
        expect(uploadSpy.mock.calls.map((call) => call[0])).toEqual(['part_1_sig1', 'part_2_sig2']);
    });

    it('gives up on a part after three failed attempts, and never completes the upload', async () => {
        mockPresign();
        vi.spyOn(uploadApi, 'uploadMultipartChunkDirectToS3').mockRejectedValue(new Error('network down'));
        const completeSpy = vi.spyOn(uploadApi, 'completeMultipartUpload');

        await expect(executeMultipartUpload(createFile(1), createItem(1), UPLOAD_TOKEN, { concurrency: 1 }))
            .rejects.toThrow('network down');
        expect(uploadApi.uploadMultipartChunkDirectToS3).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_PART);
        expect(completeSpy).not.toHaveBeenCalled();
    });
});

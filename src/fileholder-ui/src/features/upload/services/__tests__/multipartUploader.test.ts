import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { executeMultipartUpload, fileSource, PART_URL_MAX_AGE_MS, type UploadSource } from '../multipartUploader';
import { uploadApi } from '../../api/uploadApi';
import { createConcurrencyLimiter } from '../../../../shared/utils/concurrencyLimiter';
import type { PresignPartBatchRequest, PresignedItem } from '../../../download/types';

const PART_SIZE_BYTES = 4;
const UPLOAD_TOKEN = 'token_mp';
const ONE_MINUTE_MS = 60_000;
const CONCURRENCY = 4;
const TWO_PARTS = 2;
const PRESIGN_CALLS_WITH_ONE_RETRY = 2;
const COMPLETE_CALLS_WITH_ONE_RETRY = 2;
const MAX_ATTEMPTS_PER_PART = 3;
const SHARED_LIMIT = 2;
const TWO_UPLOADS = 2;
const PARTS_PER_FILE = 6;
const UPLOAD_DELAY_MS = 5;

const createItem = (totalParts: number): PresignedItem => ({
    fileName: 'big.bin',
    storageKey: 'uploads/big.bin',
    uploadMode: 'Multipart',
    uploadId: 'upload_1',
    partSizeBytes: PART_SIZE_BYTES,
    totalParts,
});

const HTTP_TOO_MANY_REQUESTS = 429;

// Retry-After 0, so the test doesn't have to wait.
const tooManyRequests = (): AxiosError =>
    new AxiosError('Too Many Requests', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: HTTP_TOO_MANY_REQUESTS,
        statusText: '',
        data: null,
        headers: { 'retry-after': '0' },
        config: { headers: new AxiosHeaders() },
    });

const createFile =(totalParts: number): UploadSource => fileSource(new File(['x'.repeat(PART_SIZE_BYTES * totalParts)], 'big.bin'));

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

    it('shares a limiter with other uploads, never building or sending more parts at once than it allows', async () => {
        mockPresign();
        let inFlight = 0;
        let maxInFlight = 0;
        // Counts a part from the moment it is read (for an encrypted file, encrypted into memory) until it is sent.
        const counted = (source: UploadSource): UploadSource => ({
            size: source.size,
            read: async (start, end) => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                return source.read(start, end);
            },
        });
        vi.spyOn(uploadApi, 'uploadMultipartChunkDirectToS3').mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, UPLOAD_DELAY_MS));
            inFlight--;
            return 'etag';
        });
        const limiter = createConcurrencyLimiter(SHARED_LIMIT);

        await Promise.all([
            executeMultipartUpload(counted(createFile(PARTS_PER_FILE)), createItem(PARTS_PER_FILE), UPLOAD_TOKEN, { concurrency: CONCURRENCY, limiter }),
            executeMultipartUpload(counted(createFile(PARTS_PER_FILE)), { ...createItem(PARTS_PER_FILE), uploadId: 'upload_2' }, UPLOAD_TOKEN, { concurrency: CONCURRENCY, limiter }),
        ]);

        expect(maxInFlight).toBe(SHARED_LIMIT);
        expect(uploadApi.uploadMultipartChunkDirectToS3).toHaveBeenCalledTimes(PARTS_PER_FILE * TWO_UPLOADS);
    });

    it('waits out rate limiting on signing and completing, without spending any of the part\'s attempts', async () => {
        const presignSpy = mockPresign();
        // More 429s in a row than a part has attempts: before, the part failed after the third.
        const rateLimitedSignings = MAX_ATTEMPTS_PER_PART + 1;
        Array.from({ length: rateLimitedSignings }).forEach(() => presignSpy.mockRejectedValueOnce(tooManyRequests()));
        const uploadSpy = vi.spyOn(uploadApi, 'uploadMultipartChunkDirectToS3').mockResolvedValue('etag');
        const completeSpy = vi.spyOn(uploadApi, 'completeMultipartUpload')
            .mockRejectedValueOnce(tooManyRequests())
            .mockResolvedValue(true);

        await executeMultipartUpload(createFile(1), createItem(1), UPLOAD_TOKEN, { concurrency: 1 });

        expect(presignSpy).toHaveBeenCalledTimes(rateLimitedSignings + 1);
        expect(uploadSpy).toHaveBeenCalledTimes(1);
        expect(completeSpy).toHaveBeenCalledTimes(COMPLETE_CALLS_WITH_ONE_RETRY);
    });
});

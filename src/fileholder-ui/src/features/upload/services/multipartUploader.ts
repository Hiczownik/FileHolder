import type { CompletedPartInput, PresignedItem } from "../../download/types";
import { uploadApi } from "../api/uploadApi";

export interface MultipartUploadOptions {
    concurrency?: number;
    onChunkUploaded?: (bytes: number) => void;
    signal?: AbortSignal;
}

const DEFAULT_CONCURRENCY = 4;
const PRESIGN_BATCH_SIZE = 50;
const MAX_ATTEMPTS_PER_PART = 3;
const RETRY_BASE_DELAY_MS = 200;
// Each retry waits twice as long as the one before.
const RETRY_BACKOFF_FACTOR = 2;
const MS_PER_MINUTE = 60_000;
const PART_URL_MAX_AGE_MINUTES = 25;
// The server signs part URLs for 30 minutes. Older ones are signed again before use, with a margin for the
// upload itself, so a slow upload never sends a part to an expired URL.
export const PART_URL_MAX_AGE_MS = PART_URL_MAX_AGE_MINUTES * MS_PER_MINUTE;

interface SignedPartUrl {
    readonly url: string;
    readonly signedAt: number;
}

const abortError = (): DOMException => new DOMException('Upload aborted by user', 'AbortError');

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function executeMultipartUpload(
    file: File,
    item: PresignedItem,
    uploadToken: string,
    options?: MultipartUploadOptions
): Promise<void> {
    const totalParts = item.totalParts!;
    const partSizeBytes = item.partSizeBytes!;
    const uploadId = item.uploadId!;
    const storageKey = item.storageKey;
    const concurrency = Math.min(options?.concurrency ?? DEFAULT_CONCURRENCY, totalParts);

    const signedUrls = new Map<number, SignedPartUrl>();
    // Batches still being signed, by each part number they cover, so workers needing parts of the same
    // batch wait for it instead of each requesting it again.
    const pendingBatches = new Map<number, Promise<void>>();

    const throwIfAborted = (): void => {
        if (options?.signal?.aborted) {
            throw abortError();
        }
    };

    const requestBatch = (startPartNumber: number): Promise<void> => {
        const count = Math.min(PRESIGN_BATCH_SIZE, totalParts - startPartNumber + 1);
        const coveredParts = Array.from({ length: count }, (_, i) => startPartNumber + i);
        // Taken before the request, so a URL's age is never underestimated.
        const signedAt = Date.now();

        const batch = (async (): Promise<void> => {
            try {
                const response = await uploadApi.presignPartBatch({ uploadToken, storageKey, uploadId, startPartNumber, count });
                response.parts.forEach((part) => signedUrls.set(part.partNumber, { url: part.uploadUrl, signedAt }));
            } finally {
                coveredParts.forEach((partNumber) => pendingBatches.delete(partNumber));
            }
        })();

        coveredParts.forEach((partNumber) => pendingBatches.set(partNumber, batch));
        return batch;
    };

    const getPartUrl = async (partNumber: number): Promise<string> => {
        throwIfAborted();

        const cached = signedUrls.get(partNumber);
        if (cached && Date.now() - cached.signedAt < PART_URL_MAX_AGE_MS) {
            return cached.url;
        }

        signedUrls.delete(partNumber);
        await (pendingBatches.get(partNumber) ?? requestBatch(partNumber));

        const url = signedUrls.get(partNumber)?.url;
        if (!url) {
            throw new Error(`Failed to acquire upload URL for part ${partNumber}`);
        }
        return url;
    };

    const uploadPart = async (partNumber: number, chunk: Blob, attempt: number): Promise<string> => {
        throwIfAborted();

        try {
            return await uploadApi.uploadMultipartChunkDirectToS3(await getPartUrl(partNumber), chunk);
        } catch (err) {
            if (options?.signal?.aborted) {
                throw abortError();
            }
            // The URL may be what failed (expired, or rejected), so the retry signs a fresh one.
            signedUrls.delete(partNumber);
            if (attempt >= MAX_ATTEMPTS_PER_PART) {
                throw err;
            }
            await delay(RETRY_BASE_DELAY_MS * RETRY_BACKOFF_FACTOR ** attempt);
            return uploadPart(partNumber, chunk, attempt + 1);
        }
    };

    const completedParts: CompletedPartInput[] = [];
    const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);

    let currentIndex = 0;
    let activeError: Error | null = null;

    const worker = async (): Promise<void> => {
        if (activeError || currentIndex >= partNumbers.length) {
            return;
        }

        const partNumber = partNumbers[currentIndex++];
        const start = (partNumber - 1) * partSizeBytes;
        const end = Math.min(start + partSizeBytes, file.size);
        const chunk = file.slice(start, end);

        try {
            const etag = await uploadPart(partNumber, chunk, 1);
            completedParts.push({ partNumber, eTag: etag });
            options?.onChunkUploaded?.(chunk.size);
        } catch (err) {
            activeError = err instanceof Error ? err : new Error(`Failed to upload part ${partNumber}`);
            throw activeError;
        }

        return worker();
    };

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    if (activeError) throw activeError;

    completedParts.sort((a, b) => a.partNumber - b.partNumber);

    await uploadApi.completeMultipartUpload({
        uploadToken,
        storageKey,
        uploadId,
        parts: completedParts,
    });
}

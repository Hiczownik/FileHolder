import type { CompletedPartInput, PresignedItem } from "../../download/types";
import { uploadApi } from "../api/uploadApi";

export interface MultipartUploadOptions {
    concurrency?: number;
    onChunkUploaded?: (bytes: number) => void;
    signal?: AbortSignal;
}

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
    const concurrency = Math.min(options?.concurrency ?? 4, totalParts);

    const presignedUrls = new Map<number, string>();

    const getPartUrl = async (partNumber: number): Promise<string> => {
        if (options?.signal?.aborted) {
            throw new DOMException('Upload aborted by user', 'AbortError');
        }

        if (presignedUrls.has(partNumber)) {
            return presignedUrls.get(partNumber)!;
        }

        const batch = await uploadApi.presignPartBatch({
            uploadToken,
            storageKey,
            uploadId,
            startPartNumber: partNumber,
            count: 50,
        });

        for (const p of batch.parts) {
            presignedUrls.set(p.partNumber, p.uploadUrl);
        }

        const url = presignedUrls.get(partNumber);
        if (!url) {
            throw new Error(`Failed to acquire upload URL for part ${partNumber}`);
        }
        return url;
    };

    const completedParts: CompletedPartInput[] = [];
    const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);

    let currentIndex = 0;
    let activeError: Error | null = null;

    const worker = async () => {
        while (currentIndex < partNumbers.length && !activeError) {
            if (options?.signal?.aborted) {
                activeError = new DOMException('Upload aborted by user', 'AbortError');
                throw activeError;
            }

            const partNumber = partNumbers[currentIndex++];
            const start = (partNumber - 1) * partSizeBytes;
            const end = Math.min(start + partSizeBytes, file.size);
            const chunk = file.slice(start, end);

            let attempts = 0;
            let success = false;
            let etag = '';

            while (attempts < 3 && !success) {
                if (options?.signal?.aborted) {
                    activeError = new DOMException('Upload aborted by user', 'AbortError');
                    throw activeError;
                }

                try {
                    const url = await getPartUrl(partNumber);
                    etag = await uploadApi.uploadMultipartChunkDirectToS3(url, chunk);
                    success = true;
                } catch (err) {
                    attempts++;
                    if (attempts >= 3) {
                        activeError = err instanceof Error ? err : new Error(`Failed to upload part ${partNumber}`);
                        throw activeError;
                    }
                    await new Promise((res) => setTimeout(res, 200 * Math.pow(2, attempts)));
                }
            }

            completedParts.push({ partNumber, eTag: etag });
            options?.onChunkUploaded?.(chunk.size);
        }
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
import type { PresignedItem } from "../../download/types";
import { uploadApi } from "../api/uploadApi";
import { STANDARD_MAX_TOTAL_BYTES, type UploadFormValues } from "../types";
import {
    assertPartsAlignWithChunks,
    encryptCiphertextRange,
    encryptWholeFile,
    prepareEncryptedBundle,
} from "./clientEncryptionService";
import { executeMultipartUpload, fileSource } from "./multipartUploader";
import { isExtensionForbidden } from "../../../shared/utils/fileNameSafety";
import { formatSize } from "../../../shared/utils/formatSize";
import { createConcurrencyLimiter } from "../../../shared/utils/concurrencyLimiter";
import { abortError } from "./rateLimitRetry";

const PERCENT_COMPLETE = 100;
// Progress stops short of 100% until every file has finished uploading.
const MAX_PERCENT_BEFORE_CONFIRM = 99;
const MULTIPART_CONCURRENCY = 4;
// Parts (or whole small files) being read, encrypted and sent at once, across all the bundle's files. Encrypted
// parts are built in memory just before they are sent (16 MiB each, a few copies while encrypting), so this is
// what bounds memory however many files a bundle has. Browsers open about 6 connections per host anyway.
const MAX_PARTS_IN_FLIGHT = 4;

const throwIfAborted = (signal: AbortSignal): void => {
    if (signal.aborted) {
        throw abortError();
    }
};

/** Best effort: a multipart upload left behind is still aborted by the server's purge once its session expires. */
async function abortQuietly(uploadToken: string, item: PresignedItem): Promise<void> {
    try {
        await uploadApi.abortMultipartUpload({ uploadToken, storageKey: item.storageKey, uploadId: item.uploadId ?? '' });
    } catch {
        // The error that stopped the upload is the one worth showing.
    }
}

/**
 * Uploads every file, or none: the first file to fail (or the user cancelling) stops all the others, so they don't
 * keep sending in the background. Once every file has stopped, the multipart uploads that didn't finish are
 * aborted, so their parts don't sit in storage until the purge; aborting only then means no part lands after it.
 */
async function uploadAllOrStop(
    items: readonly PresignedItem[],
    uploadToken: string,
    uploadOne: (item: PresignedItem, index: number, signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal
): Promise<void> {
    const controller = new AbortController();
    const stopAll = (): void => controller.abort();
    if (signal?.aborted) stopAll();
    signal?.addEventListener('abort', stopAll, { once: true });

    const finished = new Set<number>();
    const failures: unknown[] = [];

    await Promise.allSettled(items.map(async (item, index) => {
        try {
            await uploadOne(item, index, controller.signal);
            finished.add(index);
        } catch (err: unknown) {
            failures.push(err);
            stopAll();
        }
    }));
    signal?.removeEventListener('abort', stopAll);

    if (failures.length === 0) return;

    await Promise.all(items
        .filter((item, index) => item.uploadMode === 'Multipart' && !finished.has(index))
        .map((item) => abortQuietly(uploadToken, item)));

    // The first failure is what went wrong; the rest are the files it stopped.
    throw failures[0];
}

/** Fails before anything is uploaded, with the same limit the server enforces at presign. */
function assertWithinBundleLimit(files: readonly File[]): void {
    const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
    if (totalBytes > STANDARD_MAX_TOTAL_BYTES) {
        throw new Error(`The bundle cannot be larger than ${formatSize(STANDARD_MAX_TOTAL_BYTES)} in total; these files add up to ${formatSize(totalBytes)}.`);
    }
}

export async function executeStandardUploadWorkflow(
    formValues: UploadFormValues,
    files: File[],
    onProgress: (percent: number) => void,
    signal?: AbortSignal 
): Promise<string> {
    assertWithinBundleLimit(files);

    const presign = await uploadApi.getPresignedUrl({
        title: formValues.title || undefined,
        files: files.map((f) => ({
            fileName: f.name,
            contentType: f.type || 'application/octet-stream',
            sizeBytes: f.size,
        })),
        expireInHours: Number(formValues.expireInHours),
        maxDownloads: Number(formValues.maxDownloads),
        password: formValues.password || undefined,
        isEncrypted: false,
    });

    const items: PresignedItem[] = presign.items ?? [];
    const totalBytesAllFiles = files.reduce((acc, f) => acc + f.size, 0);
    const fileUploadedBytes = new Array(files.length).fill(0);

    const syncProgress = () => {
        const totalLoaded = fileUploadedBytes.reduce((acc, b) => acc + b, 0);
        const percent = Math.min(Math.round((totalLoaded / totalBytesAllFiles) * PERCENT_COMPLETE), MAX_PERCENT_BEFORE_CONFIRM);
        onProgress(percent);
    };

    const limiter = createConcurrencyLimiter(MAX_PARTS_IN_FLIGHT);
    await uploadAllOrStop(items, presign.uploadToken, async (item, index, fileSignal) => {
        const currentFile = files[index];

        if (item.uploadMode === 'Multipart') {
            await executeMultipartUpload(
                fileSource(currentFile),
                item,
                presign.uploadToken,
                {
                    concurrency: MULTIPART_CONCURRENCY,
                    limiter,
                    signal: fileSignal,
                    onChunkUploaded: (chunkSize) => {
                        fileUploadedBytes[index] += chunkSize;
                        syncProgress();
                    },
                }
            );
        } else {
            if (!item.uploadUrl) {
                throw new Error(`Missing upload URL for file ${item.fileName}`);
            }
            const uploadUrl = item.uploadUrl;
            await limiter.run(() => {
                throwIfAborted(fileSignal);
                return uploadApi.uploadDirectToS3(uploadUrl, currentFile, (percent) => {
                    fileUploadedBytes[index] = Math.round((currentFile.size * percent) / PERCENT_COMPLETE);
                    syncProgress();
                }, fileSignal);
            });
        }
    }, signal);
    onProgress(PERCENT_COMPLETE);

    const shareToken = await uploadApi.confirmUpload({ 
        uploadToken: presign.uploadToken,
        title: formValues.title || undefined,
        files: items.map((item, index) => ({
            storageKey: item.storageKey,
            fileName: item.fileName,
            contentType: files[index].type || 'application/octet-stream',
            sizeBytes: files[index].size,
        })),
        expireInHours: Number(formValues.expireInHours),
        maxDownloads: Number(formValues.maxDownloads),
        password: formValues.password || undefined,
        isEncrypted: false,
    });

    return `${window.location.origin}/f/${shareToken}`;
}

export async function executeEncryptedUploadWorkflow(
    formValues: UploadFormValues,
    files: File[],
    onProgress: (percent: number) => void,
    signal?: AbortSignal
): Promise<string> {
    if (!formValues.password) {
        throw new Error('A passkey is required for Zero-Knowledge End-to-End Encryption.');
    }

    // The server only sees "{uuid}.enc" here, so it can't reject these; recipients would refuse the bundle.
    const blocked = files.filter((file) => isExtensionForbidden(file.name));
    if (blocked.length > 0) {
        throw new Error(`Forbidden file extension detected. Executable files and scripts are not allowed: ${blocked.map((file) => file.name).join(', ')}.`);
    }

    assertWithinBundleLimit(files);

    // Nothing is encrypted yet: each file is encrypted part by part as it uploads, so memory doesn't grow
    // with file size. The encrypted sizes are known up front, so the upload URLs can be signed for them.
    const prepared = await prepareEncryptedBundle(files, formValues.password);

    const presign = await uploadApi.getPresignedUrl({
        title: formValues.title || undefined,
        files: prepared.files.map((item) => ({
            fileName: item.storageName,
            contentType: 'application/octet-stream',
            sizeBytes: item.encryptedSize,
        })),
        expireInHours: Number(formValues.expireInHours),
        maxDownloads: Number(formValues.maxDownloads),
        password: prepared.kAuth,
        isEncrypted: true,
    });

    const items: PresignedItem[] = presign.items ?? [];

    // Checked before anything is sent, so a mismatch never leaves a half-uploaded bundle behind.
    items.forEach((item, index) => {
        if (item.uploadMode === 'Multipart') {
            assertPartsAlignWithChunks(prepared.files[index], item.partSizeBytes ?? 0);
        }
    });

    const totalBytesAllFiles = prepared.files.reduce((acc, f) => acc + f.encryptedSize, 0);
    const fileUploadedBytes = new Array(prepared.files.length).fill(0);

    const syncProgress = () => {
        const totalLoaded = fileUploadedBytes.reduce((acc, b) => acc + b, 0);
        const percent = Math.min(Math.round((totalLoaded / totalBytesAllFiles) * PERCENT_COMPLETE), MAX_PERCENT_BEFORE_CONFIRM);
        onProgress(percent);
    };

    const limiter = createConcurrencyLimiter(MAX_PARTS_IN_FLIGHT);
    await uploadAllOrStop(items, presign.uploadToken, async (item, index, fileSignal) => {
        const encryptedItem = prepared.files[index];

        if (item.uploadMode === 'Multipart') {
            await executeMultipartUpload(
                {
                    size: encryptedItem.encryptedSize,
                    read: (start, end) => encryptCiphertextRange(encryptedItem, start, end),
                },
                item,
                presign.uploadToken,
                {
                    concurrency: MULTIPART_CONCURRENCY,
                    limiter,
                    signal: fileSignal,
                    onChunkUploaded: (chunkSize) => {
                        fileUploadedBytes[index] += chunkSize;
                        syncProgress();
                    },
                }
            );
        } else {
            if (!item.uploadUrl) {
                throw new Error(`Missing upload URL for file ${item.fileName}`);
            }
            // Single uploads are at most the multipart threshold (50 MB), so encrypting one whole is fine; holding a
            // slot while encrypting keeps many of them from being encrypted into memory at the same time.
            const uploadUrl = item.uploadUrl;
            await limiter.run(async () => {
                throwIfAborted(fileSignal);
                const ciphertext = await encryptWholeFile(encryptedItem);
                await uploadApi.uploadDirectToS3(uploadUrl, ciphertext, (percent) => {
                    fileUploadedBytes[index] = Math.round((encryptedItem.encryptedSize * percent) / PERCENT_COMPLETE);
                    syncProgress();
                }, fileSignal);
            });
        }
    }, signal);
    onProgress(PERCENT_COMPLETE);

    const shareToken = await uploadApi.confirmUpload({
        uploadToken: presign.uploadToken,
        title: formValues.title || undefined,
        files: items.map((item, index) => ({
            storageKey: item.storageKey,
            fileName: item.fileName,
            contentType: 'application/octet-stream',
            sizeBytes: prepared.files[index].encryptedSize,
        })),
        expireInHours: Number(formValues.expireInHours),
        maxDownloads: Number(formValues.maxDownloads),
        password: prepared.kAuth,
        isEncrypted: true,
        encryptedManifest: prepared.encryptedManifest,
        keyEnvelope: prepared.keyEnvelope,
        keySalt: prepared.keySalt,
    });

    return `${window.location.origin}/f/${shareToken}`;
}
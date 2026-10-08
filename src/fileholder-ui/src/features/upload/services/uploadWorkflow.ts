import type { PresignedItem } from "../../download/types";
import { uploadApi } from "../api/uploadApi";
import type { UploadFormValues } from "../types";
import { prepareEncryptedBundle } from "./clientEncryptionService";
import { executeMultipartUpload } from "./multipartUploader";

export async function executeStandardUploadWorkflow(
    formValues: UploadFormValues,
    files: File[],
    onProgress: (percent: number) => void,
    signal?: AbortSignal 
): Promise<string> {
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
        const percent = Math.min(Math.round((totalLoaded / totalBytesAllFiles) * 100), 99);
        onProgress(percent);
    };

    const uploadTasks = items.map(async (item, index) => {
        const currentFile = files[index];

        if (item.uploadMode === 'Multipart') {
            await executeMultipartUpload(
                currentFile,
                item,
                presign.uploadToken, 
                {
                    concurrency: 4,
                    signal,
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
            await uploadApi.uploadDirectToS3(item.uploadUrl, currentFile, (percent) => {
                fileUploadedBytes[index] = Math.round((currentFile.size * percent) / 100);
                syncProgress();
            });
        }
    });

    await Promise.all(uploadTasks);
    onProgress(100);

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
    onProgress: (percent: number) => void
): Promise<string> {
    const prepared = await prepareEncryptedBundle(files);

    const presign = await uploadApi.getPresignedUrl({
        title: formValues.title || undefined,
        files: [
            {
                fileName: prepared.targetFileName,
                contentType: 'application/octet-stream',
                sizeBytes: prepared.totalSizeBytes,
            },
        ],
        expireInHours: Number(formValues.expireInHours),
        maxDownloads: Number(formValues.maxDownloads),
        password: formValues.password || undefined,
        isEncrypted: true,
    });

    const targetItem = presign.items?.[0];
    if (!targetItem || !targetItem.uploadUrl) {
        throw new Error('Failed to acquire storage upload URL.');
    }

    await uploadApi.uploadDirectToS3(targetItem.uploadUrl, prepared.encryptedFileBlob, (percent) => {
        onProgress(Math.min(percent, 99));
    });

    onProgress(100);

    const shareToken = await uploadApi.confirmUpload({
        uploadToken: presign.uploadToken,
        title: formValues.title || undefined,
        files: [
            {
                storageKey: targetItem.storageKey,
                fileName: targetItem.fileName,
                contentType: 'application/octet-stream',
                sizeBytes: prepared.totalSizeBytes,
            },
        ],
        expireInHours: Number(formValues.expireInHours),
        maxDownloads: Number(formValues.maxDownloads),
        password: formValues.password || undefined,
        isEncrypted: true,
        encryptedManifest: prepared.encryptedManifest,
    });

    return `${window.location.origin}/f/${shareToken}#key=${prepared.keyString}`;
}
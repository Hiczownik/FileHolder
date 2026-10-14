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
    onProgress: (percent: number) => void,
    signal?: AbortSignal
): Promise<string> {
    if (!formValues.password) {
        throw new Error('A passkey is required for Zero-Knowledge End-to-End Encryption.');
    }

    const prepared = await prepareEncryptedBundle(files, formValues.password);

    const presign = await uploadApi.getPresignedUrl({
        title: formValues.title || undefined,
        files: prepared.files.map((item) => ({
            fileName: item.encryptedFile.name,
            contentType: 'application/octet-stream',
            sizeBytes: item.encryptedFile.size,
        })),
        expireInHours: Number(formValues.expireInHours),
        maxDownloads: Number(formValues.maxDownloads),
        password: prepared.kAuth,
        isEncrypted: true,
    });

    const items: PresignedItem[] = presign.items ?? [];
    const totalBytesAllFiles = prepared.files.reduce((acc, f) => acc + f.encryptedFile.size, 0);
    const fileUploadedBytes = new Array(prepared.files.length).fill(0);

    const syncProgress = () => {
        const totalLoaded = fileUploadedBytes.reduce((acc, b) => acc + b, 0);
        const percent = Math.min(Math.round((totalLoaded / totalBytesAllFiles) * 100), 99);
        onProgress(percent);
    };

    const uploadTasks = items.map(async (item, index) => {
        const currentEncryptedFile = prepared.files[index].encryptedFile;

        if (item.uploadMode === 'Multipart') {
            await executeMultipartUpload(
                currentEncryptedFile,
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
            await uploadApi.uploadDirectToS3(item.uploadUrl, currentEncryptedFile, (percent) => {
                fileUploadedBytes[index] = Math.round((currentEncryptedFile.size * percent) / 100);
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
            contentType: 'application/octet-stream',
            sizeBytes: prepared.files[index].encryptedFile.size,
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
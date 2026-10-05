import { useReducer } from "react";
import { uploadApi } from "../api/uploadApi";
import type { UploadFormValues, UploadState, PresignedItem, CompletedPartInput } from "../types";
import { E2EE_MAX_BUNDLE_BYTES, E2EE_MAX_SINGLE_FILE_BYTES } from "../types";
import type { FileItemMetadata } from "../../download/types";
import { parseApiError } from "../../../shared/utils/parseApiError";
import { cryptoEngine } from "../../../shared/utils/crypto/cryptoUtils";
import { zipUtils } from "../../../shared/utils/crypto/zipUtils";

type UploadAction =
    | { type: 'START_UPLOAD' }
    | { type: 'SET_PROGRESS'; payload: number }
    | { type: 'UPLOAD_SUCCESS'; payload: string }
    | { type: 'UPLOAD_ERROR'; payload: string }
    | { type: 'RESET' };

const uploadReducer = (_state: UploadState, action: UploadAction): UploadState => {
    switch (action.type) {
        case 'START_UPLOAD':
            return { status: 'uploading', progress: 0 };
        case 'SET_PROGRESS':
            return { status: 'uploading', progress: action.payload };
        case 'UPLOAD_SUCCESS':
            return { status: 'success', shareLink: action.payload };
        case 'UPLOAD_ERROR':
            return { status: 'error', message: action.payload };
        case 'RESET':
            return { status: 'idle' };
        default:
            return { status: 'idle' };
    }
};

export const useFileUpload = () => {
    const [uploadState, dispatch] = useReducer(uploadReducer, { status: 'idle' });

    const uploadMultipartFile = async (
        file: File,
        item: PresignedItem,
        uploadToken: string,
        onChunkUploaded: (bytes: number) => void
    ) => {
        const totalParts = item.totalParts!;
        const partSizeBytes = item.partSizeBytes!;
        const uploadId = item.uploadId!;
        const storageKey = item.storageKey;

        const presignedUrls = new Map<number, string>();

        const getPartUrl = async (partNumber: number): Promise<string> => {
            if (presignedUrls.has(partNumber)) {
                return presignedUrls.get(partNumber)!;
            }

            const batch = await uploadApi.presignPartBatch({
                uploadToken,
                storageKey,
                uploadId,
                startPartNumber: partNumber,
                count: 20,
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
        const concurrency = Math.min(4, totalParts);

        let currentIndex = 0;
        let activeError: Error | null = null;

        const worker = async () => {
            while (currentIndex < partNumbers.length && !activeError) {
                const partNumber = partNumbers[currentIndex++];
                const start = (partNumber - 1) * partSizeBytes;
                const end = Math.min(start + partSizeBytes, file.size);
                const chunk = file.slice(start, end);

                let attempts = 0;
                let success = false;
                let etag = '';

                while (attempts < 3 && !success) {
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
                onChunkUploaded(chunk.size);
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
    };

    const upload = async (formValues: UploadFormValues, files: File[]) => {
        if (files.length === 0) return;

        dispatch({ type: 'START_UPLOAD' });

        try {
            if (formValues.isEncrypted) {
                const totalBytes = files.reduce((acc, f) => acc + f.size, 0);

                if (files.length > 1 && totalBytes > E2EE_MAX_BUNDLE_BYTES) {
                    dispatch({
                        type: 'UPLOAD_ERROR',
                        payload: 'Encrypted multi-file bundle exceeds the 200 MB browser safety limit.',
                    });
                    return;
                }

                if (files.length === 1 && totalBytes > E2EE_MAX_SINGLE_FILE_BYTES) {
                    dispatch({
                        type: 'UPLOAD_ERROR',
                        payload: 'Encrypted single file exceeds the 1 GB browser safety limit.',
                    });
                    return;
                }

                const key = await cryptoEngine.generateKey();
                const keyString = await cryptoEngine.exportKeyToBase64Url(key);

                let rawPayloadBytes: Uint8Array;
                if (files.length === 1) {
                    rawPayloadBytes = new Uint8Array(await files[0].arrayBuffer());
                } else {
                    rawPayloadBytes = await zipUtils.createZipFromFiles(files);
                }

                const encryptedPayload = await cryptoEngine.encryptBytes(key, rawPayloadBytes);

                const manifestData: FileItemMetadata[] = files.map((f) => ({
                    id: crypto.randomUUID(),
                    fileName: f.name,
                    sizeBytes: f.size,
                    contentType: f.type || 'application/octet-stream',
                }));

                const encryptedManifest = await cryptoEngine.encryptJson(key, manifestData);

                const presign = await uploadApi.getPresignedUrl({
                    title: formValues.title || undefined,
                    files: [
                        {
                            fileName: files.length === 1 ? `${files[0].name}.enc` : 'fileGroup.zip.enc',
                            contentType: 'application/octet-stream',
                            sizeBytes: encryptedPayload.byteLength,
                        },
                    ],
                    expireInHours: Number(formValues.expireInHours),
                    maxDownloads: Number(formValues.maxDownloads),
                    password: formValues.password || undefined,
                    isEncrypted: true,
                });

                const targetItem = (presign.items || (presign as any).Items || [])[0];
                if (!targetItem || !targetItem.uploadUrl) throw new Error('Failed to acquire storage upload URL.');

                const encryptedFileObj = new File([encryptedPayload as BlobPart], targetItem.fileName, {
                    type: 'application/octet-stream',
                });

                await uploadApi.uploadDirectToS3(targetItem.uploadUrl, encryptedFileObj, (percent) => {
                    dispatch({ type: 'SET_PROGRESS', payload: Math.min(percent, 99) });
                });

                dispatch({ type: 'SET_PROGRESS', payload: 100 });

                const shareToken = await uploadApi.confirmUpload({
                    uploadToken: presign.uploadToken,
                    title: formValues.title || undefined,
                    files: [
                        {
                            storageKey: targetItem.storageKey,
                            fileName: targetItem.fileName,
                            contentType: 'application/octet-stream',
                            sizeBytes: encryptedPayload.byteLength,
                        },
                    ],
                    expireInHours: Number(formValues.expireInHours),
                    maxDownloads: Number(formValues.maxDownloads),
                    password: formValues.password || undefined,
                    isEncrypted: true,
                    encryptedManifest: encryptedManifest,
                });

                const fullShareUrl = `${window.location.origin}/f/${shareToken}#key=${keyString}`;
                dispatch({ type: 'UPLOAD_SUCCESS', payload: fullShareUrl });
                return;
            }

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

            const items: PresignedItem[] = presign.items || (presign as any).Items || [];
            const totalBytesAllFiles = files.reduce((acc, f) => acc + f.size, 0);
            const fileUploadedBytes = new Array(files.length).fill(0);

            const syncProgress = () => {
                const totalLoaded = fileUploadedBytes.reduce((acc, b) => acc + b, 0);
                const percent = Math.min(Math.round((totalLoaded / totalBytesAllFiles) * 100), 99);
                dispatch({ type: 'SET_PROGRESS', payload: percent });
            }

            const uploadTasks = items.map(async (item, index) => {
                const currentFile = files[index];

                if (item.uploadMode === 'Multipart') {
                    await uploadMultipartFile(
                        currentFile,
                        item,
                        presign.uploadToken,
                        (chunkSize) => {
                            fileUploadedBytes[index] += chunkSize;
                            syncProgress();
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
            dispatch({ type: 'SET_PROGRESS', payload: 100 });

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

            const fullShareUrl = `${window.location.origin}/f/${shareToken}`;
            dispatch({ type: 'UPLOAD_SUCCESS', payload: fullShareUrl });
        } catch (err: unknown) {
            console.error('Upload Execution Error:', err);
            dispatch({ type: 'UPLOAD_ERROR', payload: parseApiError(err) });
        }
    };

    const reset = () => {
        dispatch({ type: 'RESET' });
    };

    return {
        upload,
        uploadState,
        reset,
    };
};
import { useReducer } from "react";
import { uploadApi } from "../api/uploadApi";
import type { UploadFormValues, UploadState, PresignedItem } from "../types";
import { parseApiError } from "../../../shared/utils/parseApiError";
import { cryptoEngine } from "../../../shared/utils/crypto/cryptoUtils";
import { zipUtils } from "../../../shared/utils/crypto/zipUtils";
import type { FileItemMetadata } from "../../download/types";

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
            return { status: 'uploading', progress: action.payload};
        case 'UPLOAD_SUCCESS':
            return { status: 'success', shareLink: action.payload};
        case 'UPLOAD_ERROR':
            return { status: 'error', message: action.payload};
        case 'RESET':
            return { status: 'idle' };
        default:
            return { status: 'idle' };
    }
};

export const useFileUpload = () => {
    const [uploadState, dispatch] = useReducer(uploadReducer, { status: 'idle' });

    const upload = async (formValues: UploadFormValues, files: File[]) => {
        if (files.length == 0) return;

        dispatch({ type: 'START_UPLOAD' });

        try {

            if (formValues.isEncrypted) {
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
                if (!targetItem) throw new Error('Failed to acquire storage upload URL.');

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

            let completedCount = 0;
            const uploadPromises = items.map((item, index) => {
                const fileToUpload = files[index];
                return uploadApi.uploadDirectToS3(item.uploadUrl, fileToUpload, () => {
                    completedCount += 1;
                    const totalProgress = Math.round((completedCount / (items.length * 100)) * 100);
                    dispatch({ type: 'SET_PROGRESS', payload: Math.min(totalProgress, 99) });
                });
            });

            await Promise.all(uploadPromises);
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
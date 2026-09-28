import { useReducer } from "react";
import { uploadApi } from "../api/uploadApi";
import type { UploadFormValues, UploadState, PresignedItem } from "../types";
import { parseApiError } from "../../../shared/utils/parseApiError";

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
import { useReducer, useRef } from "react";
import type { UploadFormValues, UploadState } from "../types";
import { parseApiError } from "../../../shared/utils/parseApiError";
import {
    executeStandardUploadWorkflow,
    executeEncryptedUploadWorkflow,
} from "../services/uploadWorkflow";

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
    const abortControllerRef = useRef<AbortController | null>(null);

    const upload = async (formValues: UploadFormValues, files: File[]) => {
        if (files.length === 0) return;

        abortControllerRef.current = new AbortController();

        if (formValues.isEncrypted && !formValues.password) {
            dispatch({
                type: 'UPLOAD_ERROR',
                payload: 'A passkey is required for Zero-Knowledge End-to-End Encryption.',
            });
            return;
        }

        dispatch({ type: 'START_UPLOAD' });

        try {
            const shareLink = formValues.isEncrypted
                ? await executeEncryptedUploadWorkflow(
                    formValues,
                    files,
                    (progress) => dispatch({ type: 'SET_PROGRESS', payload: progress }),
                    abortControllerRef.current.signal
                )
                : await executeStandardUploadWorkflow(
                    formValues,
                    files,
                    (progress) => dispatch({ type: 'SET_PROGRESS', payload: progress }),
                    abortControllerRef.current.signal
                );

            dispatch({ type: 'UPLOAD_SUCCESS', payload: shareLink });
        } catch (err: unknown) {
            dispatch({ type: 'UPLOAD_ERROR', payload: parseApiError(err) });
        }
    };

    const reset = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        dispatch({ type: 'RESET' });
    };

    return { upload, uploadState, reset };
};
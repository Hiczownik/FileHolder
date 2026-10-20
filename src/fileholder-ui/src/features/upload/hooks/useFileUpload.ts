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
    | { type: 'UPLOAD_SUCCESS'; payload: { shareLink: string; isEncrypted: boolean } }
    | { type: 'UPLOAD_ERROR'; payload: string }
    | { type: 'RESET' };

type UploadActionHandlers = {
    readonly [K in UploadAction['type']]: (action: Extract<UploadAction, { type: K }>) => UploadState;
};

const uploadActionHandlers: UploadActionHandlers = {
    START_UPLOAD: () => ({ status: 'uploading', progress: 0 }),
    SET_PROGRESS: (action) => ({ status: 'uploading', progress: action.payload }),
    UPLOAD_SUCCESS: (action) => ({ status: 'success', ...action.payload }),
    UPLOAD_ERROR: (action) => ({ status: 'error', message: action.payload }),
    RESET: () => ({ status: 'idle' }),
};

const uploadReducer = (_state: UploadState, action: UploadAction): UploadState => {
    // TypeScript can't correlate the handler with the action's own type, so widen the handler here.
    const handler = uploadActionHandlers[action.type] as (action: UploadAction) => UploadState;
    return handler(action);
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

            dispatch({
                type: 'UPLOAD_SUCCESS',
                payload: { shareLink, isEncrypted: Boolean(formValues.isEncrypted) },
            });
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
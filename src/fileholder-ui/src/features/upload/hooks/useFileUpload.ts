import { useReducer, useRef } from "react";
import { keyModeOf, type MetadataSummary, type UploadFormValues, type UploadState } from "../types";
import { cleanPhotos } from "../services/photoCleaning";
import type { KeyMode } from "../../download/types";
import { parseApiError } from "../../../shared/utils/parseApiError";
import {
    executeStandardUploadWorkflow,
    executeEncryptedUploadWorkflow,
    PASSKEY_REQUIRED_MESSAGE,
} from "../services/uploadWorkflow";

type UploadAction =
    | { type: 'START_UPLOAD'; payload: { preparing: boolean } }
    | { type: 'SET_PROGRESS'; payload: number }
    | { type: 'UPLOAD_SUCCESS'; payload: { shareLink: string; keyMode?: KeyMode; metadataSummary?: MetadataSummary } }
    | { type: 'UPLOAD_ERROR'; payload: string }
    | { type: 'RESET' };

type UploadActionHandlers = {
    readonly [K in UploadAction['type']]: (action: Extract<UploadAction, { type: K }>) => UploadState;
};

const uploadActionHandlers: UploadActionHandlers = {
    START_UPLOAD: (action) => ({ status: 'uploading', progress: 0, preparing: action.payload.preparing }),
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

        const keyMode = keyModeOf(formValues);
        if (keyMode === 'LinkKeyAndPasskey' && !formValues.password) {
            dispatch({ type: 'UPLOAD_ERROR', payload: PASSKEY_REQUIRED_MESSAGE });
            return;
        }

        const signal = abortControllerRef.current.signal;
        const stripMetadata = Boolean(formValues.stripImageMetadata);
        dispatch({ type: 'START_UPLOAD', payload: { preparing: stripMetadata } });

        try {
            // Before presign: upload links are signed for each file's exact size, and cleaning changes it.
            const cleaned = stripMetadata ? await cleanPhotos(files, signal) : undefined;
            const toUpload = cleaned?.files ?? files;
            // Ends the "Preparing files" phase; the upload itself starts at 0%.
            if (cleaned) dispatch({ type: 'SET_PROGRESS', payload: 0 });

            const shareLink = formValues.isEncrypted
                ? await executeEncryptedUploadWorkflow(
                    formValues,
                    toUpload,
                    (progress) => dispatch({ type: 'SET_PROGRESS', payload: progress }),
                    signal
                )
                : await executeStandardUploadWorkflow(
                    formValues,
                    toUpload,
                    (progress) => dispatch({ type: 'SET_PROGRESS', payload: progress }),
                    signal
                );

            dispatch({
                type: 'UPLOAD_SUCCESS',
                payload: { shareLink, keyMode, metadataSummary: cleaned?.summary },
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
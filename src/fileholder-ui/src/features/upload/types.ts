export const E2EE_MAX_BUNDLE_BYTES = 200 * 1024 * 1024; // 200 MB
export const E2EE_MAX_SINGLE_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB
export const STANDARD_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024 * 1024; // 5 TB

export interface UploadFormValues {
    title: string;
    expireInHours: number;
    maxDownloads: number;
    password?: string;
    isEncrypted?: boolean;
}

export type UploadState =
    | { status: 'idle' }
    | { status: 'uploading'; progress: number }
    | { status: 'success'; shareLink: string }
    | { status: 'error'; message: string };
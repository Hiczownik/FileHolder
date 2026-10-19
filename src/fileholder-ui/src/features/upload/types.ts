// Binary units, matching formatSize: 1 KB = 1024 bytes.
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
const BYTES_PER_GB = BYTES_PER_KB * BYTES_PER_MB;
const E2EE_MAX_BUNDLE_MB = 200;
const STANDARD_MAX_TOTAL_GB = 5;

export const E2EE_MAX_BUNDLE_BYTES = E2EE_MAX_BUNDLE_MB * BYTES_PER_MB;
// Encrypted files are encrypted and decrypted whole in browser memory, so each is capped.
export const E2EE_MAX_SINGLE_FILE_BYTES = BYTES_PER_GB;
// Keep in sync with UploadLimits on the server (UploadLimitsOptions.cs).
export const STANDARD_MAX_TOTAL_BYTES = STANDARD_MAX_TOTAL_GB * BYTES_PER_GB;

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
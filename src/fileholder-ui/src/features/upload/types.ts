import type { KeyMode } from "../../types/api";

// Binary units, matching formatSize: 1 KB = 1024 bytes.
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
const BYTES_PER_GB = BYTES_PER_KB * BYTES_PER_MB;
const STANDARD_MAX_TOTAL_GB = 5;

// Applies to encrypted bundles too, measured before encryption: they are encrypted and decrypted a chunk at a
// time, so their size no longer depends on memory. Keep in sync with UploadLimits on the server (UploadLimitsOptions.cs).
export const STANDARD_MAX_TOTAL_BYTES = STANDARD_MAX_TOTAL_GB * BYTES_PER_GB;

export interface UploadFormValues {
    title: string;
    expireInHours: number;
    maxDownloads: number;
    /** A plain bundle's optional password, or an encrypted bundle's passkey when `requirePasskey` is on. */
    password?: string;
    isEncrypted?: boolean;
    /** Encrypted bundles only: the files need the passkey as well as the link's key. */
    requirePasskey?: boolean;
}

export type UploadState =
    | { status: 'idle' }
    | { status: 'uploading'; progress: number }
    /** `keyMode` is set for encrypted bundles only. */
    | { status: 'success'; shareLink: string; keyMode?: KeyMode }
    | { status: 'error'; message: string };

/** How a bundle uploaded with these values is unlocked; undefined for a plain bundle. */
export function keyModeOf(values: UploadFormValues): KeyMode | undefined {
    if (!values.isEncrypted) return undefined;
    return values.requirePasskey ? 'LinkKeyAndPasskey' : 'LinkKey';
}
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
    /** Remove location, camera details and other metadata from photos, in the browser, before upload. */
    stripImageMetadata?: boolean;
}

/** What removing photo metadata did to a bundle's files. */
export interface MetadataSummary {
    /** Photos that had metadata removed. */
    readonly cleaned: number;
    /** Files that may carry metadata but couldn't be cleaned (HEIC, video, unreadable photos), uploaded as they were. */
    readonly notCleaned: readonly string[];
    /** Motion Photos whose video was removed, leaving a still photo. */
    readonly motionPhotos: number;
}

/** What the link-ready card says about the bundle just uploaded. */
export interface BundleSummary {
    /** Empty when the sender gave none. */
    readonly title: string;
    readonly fileCount: number;
    /** As stored: after photo metadata removal, before encryption. */
    readonly totalBytes: number;
    readonly expireInHours: number;
    readonly maxDownloads: number;
}

/** Everything the link-ready card shows. */
export interface UploadResult {
    readonly shareLink: string;
    readonly bundle: BundleSummary;
    /** Set for encrypted bundles only. */
    readonly keyMode?: KeyMode;
    /** Set for link-and-passkey bundles only, so the sender can copy it and send it separately. */
    readonly passkey?: string;
    /** Set when photo metadata removal was on. */
    readonly metadataSummary?: MetadataSummary;
}

export type UploadState =
    | { status: 'idle' }
    /** `preparing`: photo metadata is being removed, before anything is uploaded. */
    | { status: 'uploading'; progress: number; preparing?: boolean }
    | ({ status: 'success' } & UploadResult)
    | { status: 'error'; message: string };

/** How a bundle uploaded with these values is unlocked; undefined for a plain bundle. */
export function keyModeOf(values: UploadFormValues): KeyMode | undefined {
    if (!values.isEncrypted) return undefined;
    return values.requirePasskey ? 'LinkKeyAndPasskey' : 'LinkKey';
}
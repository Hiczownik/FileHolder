import type { SerializedStreamParams } from '../shared/utils/crypto/streamCipher';

export type UploadMode = 'Single' | 'Multipart';

export interface FileItemInput {
    fileName: string;
    contentType: string;
    sizeBytes: number;
}

export interface CreatePresignedUrlRequest {
    title?: string;
    files: FileItemInput[];
    expireInHours?: number;
    maxDownloads?: number;
    password?: string;
    isEncrypted?: boolean;
    /** Unlocks the full limits when access codes are on (#169). */
    accessCode?: string;
}

export interface PresignedItem {
    fileName: string;
    storageKey: string;
    uploadMode: UploadMode;
    uploadUrl?: string;
    uploadId?: string | null;
    partSizeBytes?: number | null;
    totalParts?: number | null;
}

export interface PresignedUrlResponse {
    uploadToken: string;
    items: PresignedItem[];
}

export interface PresignPartBatchRequest {
    uploadToken: string;
    storageKey: string;
    uploadId: string;
    startPartNumber: number;
    count: number;
}

export interface PartPresignedUrl {
    partNumber: number;
    uploadUrl: string;
}

export interface PresignPartBatchResponse {
    parts: PartPresignedUrl[];
}

export interface CompletedPartInput {
    partNumber: number;
    eTag: string;
}

export interface CompleteMultipartUploadRequest {
    uploadToken: string;
    storageKey: string;
    uploadId: string;
    parts: CompletedPartInput[];
}

export interface AbortMultipartUploadRequest {
    uploadToken: string;
    storageKey: string;
    uploadId: string;
}

export interface ConfirmedFileItem {
    storageKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
}

export interface ConfirmUploadRequest {
    uploadToken: string;
    title?: string;
    files: ConfirmedFileItem[];
    expireInHours?: number;
    maxDownloads?: number;
    password?: string;
    isEncrypted?: boolean;
    encryptedManifest?: string;
    keyEnvelope?: string;
    keySalt?: string;
    /** An encrypted bundle's title, encrypted like the manifest; such bundles never send `title`. */
    encryptedTitle?: string;
    /** Required for encrypted bundles, and only allowed there. */
    keyMode?: KeyMode;
    /** The passkey's Argon2id settings (kdfParams.ts): required with a passkey, and only allowed there. */
    kdfParams?: string;
}

/**
 * What a recipient needs to open an encrypted bundle: the key in the share link's fragment (`#k=…`) alone, or
 * that key and a passkey sent separately.
 */
export type KeyMode = 'LinkKey' | 'LinkKeyAndPasskey';

export interface FileItemMetadata {
    id: string;
    fileName: string;
    sizeBytes: number;
    contentType: string;
    /**
     * Only in an encrypted bundle's manifest, where every file has it: how the file was chunk-encrypted.
     * Manifests without it come from an older, whole-file format that can no longer be opened.
     */
    stream?: SerializedStreamParams;
}

export interface FileGroupMetadataResponse {
    shareToken: string;
    title?: string;
    totalSizeBytes: number;
    fileCount: number;
    requiresPassword: boolean;
    isUnlocked: boolean;
    isEncrypted: boolean;
    encryptedManifest?: string;
    keyEnvelope?: string;
    keySalt?: string;
    expiresAt?: string;
    remainingDownloads?: number;
    isExpired: boolean;
    files: FileItemMetadata[];
    /** Only once an encrypted bundle is unlocked; the page decrypts it into `title`. */
    encryptedTitle?: string | null;
    /** Returned while locked too. Null for plain bundles and for encrypted ones from before link keys. */
    keyMode?: KeyMode | null;
    /**
     * Returned while locked too: the passkey's Argon2id settings, for LinkKeyAndPasskey bundles. The uploader wrote
     * them, so they are checked (parseKdfParams) before use. Missing on passkey bundles from before Argon2id.
     */
    kdfParams?: string | null;
}

export interface DownloadUrlResponse {
    downloadUrl: string;
}

export interface DownloadSessionResponse {
    downloadSessionId: string;
    expiresAt: string;
    remainingDownloads: number | null;
}
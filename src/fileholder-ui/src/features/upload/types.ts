export const E2EE_MAX_BUNDLE_BYTES = 200 * 1024 * 1024; // 200 MB
export const E2EE_MAX_SINGLE_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB
export const STANDARD_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024 * 1024; // 5 TB

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
}

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
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
    keyEnvelope?: string;
    keySalt?: string;
}

export interface FileItemMetadata {
    id: string;
    fileName: string;
    sizeBytes: number;
    contentType: string;
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
}

export interface DownloadUrlResponse {
    downloadUrl: string;
}

export interface DownloadSessionResponse {
    downloadSessionId: string;
    expiresAt: string;
    remainingDownloads: number | null;
}
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
}

export interface PresignedItem {
    fileName: string;
    uploadUrl: string;
    storageKey: string;
}

export interface PresignedUrlResponse {
    uploadToken: string;
    items: PresignedItem[];
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
    expiresAt?: string;
    remainingDownloads?: number;
    isExpired: boolean;
    files: FileItemMetadata[];
}

export interface DownloadUrlResponse {
    downloadUrl: string;
}
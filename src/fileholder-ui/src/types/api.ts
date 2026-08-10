export interface CreatePresignedUrlRequest {
    fileName: string;
    contentType: string;
    sizeBytes: number;
    expireInHours?: number;
    maxDownloads?: number;
    password?: string;
}

export interface PresignedUrlResponse {
    uploadUrl: string;
    storageKey: string;
    uploadToken: string;
}

export interface ConfirmuploadRequest {
    uploadToken: string;
    storageKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    expireInHours?: number;
    maxDownloads?: number;
    password?: string;
}

export interface FileMetadataResponse {
    shareToken: string;
    fileName: string;
    sizeBytes: number;
    contentType: string;
    requiresPassword: boolean;
    expiresAt?: string;
    remainingDownloads?: number;
    isExpired: boolean;
}

export interface DownloadUrlResponse {
    downloadUrl: string;
}
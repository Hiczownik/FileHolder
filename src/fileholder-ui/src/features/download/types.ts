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
    expiresAt?: string;
    remainingDownloads?: number;
    isExpired: boolean;
    files: FileItemMetadata[];
}

export interface DownloadUrlResponse {
    downloadUrl: string;
}
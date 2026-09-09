import { useEffect, useState } from 'react';
import { fileApi } from '../api/fileApi';
import type { FileGroupMetadataResponse } from '../types/api';

export const useFileDownload = (shareToken?: string) => {
    const [metadata, setMetadata] = useState<FileGroupMetadataResponse | null>(null);
    const [password, setPassword] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(true);
    const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
    const [isDownloadingAll, setIsDownloadingAll] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (shareToken) {
        setIsLoading(true);
        fileApi
            .getGroupMetadata(shareToken)
            .then((data) => setMetadata(data))
            .catch((err) => {
            if (err.response?.status === 410) {
                setError('This shared file group has expired or reached its maximum download limit.');
            } else {
                setError('File group link not found or deleted.');
            }
            })
            .finally(() => setIsLoading(false));
        }
    }, [shareToken]);

    const handleDownloadFile = async (fileId: string) => {
        if (!shareToken) return;

        setDownloadingFileId(fileId);
        setError(null);

        try {
        const downloadUrl = await fileApi.getDownloadUrl(shareToken, fileId, password || undefined);
        
        // Trigger browser file download
        window.location.href = downloadUrl;
        } catch (err: any) {
        if (err.response?.status === 401) {
            setError('Incorrect password. Please enter the correct password above.');
        } else {
            setError('Failed to generate download link.');
        }
        } finally {
        setDownloadingFileId(null);
        }
    };

    const handleDownloadAllZip = async () => {
        if (!shareToken || !metadata) return;

        setIsDownloadingAll(true);
        setError(null);

        try {
            await fileApi.downloadAllZip(shareToken, metadata.title, password || undefined);
        } catch (err: any) {
            if (err.response?.status === 401) {
                setError('Incorrect password. Please enter the correct password above.');
            } else if (err.response?.status === 410) {
                setError('This shared file group has expired or reached its maximum download limit.');
            } else {
                setError('Failed to generate ZIP download stream.');
            }
        } finally {
            setIsDownloadingAll(false);
        }
    };

    const formatSize = (bytes: number) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    return {
        metadata,
        password,
        isLoading,
        downloadingFileId,
        isDownloadingAll,
        error,
        setPassword,
        handleDownloadFile,
        handleDownloadAllZip,
        formatSize,
    };
};
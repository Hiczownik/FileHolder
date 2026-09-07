import type React from 'react';
import { useState } from 'react';
import { fileApi } from '../api/fileApi';
import type { PresignedItem } from '../types/api';

export const useFileUpload = () => {
    const [files, setFiles] = useState<File[]>([]);
    const [title, setTitle] = useState<string>('');
    const [expireInHours, setExpireInHours] = useState<number>(24);
    const [maxDownloads, setMaxDownloads] = useState<number>(10);
    const [password, setPassword] = useState<string>('');

    const [isUploading, setIsUploading] = useState<boolean>(false);
    const [uploadProgress, setUploadProgress] = useState<number>(0);
    const [shareLink, setShareLink] = useState<string | null>(null);
    const [copied, setCopied] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

    const addFiles = (newFiles: File[]) => {
        setFiles((prev) => 
        {
            const existingKeys = new Set(prev.map((f) => `${f.name}_${f.size}`));
            const uniqueNewFiles = newFiles.filter(
                (f) => !existingKeys.has(`${f.name}_${f.size}`)
            );

            return [...prev, ...uniqueNewFiles];
        });
    };

    const removeFile = (index: number) => {
        setFiles((prev) => prev.filter((_, i) => i !== index));
    };

    const handleUpload = async (e: React.FormEvent) => {
        e.preventDefault();
        if (files.length === 0) return;

        setIsUploading(true);
        setUploadProgress(0);
        setError(null);

        try {
            const presign = await fileApi.getPresignedUrl({
            title: title || undefined,
            files: files.map((f) => ({
                fileName: f.name,
                contentType: f.type || 'application/octet-stream',
                sizeBytes: f.size,
            })),
            expireInHours,
            maxDownloads,
            password: password || undefined,
            });


        const items: PresignedItem[] = presign.items || (presign as any).Items || [];

        let completedCount = 0;
        const uploadPromises = items.map((item, index) => {
            const fileToUpload = files[index];
            return fileApi.uploadDirectToS3(item.uploadUrl, fileToUpload, () => {
            completedCount += 1;
            const totalProgress = Math.round((completedCount / (items.length * 100)) * 100);
            setUploadProgress(Math.min(totalProgress, 99));
            });
        });

        await Promise.all(uploadPromises);
        setUploadProgress(100);

        const shareToken = await fileApi.confirmUpload({
            uploadToken: presign.uploadToken,
            title: title || undefined,
            files: items.map((item, index) => ({
            storageKey: item.storageKey,
            fileName: item.fileName,
            contentType: files[index].type || 'application/octet-stream',
            sizeBytes: files[index].size,
            })),
            expireInHours,
            maxDownloads,
            password: password || undefined,
        });

        const fullShareUrl = `${window.location.origin}/f/${shareToken}`;
        setShareLink(fullShareUrl);
        } catch (err: any) {
        console.error('Upload Error Details:', err);
        
        if (err.response?.data?.errors) {
            const errorMessages = Object.values(err.response.data.errors).flat() as string[];
            setError(errorMessages.join(' '));
        } else if (err.response?.data?.detail) {
            setError(err.response.data.detail);
        } else if (err.response?.data?.title) {
            setError(err.response.data.title);
        } else if (err.message) {
            setError(`Client Error: ${err.message}`);
        } else {
            setError('Upload failed. Please check your file and settings.');
        }
        } finally {
        setIsUploading(false);
        }
    };

    const copyToClipboard = () => {
        if (shareLink) {
        navigator.clipboard.writeText(shareLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        }
    };

    const reset = () => {
        setShareLink(null);
        setFiles([]);
        setTitle('');
        setPassword('');
        setError(null);
    }

    return {
        files,
        title,
        expireInHours,
        maxDownloads,
        password,
        isUploading,
        uploadProgress,
        shareLink,
        copied,
        error,
        setTitle,
        setExpireInHours,
        setMaxDownloads,
        setPassword,
        addFiles,
        removeFile,
        handleUpload,
        copyToClipboard,
        reset
    }
}
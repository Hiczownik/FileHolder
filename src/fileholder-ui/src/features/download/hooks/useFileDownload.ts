import { useEffect, useRef, useState } from "react";
import type { FileGroupMetadataResponse, FileItemMetadata } from "../types";
import { downloadApi } from "../api/downloadApi";
import { parseApiError } from "../../../shared/utils/parseApiError";
import { cryptoEngine } from "../../../shared/utils/crypto/cryptoUtils";

interface ManifestItemInput {
    id?: string;
    fileName?: string;
    filename?: string;
    sizeBytes: number;
    contentType?: string;
}

export const useFileDownload = (shareToken?: string) => {
    const [metadata, setMetadata] = useState<FileGroupMetadataResponse | null>(null);
    const [password, setPassword] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(true);
    const [isUnlocking, setIsUnlocking] = useState<boolean>(false);
    const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
    const [isDownloadingAll, setIsDownloadingAll] = useState<boolean>(false);
    const [activeLeaseToken, setActiveLeaseToken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const serverFileIdRef = useRef<string | null>(null);
    const cryptoKeyRef = useRef<CryptoKey | null>(null);

    const extractKeyFromHash = (): string | null => {
        const hash = window.location.hash;
        const match = hash.match(/(?:^|[#&])key=([A-Za-z0-9_-]+)/);
        return match ? match[1] : null;
    };

    const triggerBlobDownload = (blob: Blob, filename: string) => {
        const objectUrl = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(objectUrl);
    };

    const processMetadata = async (
        rawMetadata: FileGroupMetadataResponse,
        keyString: string | null
    ): Promise<FileGroupMetadataResponse> => {
        if (rawMetadata.files && rawMetadata.files.length > 0 && !serverFileIdRef.current) {
            serverFileIdRef.current = rawMetadata.files[0].id;
        }

        if (!rawMetadata.isEncrypted) {
            return rawMetadata;
        }

        if (!keyString) {
            throw new Error('This transfer is end-to-end encrypted, but no decryption key was found in the link fragment (#key=...).');
        }

        let key = cryptoKeyRef.current;
        if (!key) {
            try {
                key = await cryptoEngine.importKeyFromBase64Url(keyString);
                cryptoKeyRef.current = key;
            } catch {
                throw new Error('Invalid cryptographic key format in share link.');
            }
        }

        if (rawMetadata.requiresPassword && !rawMetadata.isUnlocked) {
            return rawMetadata;
        }

        if (rawMetadata.encryptedManifest) {
            let items: ManifestItemInput[];
            try {
                items = await cryptoEngine.decryptJson<ManifestItemInput[]>(key, rawMetadata.encryptedManifest);
            } catch (err: unknown) {
                if (err instanceof SyntaxError) {
                    throw new Error('Failed to parse decrypted metadata manifest.');
                }
                throw new Error('Decryption failed: Cryptographic authentication mismatch. The link key may be invalid or the data corrupted.');
            }

            const decryptedFiles: FileItemMetadata[] = items.map((item) => ({
                id: item.id || crypto.randomUUID(),
                fileName: item.fileName || item.filename || 'unnamed_file',
                sizeBytes: Number(item.sizeBytes) || 0,
                contentType: item.contentType || 'application/octet-stream',
            }));

            return {
                ...rawMetadata,
                files: decryptedFiles,
                fileCount: decryptedFiles.length,
                totalSizeBytes: decryptedFiles.reduce((acc, f) => acc + f.sizeBytes, 0),
            };
        }

        return rawMetadata;
    };

    useEffect(() => {
        if (shareToken) {
            setIsLoading(true);
            setError(null);
            const keyString = extractKeyFromHash();

            downloadApi
                .getGroupMetadata(shareToken)
                .then(async (data) => {
                    const hydrated = await processMetadata(data, keyString);
                    setMetadata(hydrated);
                })
                .catch((err: unknown) => {
                    setError(parseApiError(err));
                })
                .finally(() => setIsLoading(false));
        }
    }, [shareToken]);

    const handleUnlock = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!shareToken || !password) return;

        setIsUnlocking(true);
        setError(null);

        try {
            const keyString = extractKeyFromHash();
            const unlockedData = await downloadApi.unlockGroup(shareToken, password);
            const hydrated = await processMetadata(unlockedData, keyString);
            setMetadata(hydrated);
        } catch (err: unknown) {
            setError(parseApiError(err));
        } finally {
            setIsUnlocking(false);
        }
    };

    const handleDownloadFile = async (fileId: string) => {
        if (!shareToken || !metadata) return;

        setDownloadingFileId(fileId);
        setError(null);

        try {
            if (metadata.isEncrypted) {
                const targetServerId = serverFileIdRef.current || fileId;
                let key = cryptoKeyRef.current;
                if (!key) {
                    const keyString = extractKeyFromHash();
                    if (!keyString) {
                        throw new Error('This transfer is end-to-end encrypted, but no decryption key was found in the link fragment (#key=...).');
                    }
                    try {
                        key = await cryptoEngine.importKeyFromBase64Url(keyString);
                        cryptoKeyRef.current = key;
                    } catch {
                        throw new Error('Invalid cryptographic key format in share link.');
                    }
                }

                const downloadUrl = await downloadApi.getDownloadUrl(
                    shareToken,
                    targetServerId,
                    password || undefined
                );

                const ciphertextBuffer = await downloadApi.downloadCiphertextBlob(downloadUrl);

                let decryptedBytes: Uint8Array;
                try {
                    decryptedBytes = await cryptoEngine.decryptBytes(
                        key,
                        new Uint8Array(ciphertextBuffer)
                    );
                } catch {
                    throw new Error('Decryption failed: Cryptographic authentication mismatch. The link key may be invalid or the data corrupted.');
                }

                const fileMeta = metadata.files.find((f) => f.id === fileId) || metadata.files[0];
                const contentType = fileMeta?.contentType || 'application/octet-stream';
                const fileName = fileMeta?.fileName || 'downloaded_file';

                const blob = new Blob([decryptedBytes as BlobPart], { type: contentType });
                triggerBlobDownload(blob, fileName);
                return;
            }

            const downloadUrl = await downloadApi.getDownloadUrl(shareToken, fileId, password || undefined);
            window.location.href = downloadUrl;
        } catch (err: unknown) {
            setError(parseApiError(err));
        } finally {
            setDownloadingFileId(null);
        }
    };

    const handleDownloadAllZip = async () => {
        if (!shareToken || !metadata) return;

        setIsDownloadingAll(true);
        setError(null);

        try {
            if (metadata.isEncrypted) {
                const targetServerId = serverFileIdRef.current || metadata.files[0]?.id;
                if (!targetServerId) {
                    throw new Error('Target encrypted storage identifier could not be resolved.');
                }

                let key = cryptoKeyRef.current;
                if (!key) {
                    const keyString = extractKeyFromHash();
                    if (!keyString) {
                        throw new Error('This transfer is end-to-end encrypted, but no decryption key was found in the link fragment (#key=...).');
                    }
                    try {
                        key = await cryptoEngine.importKeyFromBase64Url(keyString);
                        cryptoKeyRef.current = key;
                    } catch {
                        throw new Error('Invalid cryptographic key format in share link.');
                    }
                }

                const downloadUrl = await downloadApi.getDownloadUrl(
                    shareToken,
                    targetServerId,
                    password || undefined
                );

                const ciphertextBuffer = await downloadApi.downloadCiphertextBlob(downloadUrl);

                let decryptedBytes: Uint8Array;
                try {
                    decryptedBytes = await cryptoEngine.decryptBytes(
                        key,
                        new Uint8Array(ciphertextBuffer)
                    );
                } catch {
                    throw new Error('Decryption failed: Cryptographic authentication mismatch. The link key may be invalid or the data corrupted.');
                }

                const blob = new Blob([decryptedBytes as BlobPart], { type: 'application/zip' });
                const safeTitle = metadata.title ? metadata.title.replace(/[^\w\.\-]/g, '_') : 'bundle';
                triggerBlobDownload(blob, `${safeTitle}_${shareToken}.zip`);
                return;
            }

            const issuedLease = await downloadApi.downloadAllZip(
                shareToken,
                metadata.title,
                password || undefined,
                activeLeaseToken
            );

            if (issuedLease) {
                setActiveLeaseToken(issuedLease);
            }
        } catch (err: unknown) {
            setError(parseApiError(err));
        } finally {
            setIsDownloadingAll(false);
        }
    };

    return {
        metadata,
        password,
        isLoading,
        isUnlocking,
        downloadingFileId,
        isDownloadingAll,
        error,
        setPassword,
        handleUnlock,
        handleDownloadFile,
        handleDownloadAllZip,
    };
};
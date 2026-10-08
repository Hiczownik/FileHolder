import { useEffect, useRef, useState } from "react";
import type { FileGroupMetadataResponse } from "../types";
import { downloadApi } from "../api/downloadApi";
import { bundleDecryptionService } from "../services/bundleDecryptionService";
import { saveBlobAsFile, triggerDirectDownload } from "../../../shared/utils/downloadUtils";
import { parseApiError } from "../../../shared/utils/parseApiError";

export const useFileDownload = (shareToken?: string) => {
    const [metadata, setMetadata] = useState<FileGroupMetadataResponse | null>(null);
    const [password, setPassword] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(Boolean(shareToken));
    const [isUnlocking, setIsUnlocking] = useState<boolean>(false);
    const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
    const [isDownloadingAll, setIsDownloadingAll] = useState<boolean>(false);
    const [activeLeaseToken, setActiveLeaseToken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

const serverFileIdRef = useRef<string | null>(null);

    const fetchAndHydrate = async (fetcher: () => Promise<FileGroupMetadataResponse>) => {
        const raw = await fetcher();
        if (raw.files && raw.files.length > 0 && !serverFileIdRef.current) {
            serverFileIdRef.current = raw.files[0].id;
        }
        const keyString = bundleDecryptionService.extractKeyFromHash();
        return bundleDecryptionService.hydrateEncryptedMetadata(raw, keyString);
    };

    useEffect(() => {
        if (!shareToken) return;

        let isCancelled = false;

        const fetchMetadata = async () => {
            try {
                const hydrated = await fetchAndHydrate(() => downloadApi.getGroupMetadata(shareToken));
                if (!isCancelled) {
                    setMetadata(hydrated);
                }
            } catch (err: unknown) {
                if (!isCancelled) {
                    setError(parseApiError(err));
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        };

        void fetchMetadata();

        return () => {
            isCancelled = true;
        };
    }, [shareToken]);

    const handleUnlock = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!shareToken || !password) return;

        setIsUnlocking(true);
        setError(null);

        try {
            const hydrated = await fetchAndHydrate(() => downloadApi.unlockGroup(shareToken, password));
            setMetadata(hydrated);
        } catch (err: unknown) {
            setError(parseApiError(err));
        } finally {
            setIsUnlocking(false);
        }
    };

    const resolveCryptoKey = async (): Promise<CryptoKey> => {
        const keyString = bundleDecryptionService.extractKeyFromHash();
        if (!keyString) {
            throw new Error('This transfer is end-to-end encrypted, but no decryption key was found in the link fragment (#key=...).');
        }
        return bundleDecryptionService.importKey(keyString);
    };

    const handleDownloadFile = async (fileId: string) => {
        if (!shareToken || !metadata) return;

        setDownloadingFileId(fileId);
        setError(null);

        try {
            if (metadata.isEncrypted) {
                const targetServerId = serverFileIdRef.current || fileId;
                const key = await resolveCryptoKey();
                const downloadUrl = await downloadApi.getDownloadUrl(shareToken, targetServerId, password || undefined);
                const ciphertextBuffer = await downloadApi.downloadCiphertextBlob(downloadUrl);
                const decryptedBytes = await bundleDecryptionService.decryptPayload(ciphertextBuffer, key);

                const fileMeta = metadata.files.find((f) => f.id === fileId) || metadata.files[0];
                const blob = new Blob([decryptedBytes as BlobPart], { type: fileMeta?.contentType || 'application/octet-stream' });
                saveBlobAsFile(blob, fileMeta?.fileName || 'downloaded_file');
                return;
            }

            const downloadUrl = await downloadApi.getDownloadUrl(shareToken, fileId, password || undefined);
            triggerDirectDownload(downloadUrl);
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
                const key = await resolveCryptoKey();
                const downloadUrl = await downloadApi.getDownloadUrl(shareToken, targetServerId, password || undefined);
                const ciphertextBuffer = await downloadApi.downloadCiphertextBlob(downloadUrl);
                const decryptedBytes = await bundleDecryptionService.decryptPayload(ciphertextBuffer, key);

                const blob = new Blob([decryptedBytes as BlobPart], { type: 'application/zip' });
                const safeTitle = metadata.title ? metadata.title.replace(/[^\w.-]/g, '_') : 'bundle';
                saveBlobAsFile(blob, `${safeTitle}_${shareToken}.zip`);
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
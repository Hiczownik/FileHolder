import { useEffect, useState } from "react"
import type { FileGroupMetadataResponse } from "../types"
import { downloadApi } from "../api/downloadApi";
import { parseApiError } from "../../../shared/utils/parseApiError";

export const useFileDownload = (shareToken?: string) => {
  const [metadata, setMetadata] = useState<FileGroupMetadataResponse | null>(null);
  const [password, setPassword] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isUnlocking, setIsUnlocking] = useState<boolean>(false);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const [isDownloadingAll, setIsDownloadingAll] = useState<boolean>(false);
  const [activeLeaseToken, setActiveLeaseToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);


    useEffect(() => {
        if (shareToken) {
            setIsLoading(true);
            downloadApi
                .getGroupMetadata(shareToken)
                .then((data) => setMetadata(data))
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
        const unlockedData = await downloadApi.unlockGroup(shareToken, password);
        setMetadata(unlockedData);
        } catch (err: unknown) {
        setError(parseApiError(err));
        } finally {
        setIsUnlocking(false);
        }
    };

    const handleDownloadFile = async (fileId: string) => {
        if (!shareToken) return;

        setDownloadingFileId(fileId);
        setError(null);

        try {
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
import { useEffect, useRef, useState } from "react";
import type { FileGroupMetadataResponse } from "../types";
import { downloadApi } from "../api/downloadApi";
import { bundleDecryptionService } from "../services/bundleDecryptionService";
import { saveBlobAsFile, triggerDirectDownload } from "../../../shared/utils/downloadUtils";
import { parseApiError } from "../../../shared/utils/parseApiError";
import JSZip from "jszip";

const ZIP_COMPRESSION_LEVEL = 6;

export const useFileDownload = (shareToken?: string) => {
    const [metadata, setMetadata] = useState<FileGroupMetadataResponse | null>(null);
    const [password, setPassword] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(Boolean(shareToken));
    const [isUnlocking, setIsUnlocking] = useState<boolean>(false);
    const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
    const [isDownloadingAll, setIsDownloadingAll] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

    const cachedKAuthRef = useRef<string | null>(null);

    useEffect(() => {
        if (!shareToken) return;

        let isCancelled = false;

        const fetchMetadata = async () => {
            try {
                const raw = await downloadApi.getGroupMetadata(shareToken);
                if (!isCancelled) {
                    setMetadata(raw);
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
        if (!shareToken || !password || !metadata) return;

        setIsUnlocking(true);
        setError(null);

        try {
            if (metadata.isEncrypted) {
                if (!metadata.keySalt) {
                    throw new Error('Cryptographic salt is missing from file vault.');
                }

                const { kAuth, kWrap } = await bundleDecryptionService.deriveKAuth(password, metadata.keySalt, shareToken);
                cachedKAuthRef.current = kAuth;

                const unlockedRaw = await downloadApi.unlockGroup(shareToken, kAuth);

                if (!unlockedRaw.keyEnvelope || !unlockedRaw.encryptedManifest) {
                    throw new Error('Encrypted envelope or manifest missing in unlocked response.');
                }

                const masterKey = await bundleDecryptionService.unwrapMasterKey(unlockedRaw.keyEnvelope, kWrap);
                const manifestItems = await bundleDecryptionService.decryptManifest(unlockedRaw.encryptedManifest, masterKey);

                const mappedFiles = bundleDecryptionService.mapManifestToServerFiles(manifestItems, unlockedRaw.files);

                setMetadata({
                    ...unlockedRaw,
                    isUnlocked: true,
                    files: mappedFiles,
                    fileCount: mappedFiles.length,
                    totalSizeBytes: mappedFiles.reduce((acc, f) => acc + f.sizeBytes, 0),
                });
            } else {
                const unlocked = await downloadApi.unlockGroup(shareToken, password);
                setMetadata(unlocked);
            }
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
                const manifestId = bundleDecryptionService.getManifestIdForServerFile(fileId);
                const authCredential = bundleDecryptionService.getKAuth(shareToken) || cachedKAuthRef.current || password;
                const downloadUrl = await downloadApi.getDownloadUrl(shareToken, fileId, authCredential || undefined);
                const ciphertextBuffer = await downloadApi.downloadCiphertextBlob(downloadUrl);
                const decryptedBytes = await bundleDecryptionService.decryptFile(ciphertextBuffer, manifestId);

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
                const zip = new JSZip();
                const authCredential = bundleDecryptionService.getKAuth(shareToken) || cachedKAuthRef.current || password;

                // Sequential on purpose: one file is fetched and decrypted at a time.
                await metadata.files.reduce(async (previous, file) => {
                    await previous;
                    const manifestId = bundleDecryptionService.getManifestIdForServerFile(file.id);
                    const downloadUrl = await downloadApi.getDownloadUrl(shareToken, file.id, authCredential || undefined);
                    const ciphertextBuffer = await downloadApi.downloadCiphertextBlob(downloadUrl);
                    const decryptedBytes = await bundleDecryptionService.decryptFile(ciphertextBuffer, manifestId);

                    zip.file(file.fileName, decryptedBytes);
                }, Promise.resolve());

                const zipBlob = await zip.generateAsync({
                    type: 'blob',
                    compression: 'DEFLATE',
                    compressionOptions: { level: ZIP_COMPRESSION_LEVEL },
                });

                // Replaces every character that is not a word character, dot or hyphen with "_":
                // "Q3 Report/v2" becomes "Q3_Report_v2", while "notes-v1.2" is left unchanged.
                // https://regex101.com/?regex=%5B%5E%5Cw.-%5D&flags=g&testString=Q3%20Report%2Fv2%0Anotes-v1.2
                const safeTitle = metadata.title ? metadata.title.replace(/[^\w.-]/g, '_') : 'bundle';
                saveBlobAsFile(zipBlob, `${safeTitle}_${shareToken}.zip`);
                return;
            }

            await downloadApi.downloadAllZip(
                shareToken,
                metadata.title,
                password || undefined
            );
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
import { useEffect, useState } from "react";
import type { FileGroupMetadataResponse } from "../types";
import { downloadApi } from "../api/downloadApi";
import { bundleDecryptionService } from "../services/bundleDecryptionService";
import { downloadSessionStore } from "../services/downloadSessionStore";
import { saveBlobAsFile, triggerDirectDownload } from "../../../shared/utils/downloadUtils";
import { DownloadCancelledError, saveStreamToDisk } from "../../../shared/utils/download/streamSaving";
import { parseApiError } from "../../../shared/utils/parseApiError";
import { isAxiosError } from "axios";
import JSZip from "jszip";

const HTTP_UNAUTHORIZED = 401;
const ZIP_COMPRESSION_LEVEL = 6;
// The server-side ZIP is a page navigation, which can't be retried on a 401 like an API call. A stored
// session is only reused for it with at least this long left; otherwise a fresh one is opened.
const ZIP_SESSION_MIN_REMAINING_MS = 60_000;
const UNLOCK_AGAIN_MESSAGE = 'This encrypted bundle needs to be unlocked again before downloading. Please reload the page and enter the passkey.';

export const useFileDownload = (shareToken?: string) => {
    const [metadata, setMetadata] = useState<FileGroupMetadataResponse | null>(null);
    const [password, setPassword] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(Boolean(shareToken));
    const [isUnlocking, setIsUnlocking] = useState<boolean>(false);
    const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
    const [isDownloadingAll, setIsDownloadingAll] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

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

    /**
     * For an encrypted bundle the server only ever gets kAuth, derived for this bundle at unlock. Never the
     * passkey itself: that would hand the server what it needs to decrypt the files.
     */
    const getAuthCredential = (token: string, isEncrypted: boolean): string | undefined => {
        if (!isEncrypted) {
            return password || undefined;
        }

        const kAuth = bundleDecryptionService.getKAuth(token);
        if (!kAuth) {
            throw new Error(UNLOCK_AGAIN_MESSAGE);
        }
        return kAuth;
    };

    const openSession = async (token: string, isEncrypted: boolean): Promise<string> => {
        const session = await downloadApi.openDownloadSession(token, getAuthCredential(token, isEncrypted));
        downloadSessionStore.save(token, session);
        setMetadata((prev) => prev ? { ...prev, remainingDownloads: session.remainingDownloads ?? undefined } : prev);
        return session.downloadSessionId;
    };

    /**
     * Runs a download action inside the bundle's download session. One session is one counted download,
     * so it is opened on the first download action and reused for every file and ZIP after that.
     * A stored session the server rejects (expired) is replaced once; a freshly opened one never is,
     * so a failing request can't consume more than one extra download.
     */
    const withDownloadSession = async <T,>(
        token: string,
        isEncrypted: boolean,
        action: (downloadSessionId: string) => Promise<T>
    ): Promise<T> => {
        const stored = downloadSessionStore.get(token);
        if (!stored) {
            return action(await openSession(token, isEncrypted));
        }

        try {
            return await action(stored.id);
        } catch (err: unknown) {
            if (!isAxiosError(err) || err.response?.status !== HTTP_UNAUTHORIZED) {
                throw err;
            }
            downloadSessionStore.clear(token);
            return action(await openSession(token, isEncrypted));
        }
    };

    const handleDownloadFile = async (fileId: string) => {
        if (!shareToken || !metadata) return;

        setDownloadingFileId(fileId);
        setError(null);

        try {
            if (metadata.isEncrypted) {
                const manifestId = bundleDecryptionService.getManifestIdForServerFile(fileId);
                const fileMeta = metadata.files.find((f) => f.id === fileId) || metadata.files[0];
                const fileName = fileMeta?.fileName || 'downloaded_file';
                const decryption = await bundleDecryptionService.createDecryptionTransform(manifestId);
                const downloadUrl = await withDownloadSession(shareToken, true,
                    (sessionId) => downloadApi.getDownloadUrl(shareToken, fileId, sessionId));

                if (decryption) {
                    // Decrypted as it downloads and written to disk as it decrypts: memory stays at about one chunk.
                    const ciphertext = await downloadApi.openCiphertextStream(downloadUrl);
                    const method = await saveStreamToDisk(ciphertext.pipeThrough(decryption), { fileName, sizeBytes: fileMeta?.sizeBytes });
                    // Says which saving method this browser used; handy when checking a new browser or device.
                    console.info(`[FileHolder] Saved "${fileName}" via ${method}.`);
                    return;
                }

                // Bundles in the older one-shot format can only be decrypted whole, in memory.
                const ciphertextBuffer = await downloadApi.downloadCiphertextBlob(downloadUrl);
                const decryptedBytes = await bundleDecryptionService.decryptFile(ciphertextBuffer, manifestId);
                const blob = new Blob([decryptedBytes as BlobPart], { type: fileMeta?.contentType || 'application/octet-stream' });
                saveBlobAsFile(blob, fileName);
                return;
            }

            const downloadUrl = await withDownloadSession(shareToken, false,
                (sessionId) => downloadApi.getDownloadUrl(shareToken, fileId, sessionId));
            triggerDirectDownload(downloadUrl);
        } catch (err: unknown) {
            // Cancelling in the browser's download bar or the save dialog is the user's choice, not an error.
            if (!(err instanceof DownloadCancelledError)) {
                setError(parseApiError(err));
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
            if (metadata.isEncrypted) {
                const zip = new JSZip();

                // Strictly sequential: the first file opens the download session and the rest reuse it.
                // Fetching in parallel would open several sessions and consume several downloads.
                await metadata.files.reduce(async (previous, file) => {
                    await previous;
                    const manifestId = bundleDecryptionService.getManifestIdForServerFile(file.id);
                    const downloadUrl = await withDownloadSession(shareToken, true,
                        (sessionId) => downloadApi.getDownloadUrl(shareToken, file.id, sessionId));
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

            const stored = downloadSessionStore.get(shareToken, new Date(Date.now() + ZIP_SESSION_MIN_REMAINING_MS));
            const sessionId = stored?.id ?? await openSession(shareToken, false);
            downloadApi.downloadAllZip(shareToken, sessionId);
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
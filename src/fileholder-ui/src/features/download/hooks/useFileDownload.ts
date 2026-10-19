import { useEffect, useState } from "react";
import type { FileGroupMetadataResponse } from "../types";
import { downloadApi } from "../api/downloadApi";
import { bundleDecryptionService } from "../services/bundleDecryptionService";
import { downloadSessionStore } from "../services/downloadSessionStore";
import { saveBlobAsFile, triggerDirectDownload } from "../../../shared/utils/downloadUtils";
import { DownloadCancelledError, saveStreamToDisk } from "../../../shared/utils/download/streamSaving";
import { parseApiError } from "../../../shared/utils/parseApiError";
import { isAxiosError } from "axios";
import { makeZip } from "client-zip";

const HTTP_UNAUTHORIZED = 401;
// The server-side ZIP is a page navigation, which can't be retried on a 401 like an API call. A stored
// session is only reused for it with at least this long left; otherwise a fresh one is opened.
const ZIP_SESSION_MIN_REMAINING_MS = 60_000;
interface ZipEntry {
    readonly name: string;
    readonly input: ReadableStream<Uint8Array> | Uint8Array;
}

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

    /**
     * One file of an encrypted bundle, decrypted: a stream for chunk-encrypted files, decrypted as it downloads
     * so it never has to fit in memory, or the whole file for bundles in the older one-shot format.
     */
    const openDecryptedFile = async (token: string, fileId: string): Promise<ReadableStream<Uint8Array> | Uint8Array> => {
        const manifestId = bundleDecryptionService.getManifestIdForServerFile(fileId);
        const decryption = await bundleDecryptionService.createDecryptionTransform(manifestId);
        const downloadUrl = await withDownloadSession(token, true,
            (sessionId) => downloadApi.getDownloadUrl(token, fileId, sessionId));

        if (decryption) {
            return (await downloadApi.openCiphertextStream(downloadUrl)).pipeThrough(decryption);
        }
        return bundleDecryptionService.decryptFile(await downloadApi.downloadCiphertextBlob(downloadUrl), manifestId);
    };

    const handleDownloadFile = async (fileId: string) => {
        if (!shareToken || !metadata) return;

        setDownloadingFileId(fileId);
        setError(null);

        try {
            if (metadata.isEncrypted) {
                const fileMeta = metadata.files.find((f) => f.id === fileId) || metadata.files[0];
                const fileName = fileMeta?.fileName || 'downloaded_file';
                const decrypted = await openDecryptedFile(shareToken, fileId);

                if (decrypted instanceof Uint8Array) {
                    saveBlobAsFile(new Blob([decrypted as BlobPart], { type: fileMeta?.contentType || 'application/octet-stream' }), fileName);
                    return;
                }

                // Written to disk as it decrypts: memory stays at about one chunk.
                const method = await saveStreamToDisk(decrypted, { fileName, sizeBytes: fileMeta?.sizeBytes });
                // Says which saving method this browser used; handy when checking a new browser or device.
                console.info(`[FileHolder] Saved "${fileName}" via ${method}.`);
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
                const token = shareToken;
                const files = metadata.files;

                // client-zip pulls entries one at a time as it writes the archive, so each file is fetched and
                // decrypted only when its turn comes. That keeps them strictly sequential too: the first file
                // opens the download session and the rest reuse it, instead of each consuming a download.
                async function* decryptedEntries(index: number): AsyncGenerator<ZipEntry> {
                    const file = files[index];
                    if (!file) return;
                    yield { name: file.fileName, input: await openDecryptedFile(token, file.id) };
                    yield* decryptedEntries(index + 1);
                }

                // Replaces every character that is not a word character, dot or hyphen with "_":
                // "Q3 Report/v2" becomes "Q3_Report_v2", while "notes-v1.2" is left unchanged.
                // https://regex101.com/?regex=%5B%5E%5Cw.-%5D&flags=g&testString=Q3%20Report%2Fv2%0Anotes-v1.2
                const safeTitle = metadata.title ? metadata.title.replace(/[^\w.-]/g, '_') : 'bundle';
                const zipName = `${safeTitle}_${shareToken}.zip`;
                // Entries are stored uncompressed (encrypted content doesn't compress), with Zip64 past 4 GB.
                const method = await saveStreamToDisk(makeZip(decryptedEntries(0)), { fileName: zipName });
                console.info(`[FileHolder] Saved "${zipName}" via ${method}.`);
                return;
            }

            const stored = downloadSessionStore.get(shareToken, new Date(Date.now() + ZIP_SESSION_MIN_REMAINING_MS));
            const sessionId = stored?.id ?? await openSession(shareToken, false);
            downloadApi.downloadAllZip(shareToken, sessionId);
        } catch (err: unknown) {
            if (!(err instanceof DownloadCancelledError)) {
                setError(parseApiError(err));
            }
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
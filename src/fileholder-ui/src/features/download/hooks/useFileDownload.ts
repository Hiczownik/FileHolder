import { useEffect, useState } from "react";
import type { FileGroupMetadataResponse } from "../types";
import { downloadApi } from "../api/downloadApi";
import { bundleDecryptionService, OLD_FORMAT_MESSAGE } from "../services/bundleDecryptionService";
import { downloadSessionStore } from "../services/downloadSessionStore";
import { linkKeyStore } from "../services/linkKeyStore";
import { readLinkKey } from "../../../shared/utils/shareLink";
import { isWellFormedLinkKey } from "../../../shared/utils/crypto/cryptoUtils";
import { triggerDirectDownload } from "../../../shared/utils/downloadUtils";
import { describeSaveResult, DownloadCancelledError, memoryOnlyLimitProblem, saveStreamToDisk } from "../../../shared/utils/download/streamSaving";
import { countingStream, type DownloadProgress } from "../../../shared/utils/download/progress";
import { parseApiError } from "../../../shared/utils/parseApiError";
import { isConnectionLost } from "../../../shared/utils/connectionErrors";
import { isAxiosError } from "axios";
import { makeZip, predictLength } from "client-zip";

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
// The server-side ZIP is a page navigation, which can't be retried on a 401 like an API call. A stored
// session is only reused for it with at least this long left; otherwise a fresh one is opened.
const ZIP_SESSION_MIN_REMAINING_MS = 60_000;
interface ZipEntry {
    readonly name: string;
    readonly size: number;
    readonly input: ReadableStream<Uint8Array>;
}

// The download session that counted this download stays valid for hours (DownloadTimings.SessionLifetime), so
// trying again soon reuses it instead of counting another download.
const CONNECTION_LOST_MESSAGE = "The connection was lost while downloading. Click Download again: trying again within the next few hours doesn't use up another of this bundle's downloads.";
const UNLOCK_AGAIN_MESSAGE = 'This encrypted bundle needs to be unlocked again before downloading. Please reload the page.';
export const INCOMPLETE_LINK_MESSAGE = 'This link is incomplete, so the files can\'t be opened. Ask the sender for the full link, including the part after "#".';
export const DAMAGED_LINK_MESSAGE = 'This link is damaged, so the files can\'t be opened. Ask the sender for the full link.';
export const WRONG_PASSKEY_MESSAGE = 'Incorrect passkey. If you\'re sure it\'s right, the link may be damaged: ask the sender for the full link.';

export type PromptKind = 'password' | 'passkey';

/** Why the bundle can't be shown at all: it expired or ran out of downloads (`gone`), or no bundle has this link. */
export type Unavailability = 'gone' | 'notFound';

/**
 * Takes the link key out of the address bar, so it doesn't sit on screen, in screenshots or in the tab's history
 * entry. The rest of the URL (such as ?diagnostics) stays. Undefined when the address has no key.
 */
function takeLinkKeyFromAddressBar(): string | undefined {
    const key = readLinkKey(window.location.hash);
    if (key !== undefined) {
        // The router's own history state is kept, so back and forward still work.
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    }
    return key;
}

/** Why this link can't open an encrypted bundle, before asking the server anything; null when it can try. */
function encryptedLinkProblem(metadata: FileGroupMetadataResponse, linkKey: string | null): string | null {
    if (!metadata.isEncrypted || metadata.isUnlocked || metadata.isExpired) return null;
    // Encrypted bundles from before link keys have no key mode, and can no longer be opened.
    if (!metadata.keyMode) return OLD_FORMAT_MESSAGE;
    // No /unlock call is made for these, so a cut-off link never uses up the bundle's password attempts.
    if (!linkKey || !isWellFormedLinkKey(linkKey)) return INCOMPLETE_LINK_MESSAGE;
    return null;
}

/**
 * What the recipient has to type, if anything. Link-only bundles unlock on their own, and a link that can't open
 * the bundle gets an explanation instead of a prompt that could never succeed.
 */
function promptKindFor(metadata: FileGroupMetadataResponse | null, linkKey: string | null): PromptKind | null {
    if (!metadata?.requiresPassword || metadata.isUnlocked) return null;
    if (!metadata.isEncrypted) return 'password';
    if (metadata.keyMode !== 'LinkKeyAndPasskey' || encryptedLinkProblem(metadata, linkKey)) return null;
    return 'passkey';
}

export const useFileDownload = (shareToken?: string) => {
    const [metadata, setMetadata] = useState<FileGroupMetadataResponse | null>(null);
    const [password, setPassword] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(Boolean(shareToken));
    const [isUnlocking, setIsUnlocking] = useState<boolean>(false);
    const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
    const [isDownloadingAll, setIsDownloadingAll] = useState<boolean>(false);
    // How the last encrypted download was saved, for the ?diagnostics panel; the console gets the same line.
    const [lastSaveReport, setLastSaveReport] = useState<string | null>(null);
    // Decrypted bytes so far of the encrypted download in progress, shown on its button; null when none is running.
    const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);

    /** Counts decrypted bytes into downloadProgress; a ZIP's files all add to the same count. */
    const trackProgress = (totalBytes: number | null): (() => TransformStream<Uint8Array, Uint8Array>) => {
        let receivedBytes = 0;
        setDownloadProgress({ receivedBytes, totalBytes });
        return () => countingStream((byteLength) => {
            receivedBytes += byteLength;
            setDownloadProgress({ receivedBytes, totalBytes });
        });
    };
    const [error, setError] = useState<string | null>(null);
    const [unavailable, setUnavailable] = useState<Unavailability | null>(null);

    // This tab's copy of the bundle's link key, read from the address bar on load (see takeLinkKeyFromAddressBar).
    const [linkKey, setLinkKey] = useState<string | null>(null);

    /**
     * Unlocks an encrypted bundle with the keys derived from its link key (and passkey), then decrypts its manifest
     * and title. A refused kAuth means a wrong passkey or a damaged link key: the server can't tell them apart.
     */
    const unlockEncrypted = async (token: string, locked: FileGroupMetadataResponse, key: string, passkey?: string): Promise<void> => {
        setIsUnlocking(true);
        setError(null);

        try {
            if (!locked.keySalt) {
                throw new Error('Cryptographic salt is missing from file vault.');
            }

            const { kAuth, kWrap } = await bundleDecryptionService.deriveKeys(key, locked.keySalt, token, passkey);

            const unlockedRaw = await downloadApi.unlockGroup(token, kAuth);

            if (!unlockedRaw.keyEnvelope || !unlockedRaw.encryptedManifest) {
                throw new Error('Encrypted envelope or manifest missing in unlocked response.');
            }

            const masterKey = await bundleDecryptionService.unwrapMasterKey(unlockedRaw.keyEnvelope, kWrap);
            const manifestItems = await bundleDecryptionService.decryptManifest(unlockedRaw.encryptedManifest, masterKey);

            const mappedFiles = bundleDecryptionService.mapManifestToServerFiles(manifestItems, unlockedRaw.files);
            // The server only ever has the encrypted title; from here on the page uses the decrypted one.
            const title = unlockedRaw.encryptedTitle
                ? await bundleDecryptionService.decryptTitle(unlockedRaw.encryptedTitle, masterKey)
                : undefined;

            setMetadata({
                ...unlockedRaw,
                title,
                isUnlocked: true,
                files: mappedFiles,
                fileCount: mappedFiles.length,
                totalSizeBytes: mappedFiles.reduce((acc, f) => acc + f.sizeBytes, 0),
            });
        } catch (err: unknown) {
            if (isAxiosError(err) && err.response?.status === HTTP_UNAUTHORIZED) {
                setError(passkey === undefined ? DAMAGED_LINK_MESSAGE : WRONG_PASSKEY_MESSAGE);
            } else {
                setError(parseApiError(err));
            }
        } finally {
            setIsUnlocking(false);
        }
    };

    useEffect(() => {
        if (!shareToken) return;

        let isCancelled = false;

        // A key in the address bar wins over a stored one: it is the link the recipient just opened.
        const fromAddressBar = takeLinkKeyFromAddressBar();
        if (fromAddressBar !== undefined) {
            linkKeyStore.save(shareToken, fromAddressBar);
        }
        const key = linkKeyStore.get(shareToken);

        const fetchMetadata = async () => {
            try {
                const raw = await downloadApi.getGroupMetadata(shareToken);
                if (isCancelled) return;

                setLinkKey(key);
                setMetadata(raw);
                if (raw.isExpired) {
                    linkKeyStore.clear(shareToken);
                    setUnavailable('gone');
                    return;
                }

                const problem = encryptedLinkProblem(raw, key);
                if (problem) {
                    setError(problem);
                } else if (raw.isEncrypted && !raw.isUnlocked && raw.keyMode === 'LinkKey' && key) {
                    // The link alone opens these, so there is nothing to ask the recipient.
                    await unlockEncrypted(shareToken, raw, key);
                }
            } catch (err: unknown) {
                if (isCancelled) return;
                if (isAxiosError(err) && (err.response?.status === HTTP_NOT_FOUND || err.response?.status === HTTP_GONE)) {
                    linkKeyStore.clear(shareToken);
                    setUnavailable(err.response.status === HTTP_GONE ? 'gone' : 'notFound');
                }
                setError(parseApiError(err));
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

        if (metadata.isEncrypted) {
            const problem = encryptedLinkProblem(metadata, linkKey);
            if (problem || !linkKey) {
                setError(problem ?? INCOMPLETE_LINK_MESSAGE);
                return;
            }
            await unlockEncrypted(shareToken, metadata, linkKey, password);
            return;
        }

        setIsUnlocking(true);
        setError(null);
        try {
            setMetadata(await downloadApi.unlockGroup(shareToken, password));
        } catch (err: unknown) {
            setError(parseApiError(err));
        } finally {
            setIsUnlocking(false);
        }
    };

    const promptFor = promptKindFor(metadata, linkKey);

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
     * One file of an encrypted bundle, decrypted as it downloads, so it never has to fit in memory.
     */
    const openDecryptedFile = async (token: string, fileId: string): Promise<ReadableStream<Uint8Array>> => {
        const manifestId = bundleDecryptionService.getManifestIdForServerFile(fileId);
        const decryption = await bundleDecryptionService.createDecryptionTransform(manifestId);
        const downloadUrl = await withDownloadSession(token, true,
            (sessionId) => downloadApi.getDownloadUrl(token, fileId, sessionId));

        return (await downloadApi.openCiphertextStream(downloadUrl)).pipeThrough(decryption);
    };

    const handleDownloadFile = async (fileId: string) => {
        if (!shareToken || !metadata) return;

        setDownloadingFileId(fileId);
        setError(null);

        try {
            if (metadata.isEncrypted) {
                const fileMeta = metadata.files.find((f) => f.id === fileId) || metadata.files[0];
                const fileName = fileMeta?.fileName || 'downloaded_file';
                // Before the session opens, so a download that can't succeed never uses up one of the bundle's downloads.
                const tooLarge = memoryOnlyLimitProblem(fileMeta?.sizeBytes ?? 0);
                if (tooLarge) {
                    setError(tooLarge);
                    return;
                }

                const counter = trackProgress(fileMeta?.sizeBytes ?? null);
                const token = shareToken;

                // Written to disk as it decrypts: memory stays at about one chunk. Only opened (and counted as a
                // download) once a saving method is ready to write it.
                const saved = await saveStreamToDisk(
                    async () => (await openDecryptedFile(token, fileId)).pipeThrough(counter()),
                    { fileName, sizeBytes: fileMeta?.sizeBytes }
                );
                // Says which saving method this browser used and why it skipped the others; handy on a new browser or device.
                const report = `Saved "${fileName}" ${describeSaveResult(saved)}.`;
                console.info(`[FileHolder] ${report}`);
                setLastSaveReport(report);
                return;
            }

            const downloadUrl = await withDownloadSession(shareToken, false,
                (sessionId) => downloadApi.getDownloadUrl(shareToken, fileId, sessionId));
            triggerDirectDownload(downloadUrl);
        } catch (err: unknown) {
            // Cancelling in the browser's download bar or the save dialog is the user's choice, not an error.
            if (!(err instanceof DownloadCancelledError)) {
                setError(isConnectionLost(err) ? CONNECTION_LOST_MESSAGE : parseApiError(err));
            }
        } finally {
            setDownloadingFileId(null);
            setDownloadProgress(null);
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

                // The archive's exact size, headers and Zip64 records included, from the names and sizes alone.
                // Checked before the session opens, as for single files, and handed to the saving method so the
                // memory cap and storage quota are checked against what will really be written.
                const zipBytes = Number(predictLength(files.map((file) => ({ name: file.fileName, size: file.sizeBytes }))));
                const tooLarge = memoryOnlyLimitProblem(zipBytes);
                if (tooLarge) {
                    setError(tooLarge);
                    return;
                }
                // Progress counts the files' decrypted bytes, not the ZIP's own headers.
                const counter = trackProgress(files.reduce((total, file) => total + file.sizeBytes, 0));

                // client-zip pulls entries one at a time as it writes the archive, so each file is fetched and
                // decrypted only when its turn comes. That keeps them strictly sequential too: the first file
                // opens the download session and the rest reuse it, instead of each consuming a download. Each
                // entry declares its size, as predictLength assumed.
                async function* decryptedEntries(index: number): AsyncGenerator<ZipEntry> {
                    const file = files[index];
                    if (!file) return;
                    yield { name: file.fileName, size: file.sizeBytes, input: (await openDecryptedFile(token, file.id)).pipeThrough(counter()) };
                    yield* decryptedEntries(index + 1);
                }

                // Replaces every character that is not a word character, dot or hyphen with "_":
                // "Q3 Report/v2" becomes "Q3_Report_v2", while "notes-v1.2" is left unchanged.
                // https://regex101.com/?regex=%5B%5E%5Cw.-%5D&flags=g&testString=Q3%20Report%2Fv2%0Anotes-v1.2
                const safeTitle = metadata.title ? metadata.title.replace(/[^\w.-]/g, '_') : 'bundle';
                const zipName = `${safeTitle}_${shareToken}.zip`;
                // Entries are stored uncompressed (encrypted content doesn't compress), with Zip64 past 4 GB.
                const saved = await saveStreamToDisk(async () => makeZip(decryptedEntries(0)), { fileName: zipName, sizeBytes: zipBytes });
                const report = `Saved "${zipName}" ${describeSaveResult(saved)}.`;
                console.info(`[FileHolder] ${report}`);
                setLastSaveReport(report);
                return;
            }

            const stored = downloadSessionStore.get(shareToken, new Date(Date.now() + ZIP_SESSION_MIN_REMAINING_MS));
            const sessionId = stored?.id ?? await openSession(shareToken, false);
            downloadApi.downloadAllZip(shareToken, sessionId);
        } catch (err: unknown) {
            if (!(err instanceof DownloadCancelledError)) {
                setError(isConnectionLost(err) ? CONNECTION_LOST_MESSAGE : parseApiError(err));
            }
        } finally {
            setIsDownloadingAll(false);
            setDownloadProgress(null);
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
        unavailable,
        lastSaveReport,
        downloadProgress,
        promptFor,
        setPassword,
        handleUnlock,
        handleDownloadFile,
        handleDownloadAllZip,
    };
};
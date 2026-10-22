import React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import { useFileDownload } from './hooks/useFileDownload';
import { BundleHeader } from './components/BundleHeader';
import { BundleUnavailable } from './components/BundleUnavailable';
import { PasswordPrompt } from './components/PasswordPrompt';
import { FileItemRow } from './components/FileItemRow';
import { ZipDownloadButton } from './components/ZipDownloadButton';
import { SaveDiagnostics } from './components/SaveDiagnostics';
import { describeDownloadProgress, type DownloadProgress } from '../../shared/utils/download/progress';
import { Button } from '../../shared/components/Button';
import { StatusAlert } from '../../shared/components/StatusAlert';

const PERCENT = 100;

const CARD = "bg-surface border border-line rounded-2xl p-5 sm:p-7 space-y-6 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.05)]";

/** A bar under the download button, for encrypted downloads whose size is known; the button carries the text. */
const ProgressBar: React.FC<{ progress: DownloadProgress; label: string }> = ({ progress, label }) => {
    if (!progress.totalBytes) return null;
    const percent = Math.min(PERCENT, Math.round((progress.receivedBytes / progress.totalBytes) * PERCENT));
    return (
        <div
            role="progressbar"
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={PERCENT}
            aria-valuenow={percent}
            aria-valuetext={label}
            className="h-2 rounded-full bg-surface-raised overflow-hidden"
        >
            <div className="h-full rounded-full bg-accent-solid transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
        </div>
    );
};

export const DownloadPage: React.FC = () => {
    const { shareToken } = useParams<{ shareToken: string }>();
    // Adding ?diagnostics to a share link shows how this browser saves encrypted downloads (see SaveDiagnostics).
    const [searchParams] = useSearchParams();
    const showDiagnostics = searchParams.has('diagnostics');
    const {
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
    } = useFileDownload(shareToken);

    if (isLoading) {
        return (
            <p role="status" className="max-w-md mx-auto my-24 px-4 text-center text-muted">
                Loading bundle...
            </p>
        );
    }

    if (unavailable) {
        return <BundleUnavailable reason={unavailable} />;
    }

    if (error && !metadata) {
        return (
            <div className="max-w-[640px] mx-auto px-4 py-10 sm:py-14">
                <section aria-labelledby="load-failed-title" className={CARD}>
                    <h1 id="load-failed-title" className="text-2xl font-semibold tracking-tight">This bundle couldn&apos;t be loaded</h1>
                    <StatusAlert variant="error" message={error} />
                    <p className="text-sm text-muted">Reload the page to try again.</p>
                </section>
            </div>
        );
    }

    const isLocked = metadata?.requiresPassword && !metadata?.isUnlocked;
    // A link-only bundle unlocks with the key in its link, so there is nothing to type; a link that can't open the
    // bundle shows only the error explaining why.
    const lockedView = promptFor
        ? <PasswordPrompt kind={promptFor} password={password} isUnlocking={isUnlocking} onPasswordChange={setPassword} onUnlock={handleUnlock} />
        : isUnlocking && <p role="status" className="text-sm text-muted">Unlocking encrypted files...</p>;
    // Encrypted downloads report decrypted bytes; without it a long one looks as if it has stopped.
    const progressText = downloadProgress ? describeDownloadProgress(downloadProgress) : undefined;
    // The hook runs one download at a time, so every other download button waits for it.
    const isBusy = downloadingFileId !== null || isDownloadingAll;
    const files = metadata?.files ?? [];
    const onlyFile = metadata?.fileCount === 1 ? files[0] : undefined;

    return (
        <div className="max-w-[640px] mx-auto px-4 py-10 sm:py-14 space-y-4">
            <section aria-label="Shared bundle" className={CARD}>
                {metadata && <BundleHeader metadata={metadata} />}

                {error && <StatusAlert variant="error" message={error} />}

                {isLocked ? lockedView : (
                    <>
                        <div className="space-y-3">
                            {onlyFile && (
                                <Button
                                    type="button"
                                    variant="primary"
                                    size="lg"
                                    onClick={() => handleDownloadFile(onlyFile.id)}
                                    isLoading={downloadingFileId === onlyFile.id}
                                    loadingText={progressText ?? "Decrypting & Downloading File..."}
                                    className="h-[52px] text-base"
                                >
                                    <Download aria-hidden="true" className="w-[18px] h-[18px]" />
                                    <span>Download file</span>
                                </Button>
                            )}
                            {metadata && metadata.fileCount > 1 && (
                                <ZipDownloadButton
                                    isDownloading={isDownloadingAll}
                                    disabled={downloadingFileId !== null}
                                    onDownloadZip={handleDownloadAllZip}
                                    progressText={isDownloadingAll ? progressText : undefined}
                                />
                            )}
                            {downloadProgress && progressText && <ProgressBar progress={downloadProgress} label={progressText} />}
                        </div>

                        {files.length > 0 && (
                            <div className="space-y-2">
                                <h2 className="text-sm font-semibold text-fg-soft">Files</h2>
                                <ul aria-label="Files in this bundle" className="border border-line rounded-xl max-h-96 overflow-y-auto">
                                    {files.map((file) => (
                                        <FileItemRow
                                            key={file.id}
                                            file={file}
                                            onDownload={onlyFile ? undefined : () => handleDownloadFile(file.id)}
                                            isDownloading={downloadingFileId === file.id}
                                            disabled={isBusy}
                                        />
                                    ))}
                                </ul>
                            </div>
                        )}
                    </>
                )}

                {showDiagnostics && <SaveDiagnostics lastSaveReport={lastSaveReport} />}
            </section>

            {!isLocked && (
                <p className="px-1 text-sm text-muted">
                    Your first download starts a session that lasts up to 6 hours. Downloading again within it, the same
                    files or others, doesn&apos;t use up another of this bundle&apos;s downloads.
                </p>
            )}
        </div>
    );
};

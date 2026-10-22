import React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ShieldAlert, Download, ShieldCheck } from 'lucide-react';
import { useFileDownload } from './hooks/useFileDownload';
import { BundleHeader } from './components/BundleHeader';
import { PasswordPrompt } from './components/PasswordPrompt';
import { FileItemRow } from './components/FileItemRow';
import { ZipDownloadButton } from './components/ZipDownloadButton';
import { SaveDiagnostics } from './components/SaveDiagnostics';
import { describeDownloadProgress } from '../../shared/utils/download/progress';
import { Button } from '../../shared/components/Button';
import { StatusAlert } from '../../shared/components/StatusAlert';

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
            <div className="max-w-md mx-auto my-20 text-center text-muted text-sm">
                Loading bundle details...
            </div>
        );
    }

    if (error && !metadata) {
        return (
            <div className="max-w-md mx-auto my-20 p-8 bg-surface border border-line rounded-2xl text-center space-y-4">
                <div className="p-4 bg-danger-tint rounded-full w-16 h-16 mx-auto flex items-center justify-center text-danger border border-danger/30">
                    <ShieldAlert className="w-8 h-8" />
                </div>
                <h2 className="text-xl font-bold text-fg">Bundle Unavailable</h2>
                <p className="text-muted text-sm">{error}</p>
            </div>
        );
    }

    const isLocked = metadata?.requiresPassword && !metadata?.isUnlocked;
    // A link-only bundle unlocks with the key in its link, so there is nothing to type; a link that can't open the
    // bundle shows only the error explaining why.
    const lockedView = promptFor
        ? <PasswordPrompt kind={promptFor} password={password} isUnlocking={isUnlocking} onPasswordChange={setPassword} onUnlock={handleUnlock} />
        : isUnlocking && <p className="text-center text-sm text-muted">Unlocking encrypted files...</p>;
    // Encrypted downloads report decrypted bytes; without it a long one looks as if it has stopped.
    const progressText = downloadProgress ? describeDownloadProgress(downloadProgress) : undefined;

    return (
        <div className="max-w-xl mx-auto my-12 px-4">
            <div className="bg-surface border border-line rounded-2xl p-6 space-y-6">
                {metadata && (
                    <div className="space-y-4">
                        {metadata.isEncrypted && (
                            <div className="flex items-center">
                                <span className="inline-flex items-center gap-1.5 text-success bg-success-tint border border-success/30 px-2.5 py-1 rounded-full text-[11px] font-medium">
                                    <ShieldCheck className="w-3.5 h-3.5" />
                                    <span>End-to-End Encrypted</span>
                                </span>
                            </div>
                        )}
                        <BundleHeader metadata={metadata} />
                    </div>
                )}

                {error && <StatusAlert variant="error" message={error} />}

                {isLocked ? lockedView : (
                    <>
                        {/* Model B Adaptive Primary Action: Single File Download vs. ZIP Bundle */}
                        {metadata && metadata.fileCount === 1 && metadata.files[0] && (
                            <Button
                                type="button"
                                variant="primary"
                                size="lg"
                                onClick={() => handleDownloadFile(metadata.files[0].id)}
                                isLoading={downloadingFileId === metadata.files[0].id}
                                loadingText={progressText ?? "Decrypting & Downloading File..."}
                            >
                                <Download className="w-4 h-4" />
                                <span>Download File</span>
                            </Button>
                        )}

                        {metadata && metadata.fileCount > 1 && (
                            <ZipDownloadButton
                                fileCount={metadata.fileCount}
                                isDownloading={isDownloadingAll}
                                onDownloadZip={handleDownloadAllZip}
                                progressText={progressText}
                            />
                        )}

                        {/* Clean Read-Only Manifest (No Per-Row Action Buttons) */}
                        <div className="space-y-3">
                            <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
                                Files in Bundle ({metadata?.files.length})
                            </h2>

                            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                                {metadata?.files.map((file) => (
                                    <FileItemRow key={file.id} file={file} />
                                ))}
                            </div>
                        </div>
                    </>
                )}

                {showDiagnostics && <SaveDiagnostics lastSaveReport={lastSaveReport} />}
            </div>
        </div>
    );
};
import React from 'react';
import { useParams } from 'react-router-dom';
import { ShieldAlert, Download } from 'lucide-react';
import { useFileDownload } from './hooks/useFileDownload';
import { BundleHeader } from './components/BundleHeader';
import { PasswordPrompt } from './components/PasswordPrompt';
import { FileItemRow } from './components/FileItemRow';
import { ZipDownloadButton } from './components/ZipDownloadButton';
import { Button } from '../../shared/components/Button';
import { StatusAlert } from '../../shared/components/StatusAlert';

export const DownloadPage: React.FC = () => {
  const { shareToken } = useParams<{ shareToken: string }>();
  const {
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
  } = useFileDownload(shareToken);

  if (isLoading) {
    return (
      <div className="max-w-md mx-auto my-20 text-center text-slate-400 text-sm">
        Loading bundle details...
      </div>
    );
  }

  if (error && !metadata) {
    return (
      <div className="max-w-md mx-auto my-20 p-8 bg-slate-900 border border-slate-800 rounded-2xl text-center space-y-4">
        <div className="p-4 bg-rose-500/10 rounded-full w-16 h-16 mx-auto flex items-center justify-center text-rose-400 border border-rose-500/20">
          <ShieldAlert className="w-8 h-8" />
        </div>
        <h2 className="text-xl font-bold text-white">Bundle Unavailable</h2>
        <p className="text-slate-400 text-sm">{error}</p>
      </div>
    );
  }

  const isLocked = metadata?.requiresPassword && !metadata?.isUnlocked;

  return (
    <div className="max-w-xl mx-auto my-12 px-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
        {metadata && <BundleHeader metadata={metadata} />}

        {error && <StatusAlert variant="error" message={error} />}

        {isLocked ? (
          <PasswordPrompt
            password={password}
            isUnlocking={isUnlocking}
            onPasswordChange={setPassword}
            onUnlock={handleUnlock}
          />
        ) : (
          <>
            {/* Model B Adaptive Primary Action: Single File Download vs. ZIP Bundle */}
            {metadata && metadata.fileCount === 1 && metadata.files[0] && (
              <Button
                type="button"
                variant="primary"
                size="lg"
                onClick={() => handleDownloadFile(metadata.files[0].id)}
                isLoading={downloadingFileId === metadata.files[0].id}
                loadingText="Downloading File..."
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
              />
            )}

            {/* Clean Read-Only Manifest (No Per-Row Buttons) */}
            <div className="space-y-3">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
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
      </div>
    </div>
  );
};
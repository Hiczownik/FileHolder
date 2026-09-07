import React from 'react';
import { useParams } from 'react-router-dom';
import { useFileDownload } from '../hooks/useFileDownload';
import { Download, Lock, FileText, AlertCircle, Clock, ShieldAlert, Folder } from 'lucide-react';

export const DownloadPage: React.FC = () => {
  const { shareToken } = useParams<{ shareToken: string }>();
  const {
    metadata,
    password,
    isLoading,
    downloadingFileId,
    error,
    setPassword,
    handleDownloadFile,
    formatSize,
  } = useFileDownload(shareToken);

  if (isLoading) {
    return (
      <div className="max-w-md mx-auto my-20 text-center text-slate-400 text-sm">
        Loading file details...
      </div>
    );
  }

  if (error && !metadata) {
    return (
      <div className="max-w-md mx-auto my-20 p-8 bg-slate-900 border border-slate-800 rounded-2xl text-center space-y-4">
        <div className="p-4 bg-rose-500/10 rounded-full w-16 h-16 mx-auto flex items-center justify-center text-rose-400 border border-rose-500/20">
          <ShieldAlert className="w-8 h-8" />
        </div>
        <h2 className="text-xl font-bold text-white">Files Unavailable</h2>
        <p className="text-slate-400 text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto my-12 px-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
        <div className="flex items-center gap-4 border-b border-slate-800 pb-6">
          <div className="p-3 bg-indigo-500/10 rounded-xl text-indigo-400 border border-indigo-500/20">
            <Folder className="w-8 h-8" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-white line-clamp-1">
              {metadata?.title || 'Shared File Bundle'}
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              {metadata?.fileCount} {metadata?.fileCount === 1 ? 'file' : 'files'} • {metadata && formatSize(metadata.totalSizeBytes)}
            </p>
          </div>
        </div>

        <div className="space-y-2 text-xs text-slate-400">
          {metadata?.expiresAt && (
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-indigo-400" />
              <span>Expires: {new Date(metadata.expiresAt).toLocaleString()}</span>
            </div>
          )}
          {metadata?.remainingDownloads !== null && metadata?.remainingDownloads !== undefined && (
            <div className="flex items-center gap-2">
              <Download className="w-4 h-4 text-indigo-400" />
              <span>Remaining File Group Downloads: {metadata.remainingDownloads}</span>
            </div>
          )}
        </div>

        {metadata?.requiresPassword && (
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
            <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
              <Lock className="w-4 h-4 text-indigo-400" />
              <span>Password Protected Group</span>
            </label>
            <input
              type="password"
              placeholder="Enter password to enable file downloads"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
            />
          </div>
        )}

        {error && (
          <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="space-y-3">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Files in Group ({metadata?.files.length})
          </h2>

          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {metadata?.files.map((file) => (
              <div
                key={file.id}
                className="flex items-center justify-between bg-slate-950 p-3 rounded-xl border border-slate-800 hover:border-slate-700 transition"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1 pr-3">
                  <FileText className="w-5 h-5 text-indigo-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-200 truncate">{file.fileName}</p>
                    <p className="text-xs text-slate-500">{formatSize(file.sizeBytes)}</p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleDownloadFile(file.id)}
                  disabled={downloadingFileId === file.id}
                  className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs px-3.5 py-2 rounded-lg font-semibold transition flex items-center gap-1.5 shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{downloadingFileId === file.id ? 'Loading...' : 'Download'}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
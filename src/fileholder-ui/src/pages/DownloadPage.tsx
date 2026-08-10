import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fileApi } from '../api/fileApi';
import type { FileMetadataResponse } from '../types/api';
import { Download, Lock, FileText, AlertCircle, Clock, ShieldAlert } from 'lucide-react';

export const DownloadPage: React.FC = () => {
  const { shareToken } = useParams<{ shareToken: string }>();
  const [metadata, setMetadata] = useState<FileMetadataResponse | null>(null);
  const [password, setPassword] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (shareToken) {
      fileApi
        .getMetadata(shareToken)
        .then((data) => setMetadata(data))
        .catch((err) => {
          if (err.response?.status === 410) {
            setError('This file link has expired or reached its maximum download limit.');
          } else {
            setError('File link not found or deleted.');
          }
        })
        .finally(() => setIsLoading(false));
    }
  }, [shareToken]);

  const handleDownload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shareToken) return;

    setIsDownloading(true);
    setError(null);

    try {
      const downloadUrl = await fileApi.getDownloadUrl(shareToken, password || undefined);
      
      // Trigger browser download
      window.location.href = downloadUrl;
    } catch (err: any) {
      if (err.response?.status === 401) {
        setError('Incorrect password. Please try again.');
      } else {
        setError('Failed to generate download link.');
      }
    } finally {
      setIsDownloading(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

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
        <h2 className="text-xl font-bold text-white">Link Unavailable</h2>
        <p className="text-slate-400 text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto my-12 px-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
        <div className="flex items-center gap-4 border-b border-slate-800 pb-6">
          <div className="p-3 bg-indigo-500/10 rounded-xl text-indigo-400 border border-indigo-500/20">
            <FileText className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white line-clamp-1">{metadata?.fileName}</h1>
            <p className="text-xs text-slate-400 mt-0.5">{metadata && formatSize(metadata.sizeBytes)}</p>
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
              <span>Remaining Downloads: {metadata.remainingDownloads}</span>
            </div>
          )}
        </div>

        {error && (
          <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleDownload} className="space-y-4">
          {metadata?.requiresPassword && (
            <div>
              <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5 mb-2">
                <Lock className="w-4 h-4 text-indigo-400" />
                <span>Password Protected</span>
              </label>
              <input
                type="password"
                required
                placeholder="Enter password to download"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={isDownloading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white py-3 rounded-xl font-semibold text-sm transition flex items-center justify-center gap-2"
          >
            <Download className="w-4 h-4" />
            <span>{isDownloading ? 'Preparing File...' : 'Download File'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
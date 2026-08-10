import React, { useState } from 'react';
import { fileApi } from '../api/fileApi';
import { FileDropzone } from '../components/FileDropzone';
import { Lock, Clock, Download, Copy, Check, Sparkles, Loader2 } from 'lucide-react';

export const UploadPage: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [expireInHours, setExpireInHours] = useState<number>(24);
  const [maxDownloads, setMaxDownloads] = useState<number>(10);
  const [password, setPassword] = useState<string>('');

  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setIsUploading(true);
    setUploadProgress(0);
    setError(null);

    try {
      // 1. Request Presigned Upload URL
      const presign = await fileApi.getPresignedUrl({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        expireInHours,
        maxDownloads,
        password: password || undefined,
      });

      // 2. Direct PUT binary payload to S3/MinIO
      await fileApi.uploadDirectToS3(presign.uploadUrl, file, (percent) => {
        setUploadProgress(percent);
      });

      // 3. Confirm Upload & Save Metadata in PostgreSQL
      const shareToken = await fileApi.confirmUpload({
        uploadToken: presign.uploadToken,
        storageKey: presign.storageKey,
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        expireInHours,
        maxDownloads,
        password: password || undefined,
      });

      const fullShareUrl = `${window.location.origin}/f/${shareToken}`;
      setShareLink(fullShareUrl);
    } catch (err: any) {
      // Extract ASP.NET Core ValidationProblem errors dictionary
      if (err.response?.data?.errors) {
        const errorMessages = Object.values(err.response.data.errors).flat() as string[];
        setError(errorMessages.join(' '));
      } else if (err.response?.data?.detail) {
        setError(err.response.data.detail);
      } else if (err.response?.data?.title) {
        setError(err.response.data.title);
      } else {
        setError('Upload failed. Please check your file and settings.');
      }
    } finally {
      setIsUploading(false);
    }
  };

  const copyToClipboard = () => {
    if (shareLink) {
      navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-12 px-4">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-extrabold text-white tracking-tight flex items-center justify-center gap-2">
          Secure File Sharing <Sparkles className="w-6 h-6 text-indigo-400" />
        </h1>
        <p className="text-slate-400 text-sm mt-2">
          Upload files directly to storage with custom expiration rules and password protection.
        </p>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-sm">
          {error}
        </div>
      )}

      {shareLink ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center space-y-6">
          <div className="p-4 bg-emerald-500/10 rounded-full w-16 h-16 mx-auto flex items-center justify-center text-emerald-400 border border-emerald-500/20">
            <Check className="w-8 h-8" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Your File Link is Ready!</h2>
            <p className="text-sm text-slate-400 mt-1">Anyone with this link can view metadata and download the file.</p>
          </div>

          <div className="flex items-center gap-2 bg-slate-950 p-2 rounded-xl border border-slate-800">
            <input
              type="text"
              readOnly
              value={shareLink}
              className="bg-transparent text-indigo-300 text-sm px-3 flex-1 outline-none font-mono"
            />
            <button
              type="button"
              onClick={copyToClipboard}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 transition"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span>{copied ? 'Copied!' : 'Copy'}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setShareLink(null);
              setFile(null);
              setPassword('');
            }}
            className="text-xs text-slate-400 hover:text-slate-200 underline"
          >
            Upload another file
          </button>
        </div>
      ) : (
        <form onSubmit={handleUpload} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
          <FileDropzone selectedFile={file} onFileSelect={setFile} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div>
              <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5 mb-2">
                <Clock className="w-4 h-4 text-indigo-400" />
                <span>Expiration Time</span>
              </label>
              <select
                value={expireInHours}
                onChange={(e) => setExpireInHours(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
              >
                <option value={1}>1 Hour</option>
                <option value={12}>12 Hours</option>
                <option value={24}>24 Hours (1 Day)</option>
                <option value={72}>72 Hours (3 Days)</option>
                <option value={168}>7 Days</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5 mb-2">
                <Download className="w-4 h-4 text-indigo-400" />
                <span>Max Downloads</span>
              </label>
              <select
                value={maxDownloads}
                onChange={(e) => setMaxDownloads(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
              >
                <option value={1}>1 Download (Self-Destruct)</option>
                <option value={5}>5 Downloads</option>
                <option value={10}>10 Downloads</option>
                <option value={50}>50 Downloads</option>
                <option value={100}>100 Downloads</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5 mb-2">
              <Lock className="w-4 h-4 text-indigo-400" />
              <span>Password Protection (Optional)</span>
            </label>
            <input
              type="password"
              placeholder="Leave empty for public link"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
            />
          </div>

          {isUploading && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-slate-400">
                <span>Uploading directly to storage...</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
                <div
                  className="bg-indigo-500 h-full transition-all duration-200"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={!file || isUploading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-3 rounded-xl font-semibold text-sm transition flex items-center justify-center gap-2"
          >
            {isUploading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Processing Upload...</span>
              </>
            ) : (
              <span>Generate Shareable Link</span>
            )}
          </button>
        </form>
      )}
    </div>
  );
};
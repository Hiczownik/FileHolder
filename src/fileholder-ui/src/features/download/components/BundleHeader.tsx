import { Clock, Download, Folder } from "lucide-react";
import type { FileGroupMetadataResponse } from "../types";
import { formatSize } from "../../../shared/utils/formatSize";

interface Props {
    metadata: FileGroupMetadataResponse;
}

export const BundleHeader: React.FC<Props> = ({ metadata }) => {
    return (
        <div className="space-y-4 border-b border-slate-800 pb-6">
            <div className="flex items-center gap-4">
                <div className="p-3 bg-indigo-500/10 rounded-xl text-indigo-400 border border-indigo-500/20">
                    <Folder className="w-8 h-8" />
                </div>
                <div className="flex-1 min-w-0">
                    <h1 className="text-lg font-bold text-white line-clamp-1">
                        {metadata.title || 'Shared File Group'}
                    </h1>
                    <p className="text-xs text-slate-400 mt-0.5">
                        {metadata.fileCount} {metadata.fileCount === 1 ? 'file' : 'files'} • {formatSize(metadata.totalSizeBytes)}
                    </p>
                </div>
            </div>

            <div className="space-y-2 text-xs text-slate-400">
                {metadata.expiresAt && (
                    <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-indigo-400" />
                        <span>Expires: {new Date(metadata.expiresAt).toLocaleString()}</span>
                    </div>
                )}
                {metadata.remainingDownloads !== null && metadata.remainingDownloads !== undefined && (
                    <div className="flex items-center gap-2">
                        <Download className="w-4 h-4 text-indigo-400" />
                        <span>Remaining File Group Downloads: {metadata.remainingDownloads}</span>
                    </div>
                )}
            </div>
        </div>
    );
};
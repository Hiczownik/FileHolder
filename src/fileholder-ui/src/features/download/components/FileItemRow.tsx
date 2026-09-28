import { FileText } from "lucide-react";
import type { FileItemMetadata } from "../types";
import { formatSize } from "../../../shared/utils/formatSize";

interface Props {
  file: FileItemMetadata;
}

export const FileItemRow: React.FC<Props> = ({ file }) => {
  return (
    <div className="flex items-center justify-between bg-slate-950 p-3 rounded-xl border border-slate-800 hover:border-slate-700/80 transition">
      <div className="flex items-center gap-3 min-w-0 flex-1 pr-3">
        <FileText className="w-5 h-5 text-indigo-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-200 truncate">{file.fileName}</p>
          <p className="text-xs text-slate-500">{formatSize(file.sizeBytes)}</p>
        </div>
      </div>
    </div>
  );
};
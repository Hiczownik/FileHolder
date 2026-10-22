import { FileText } from "lucide-react";
import type { FileItemMetadata } from "../types";
import { formatSize } from "../../../shared/utils/formatSize";

interface Props {
  file: FileItemMetadata;
}

export const FileItemRow: React.FC<Props> = ({ file }) => {
  return (
    <div className="flex items-center justify-between bg-canvas p-3 rounded-xl border border-line hover:border-line-strong transition">
      <div className="flex items-center gap-3 min-w-0 flex-1 pr-3">
        <FileText className="w-5 h-5 text-accent shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg truncate">{file.fileName}</p>
          <p className="text-xs text-muted">{formatSize(file.sizeBytes)}</p>
        </div>
      </div>
    </div>
  );
};
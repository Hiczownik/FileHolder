import { Download, FileText, Loader2 } from "lucide-react";
import type { FileItemMetadata } from "../types";
import { formatSize } from "../../../shared/utils/formatSize";

interface Props {
  file: FileItemMetadata;
  /** Absent for a single-file bundle, whose main button already downloads its only file. */
  onDownload?: () => void;
  /** This file is the one downloading now. */
  isDownloading?: boolean;
  /** Another download is running; the hook runs one at a time. */
  disabled?: boolean;
}

export const FileItemRow: React.FC<Props> = ({ file, onDownload, isDownloading = false, disabled = false }) => {
  return (
    <li className="flex items-center gap-3 border-t border-line first:border-t-0 py-1.5 pl-3.5 pr-1.5 min-h-14">
      <FileText aria-hidden="true" className="w-[18px] h-[18px] text-muted shrink-0" />
      <span className="flex-1 min-w-0 truncate">{file.fileName}</span>
      <span className="text-[13px] text-muted tabular-nums shrink-0">{formatSize(file.sizeBytes)}</span>
      {onDownload && (
        <button
          type="button"
          onClick={onDownload}
          disabled={disabled || isDownloading}
          aria-label={`Download ${file.fileName}`}
          title={`Download ${file.fileName}`}
          className="w-11 h-11 shrink-0 flex items-center justify-center rounded-lg text-accent hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {isDownloading
            ? <Loader2 aria-hidden="true" className="w-[18px] h-[18px] animate-spin motion-reduce:animate-none" />
            : <Download aria-hidden="true" className="w-[18px] h-[18px]" />}
        </button>
      )}
    </li>
  );
};

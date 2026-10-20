import { Archive } from "lucide-react";
import { Button } from "../../../shared/components/Button";

interface Props {
    fileCount: number;
    isDownloading: boolean;
    onDownloadZip: () => void;
    /** Shown while downloading instead of the generic text, e.g. "Decrypting… 640 MB of 1.5 GB". */
    progressText?: string;
}

export const ZipDownloadButton: React.FC<Props> = ({ fileCount, isDownloading, onDownloadZip, progressText }) => {
    return (
        <Button
            type="button"
            variant="secondary"
            size="md"
            onClick={onDownloadZip}
            isLoading={isDownloading}
            loadingText={progressText ?? "Streaming & Compressing ZIP..."}
            className="w-full text-indigo-400 hover:border-indigo-500/50"
        >
            <Archive className="w-4 h-4" />
            <span>Download All ({fileCount} Files) as ZIP</span>
        </Button>
    );
};
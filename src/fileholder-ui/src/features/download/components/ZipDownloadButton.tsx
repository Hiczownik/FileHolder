import { Archive } from "lucide-react";
import { Button } from "../../../shared/components/Button";

interface Props {
    fileCount: number;
    isDownloading: boolean;
    onDownloadZip: () => void;
}

export const ZipDownloadButton: React.FC<Props> = ({ fileCount, isDownloading, onDownloadZip }) => {
    return (
        <Button
            type="button"
            variant="secondary"
            size="md"
            onClick={onDownloadZip}
            isLoading={isDownloading}
            loadingText="Streaming & Compressing ZIP..."
            className="w-full text-indigo-400 hover:border-indigo-500/50"
        >
            <Archive className="w-4 h-4" />
            <span>Download All ({fileCount} Files) as ZIP</span>
        </Button>
    );
};
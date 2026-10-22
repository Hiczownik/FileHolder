import { Archive } from "lucide-react";
import { Button } from "../../../shared/components/Button";

interface Props {
    isDownloading: boolean;
    /** Another download (a single file) is running; the hook runs one at a time. */
    disabled?: boolean;
    onDownloadZip: () => void;
    /** Shown while downloading instead of the generic text, e.g. "Decrypting… 640 MB of 1.5 GB". */
    progressText?: string;
}

export const ZipDownloadButton: React.FC<Props> = ({ isDownloading, disabled = false, onDownloadZip, progressText }) => {
    return (
        <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={onDownloadZip}
            disabled={disabled}
            isLoading={isDownloading}
            loadingText={progressText ?? "Preparing ZIP..."}
            className="h-[52px] text-base"
        >
            <Archive aria-hidden="true" className="w-[18px] h-[18px]" />
            <span>Download all as ZIP</span>
        </Button>
    );
};

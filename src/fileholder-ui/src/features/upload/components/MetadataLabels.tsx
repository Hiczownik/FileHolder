import type { FileFormat, MetadataReport } from "../../../shared/utils/imageMetadata";

interface Props {
    report: MetadataReport | undefined;
    /** Whether "Remove photo metadata" is on. */
    stripMetadata: boolean;
}

/** Why a file's metadata can't be removed, by format. A JPEG, PNG or WebP here is one too damaged to read. */
const UNREMOVABLE_REASON: Readonly<Record<FileFormat, string>> = {
    heic: 'HEIC',
    avif: 'AVIF',
    tiff: 'TIFF/RAW',
    video: 'video',
    jpeg: 'unreadable',
    png: 'unreadable',
    webp: 'unreadable',
    other: 'unsupported',
};

// Kept on one line where there is room; on phones a long label wraps instead of running off the row.
const BADGE = "px-1.5 py-0.5 rounded border text-[10px] font-medium sm:whitespace-nowrap";

/**
 * A file's metadata labels in the selected-files list. The location warning shows even with removal off, so
 * nobody shares where a photo was taken by accident.
 */
export const MetadataLabels: React.FC<Props> = ({ report, stripMetadata }) => {
    if (!report) return null;

    const willRemove = stripMetadata && report.removable.length > 0;
    const cantRemove = stripMetadata && report.unremovable;
    if (!report.hasLocation && !willRemove && !cantRemove) return null;

    // Below the name on phones (too narrow for both), after it from "sm" up.
    return (
        <span className="flex flex-wrap gap-1 pl-6 sm:pl-0 sm:shrink-0">
            {report.hasLocation && (
                <span
                    className={`${BADGE} text-warning bg-warning-tint border-warning/30`}
                    title={stripMetadata ? 'Its location is removed before upload.' : 'Turn on "Remove photo metadata" to remove it before upload.'}
                >
                    📍 Contains location
                </span>
            )}
            {willRemove && (
                <span className={`${BADGE} text-success bg-success-tint border-success/30`} title={`Removes: ${report.removable.join(', ')}`}>
                    {report.isMotionPhoto ? 'Metadata will be removed; Motion Photo becomes a still' : 'Metadata will be removed'}
                </span>
            )}
            {cantRemove && (
                <span className={`${BADGE} text-fg-soft bg-surface-raised border-line`} title="Uploaded as it is, metadata included.">
                    Metadata can&apos;t be removed ({UNREMOVABLE_REASON[report.format]})
                </span>
            )}
        </span>
    );
};

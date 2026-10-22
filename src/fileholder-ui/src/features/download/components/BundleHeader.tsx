import { Clock, Download, ShieldCheck } from "lucide-react";
import type { FileGroupMetadataResponse } from "../types";
import { formatSize } from "../../../shared/utils/formatSize";
import { describeTimeLeft, formatShortDateTime } from "../../../shared/utils/timeLeft";

interface Props {
    metadata: FileGroupMetadataResponse;
}

/** An encrypted bundle's title is only known once it is unlocked, so until then the heading says what it is. */
const headingOf = (metadata: FileGroupMetadataResponse): string => {
    if (metadata.title) return metadata.title;
    return metadata.isEncrypted && !metadata.isUnlocked ? 'Encrypted bundle' : 'Shared files';
};

// Only <dt> and <dd> may sit in a <dl>'s item, so the icon goes inside the term.
const Fact: React.FC<{ icon: React.ReactNode; term: string; children: React.ReactNode }> = ({ icon, term, children }) => (
    <div className="rounded-[10px] bg-surface-raised px-3.5 py-3">
        <dt className="flex items-center gap-1.5 text-[13px] text-muted">{icon}{term}</dt>
        <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
);

export const BundleHeader: React.FC<Props> = ({ metadata }) => {
    const expiresAt = metadata.expiresAt ? new Date(metadata.expiresAt) : null;
    const hasRemaining = metadata.remainingDownloads !== null && metadata.remainingDownloads !== undefined;

    return (
        <div className="space-y-5">
            <div className="space-y-2.5">
                {metadata.isEncrypted && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-success-tint px-2.5 py-1 text-[13px] font-semibold text-success">
                        <ShieldCheck aria-hidden="true" className="w-3.5 h-3.5" />
                        <span>End-to-end encrypted</span>
                    </span>
                )}
                <h1 className="text-[26px] leading-tight font-semibold tracking-tight break-words">{headingOf(metadata)}</h1>
                <p className="text-sm text-muted">
                    {metadata.fileCount} {metadata.fileCount === 1 ? 'file' : 'files'}
                    {/* A locked encrypted bundle reports no size until it's unlocked; "0 Bytes" would be wrong. */}
                    {(metadata.totalSizeBytes > 0 || metadata.isUnlocked || !metadata.requiresPassword) && ` · ${formatSize(metadata.totalSizeBytes)}`}
                </p>
            </div>

            {(expiresAt || hasRemaining) && (
                <dl className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
                    {expiresAt && (
                        <Fact icon={<Clock aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />} term="Expires">
                            {describeTimeLeft(expiresAt)}{' '}
                            <span className="font-normal text-muted">· {formatShortDateTime(expiresAt)}</span>
                        </Fact>
                    )}
                    {hasRemaining && (
                        <Fact icon={<Download aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />} term="Downloads left">
                            {metadata.remainingDownloads}
                        </Fact>
                    )}
                </dl>
            )}
        </div>
    );
};

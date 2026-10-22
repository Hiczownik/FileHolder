import { useEffect, useRef } from "react";
import { AlertTriangle, Check, Info } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { CopyButton } from "../../../shared/components/CopyButton";
import { Button } from "../../../shared/components/Button";
import { formatSize } from "../../../shared/utils/formatSize";
import type { KeyMode } from "../../download/types";
import type { UploadResult } from "../types";
import { describeMetadataSummary } from "../services/photoCleaning";

interface Props {
    result: UploadResult;
    onReset: () => void;
}

const HOURS_PER_DAY = 24;

const PROTECTION_LABELS: Readonly<Record<KeyMode | 'none', string>> = {
    none: 'Standard',
    LinkKey: 'Encrypted, link only',
    LinkKeyAndPasskey: 'Link and passkey',
};

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`;

/** "in 12 hours", "in 3 days": the expiry options are whole hours below a day and whole days above. */
const describeExpiry = (hours: number): string =>
    hours < HOURS_PER_DAY ? `in ${plural(hours, 'hour')}` : `in ${plural(hours / HOURS_PER_DAY, 'day')}`;

const FIELD = "flex-1 basis-60 min-w-0 h-12 px-3 rounded-[10px] border border-line-strong bg-canvas font-mono outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

export const UploadSuccessCard: React.FC<Props> = ({ result, onReset }) => {
    const { shareLink, bundle, keyMode, passkey, metadataSummary } = result;
    const headingRef = useRef<HTMLHeadingElement>(null);
    const metadataNote = metadataSummary ? describeMetadataSummary(metadataSummary) : null;
    const summary = [bundle.title, plural(bundle.fileCount, 'file'), formatSize(bundle.totalBytes)].filter(Boolean).join(' · ');

    // The form this replaces may have been scrolled down to its button; this brings the result into view and has
    // screen readers announce it.
    useEffect(() => {
        headingRef.current?.focus();
    }, []);

    return (
        <section
            aria-labelledby="link-ready-title"
            className="bg-surface border border-line rounded-2xl p-6 sm:p-8 space-y-6 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.05)]"
        >
            <div className="flex gap-4 items-start">
                <span className="w-11 h-11 rounded-full bg-success-tint text-success flex items-center justify-center shrink-0">
                    <Check aria-hidden="true" className="w-[22px] h-[22px]" strokeWidth={2.4} />
                </span>
                <div className="min-w-0 space-y-1">
                    <h1 id="link-ready-title" ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
                        Your link is ready
                    </h1>
                    <p className="text-sm text-muted break-words">{summary}</p>
                </div>
            </div>

            <dl className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
                {[
                    { term: 'Expires', value: describeExpiry(bundle.expireInHours) },
                    { term: 'Downloads', value: `${bundle.maxDownloads} allowed` },
                    { term: 'Protection', value: PROTECTION_LABELS[keyMode ?? 'none'] },
                ].map((fact) => (
                    <div key={fact.term} className="rounded-[10px] bg-surface-raised px-3.5 py-3">
                        <dt className="text-[13px] text-muted">{fact.term}</dt>
                        <dd className="mt-0.5 font-medium">{fact.value}</dd>
                    </div>
                ))}
            </dl>

            <div>
                <label htmlFor="share-link" className="block text-sm font-medium mb-1.5">Share link</label>
                <div className="flex flex-wrap gap-2">
                    <input id="share-link" type="text" readOnly value={shareLink} className={`${FIELD} text-[13px]`} />
                    <CopyButton text={shareLink} label="Copy link" size="md" className="h-12 px-[18px]" />
                </div>
            </div>

            {passkey && (
                <div>
                    <label htmlFor="share-passkey" className="block text-sm font-medium mb-1.5">Passkey</label>
                    <div className="flex flex-wrap gap-2">
                        <input id="share-passkey" type="text" readOnly value={passkey} className={`${FIELD} basis-48 tracking-[0.08em]`} />
                        <CopyButton text={passkey} label="Copy passkey" variant="outline" size="md" className="h-12 px-[18px]" />
                    </div>
                </div>
            )}

            {keyMode === 'LinkKey' && (
                <p role="note" className="flex gap-2.5 rounded-[10px] bg-warning-tint text-warning text-sm px-3.5 py-3">
                    <AlertTriangle aria-hidden="true" className="w-[18px] h-[18px] shrink-0 mt-0.5" />
                    <span>Anyone with this link or QR code can open the files.</span>
                </p>
            )}
            {keyMode === 'LinkKeyAndPasskey' && (
                <p role="note" className="flex gap-2.5 rounded-[10px] bg-accent-tint text-accent text-sm px-3.5 py-3">
                    <Info aria-hidden="true" className="w-[18px] h-[18px] shrink-0 mt-0.5" />
                    <span>Send the passkey in a different message or app. The link alone won&apos;t open the files.</span>
                </p>
            )}
            {metadataNote && <p className="text-sm text-muted">{metadataNote}</p>}

            <details className="group border-t border-line pt-4">
                <summary className="cursor-pointer font-medium min-h-11 flex items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    Show QR code
                </summary>
                <div className="flex flex-wrap items-center gap-5 pt-3">
                    {/* Drawn locally: the link must never be sent to a QR service. Dark on white with a margin in
                        both themes, so phone cameras can read it. */}
                    <QRCodeSVG
                        value={shareLink}
                        size={168}
                        level="M"
                        marginSize={4}
                        bgColor="#ffffff"
                        fgColor="#020617"
                        title="QR code for the share link"
                        className="rounded-xl border border-line shrink-0"
                    />
                    <p className="flex-1 basis-48 text-sm text-muted">
                        Scan it to open the link on another device. It&apos;s drawn in your browser; the link is never
                        sent to a QR service.
                    </p>
                </div>
            </details>

            <Button type="button" variant="outline" size="md" onClick={onReset} className="min-h-11">
                Share another bundle
            </Button>
        </section>
    );
};

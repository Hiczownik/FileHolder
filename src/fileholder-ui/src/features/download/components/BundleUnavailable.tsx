import { useEffect, useRef } from "react";
import { Clock, Link2Off, ShieldX, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import type { Unavailability } from "../hooks/useFileDownload";

interface Props {
    reason: Unavailability;
}

const TEXT: Readonly<Record<Unavailability, { title: string; explanation: string; next: string }>> = {
    gone: {
        title: 'This bundle is no longer available',
        explanation: "It has expired or run out of downloads, and its files are deleted automatically. That's how FileHolder is meant to work.",
        next: 'If you still need the files, ask the sender for a new link.',
    },
    removed: {
        title: 'This bundle was removed by FileHolder',
        explanation: 'FileHolder removes bundles reported as harmful, such as phishing or malware, and deletes their files.',
        next: "If you weren't expecting files from the sender, be careful with anything else they sent you.",
    },
    notFound: {
        title: "This link doesn't open a bundle",
        explanation: 'It may have been copied incompletely, or the bundle no longer exists.',
        next: 'Ask the sender for the link again.',
    },
};

const ICONS: Readonly<Record<Unavailability, LucideIcon>> = { gone: Clock, removed: ShieldX, notFound: Link2Off };

/** Not an error to fix: the bundle has gone, as bundles are meant to. Calm, with the one thing the reader can do. */
export const BundleUnavailable: React.FC<Props> = ({ reason }) => {
    const text = TEXT[reason];
    const Icon = ICONS[reason];
    const headingRef = useRef<HTMLHeadingElement>(null);

    // The page was "Loading bundle…" a moment ago; moving focus here has screen readers announce the outcome.
    useEffect(() => {
        headingRef.current?.focus();
    }, []);

    return (
        <section aria-labelledby="unavailable-title" className="max-w-[520px] mx-auto px-6 py-16 sm:py-24 space-y-4">
            <span className="w-14 h-14 rounded-full bg-surface-raised text-muted flex items-center justify-center">
                <Icon aria-hidden="true" className="w-[26px] h-[26px]" strokeWidth={1.8} />
            </span>
            <h1 id="unavailable-title" ref={headingRef} tabIndex={-1} className="text-[26px] leading-tight font-semibold tracking-tight outline-none">
                {text.title}
            </h1>
            <p className="text-fg-soft">{text.explanation}</p>
            <p className="text-muted">{text.next}</p>
            <Link
                to="/"
                className="inline-flex items-center min-h-12 mt-3 px-[18px] rounded-xl border border-line-strong font-semibold text-fg hover:bg-surface-raised outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
                Share your own files
            </Link>
        </section>
    );
};

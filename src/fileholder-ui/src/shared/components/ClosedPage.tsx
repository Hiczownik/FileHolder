import { useEffect, useRef } from 'react';
import { Moon } from 'lucide-react';
import { describeUntil, type ServiceStatus } from '../services/serviceStatus';

/** Instead of every page while the owner has closed FileHolder (the Closed mode). */
export const ClosedPage: React.FC<{ status: ServiceStatus }> = ({ status }) => {
    const headingRef = useRef<HTMLHeadingElement>(null);
    const until = describeUntil(status.until);

    // Like a bundle that's gone: focus the outcome, so screen readers announce it.
    useEffect(() => {
        headingRef.current?.focus();
    }, []);

    return (
        <section aria-labelledby="closed-title" className="max-w-[520px] mx-auto px-6 py-16 sm:py-24 space-y-4">
            <span className="w-14 h-14 rounded-full bg-surface-raised text-muted flex items-center justify-center">
                <Moon aria-hidden="true" className="w-[26px] h-[26px]" strokeWidth={1.8} />
            </span>
            <h1 id="closed-title" ref={headingRef} tabIndex={-1} className="text-[26px] leading-tight font-semibold tracking-tight outline-none">
                FileHolder is closed for now
            </h1>
            <p className="text-fg-soft">{status.message ?? "Nothing can be uploaded or downloaded at the moment."}</p>
            <p className="text-muted">{until ?? 'Please check back later.'} Shared links that haven&apos;t expired will work again then.</p>
        </section>
    );
};

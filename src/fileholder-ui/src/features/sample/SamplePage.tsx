import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PackageOpen } from 'lucide-react';
import { parseSamplePointer, SAMPLE_POINTER_PATH } from './samplePointer';

const LINK = 'underline underline-offset-2 text-fg hover:text-accent rounded outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** Asks nginx for the current sample bundle; undefined when there's none or the answer isn't one. */
async function findSample(): Promise<string | undefined> {
    try {
        // Renewed every few hours, so never from a cache.
        const response = await fetch(SAMPLE_POINTER_PATH, { cache: 'no-store' });
        if (!response.ok) return undefined;
        return parseSamplePointer(await response.json(), window.location.origin)?.link;
    } catch {
        return undefined;
    }
}

/**
 * `/sample`, the address the README links (#82): forwards to the current sample bundle, an encrypted bundle anyone
 * can open, which the sample keeper replaces every few hours.
 */
export const SamplePage: React.FC = () => {
    const navigate = useNavigate();
    const [missing, setMissing] = useState(false);
    const headingRef = useRef<HTMLHeadingElement>(null);

    useEffect(() => {
        let active = true;
        const forward = async (): Promise<void> => {
            const link = await findSample();
            if (!active) return;
            if (link === undefined) {
                setMissing(true);
                return;
            }
            const url = new URL(link);
            // Replaced, so Back leaves the sample rather than returning here and forwarding again.
            void navigate(`${url.pathname}${url.hash}`, { replace: true });
        };
        void forward();
        return () => {
            active = false;
        };
    }, [navigate]);

    // Like a bundle that's gone: focus the outcome, so screen readers announce it.
    useEffect(() => {
        if (missing) headingRef.current?.focus();
    }, [missing]);

    if (!missing) {
        return <p role="status" className="max-w-[520px] mx-auto px-6 py-16 text-muted">Opening the sample bundle…</p>;
    }

    return (
        <section aria-labelledby="sample-title" className="max-w-[520px] mx-auto px-6 py-16 sm:py-24 space-y-4">
            <span className="w-14 h-14 rounded-full bg-surface-raised text-muted flex items-center justify-center">
                <PackageOpen aria-hidden="true" className="w-[26px] h-[26px]" strokeWidth={1.8} />
            </span>
            <h1 id="sample-title" ref={headingRef} tabIndex={-1} className="text-[26px] leading-tight font-semibold tracking-tight outline-none">
                The sample bundle isn&apos;t available right now
            </h1>
            <p className="text-fg-soft">A new one is made every few hours. Please try again later, or <Link to="/" className={LINK}>share files of your own</Link>.</p>
        </section>
    );
};

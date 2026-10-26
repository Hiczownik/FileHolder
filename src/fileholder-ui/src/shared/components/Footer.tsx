import { abuseReportHref } from "../utils/abuseReport";

export const Footer: React.FC = () => {
    const reportHref = abuseReportHref();

    return (
        <footer className="border-t border-line">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 text-sm text-muted flex flex-col sm:flex-row sm:justify-between gap-2">
                <p>Files are deleted when a bundle expires or runs out of downloads.</p>
                {reportHref && (
                    <a href={reportHref} className="underline underline-offset-2 hover:text-fg rounded outline-none focus-visible:ring-2 focus-visible:ring-accent">
                        Report abuse
                    </a>
                )}
            </div>
        </footer>
    );
};

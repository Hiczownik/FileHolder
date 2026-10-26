import { abuseReportHref } from "../utils/abuseReport";
import { UI_BUILD, describeBuild } from "../utils/buildInfo";

const LINK = "underline underline-offset-2 hover:text-fg rounded outline-none focus-visible:ring-2 focus-visible:ring-accent";

export const Footer: React.FC = () => {
    const reportHref = abuseReportHref();

    return (
        <footer className="border-t border-line">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 text-sm text-muted flex flex-col sm:flex-row sm:justify-between gap-2">
                <p>Files are deleted when a bundle expires or runs out of downloads.</p>
                <p className="flex flex-wrap gap-x-4 gap-y-1">
                    <a href="/terms" className={LINK}>Terms</a>
                    <a href="/privacy" className={LINK}>Privacy</a>
                    {reportHref && <a href={reportHref} className={LINK}>Report abuse</a>}
                    {/* Which build this page is, so a report or a screenshot says it. */}
                    <span data-testid="ui-build" className="tabular-nums">{describeBuild(UI_BUILD)}</span>
                </p>
            </div>
        </footer>
    );
};

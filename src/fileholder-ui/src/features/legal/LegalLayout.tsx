import { useEffect } from 'react';
import { Mail } from 'lucide-react';
import { CONTACT_EMAIL, LEGAL_PAGES_UPDATED, OPERATOR_NAME } from '../../shared/utils/operator';

const LINK = 'underline underline-offset-2 text-fg hover:text-accent rounded outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** A plain reading page: the terms and the privacy page. */
export const LegalPage: React.FC<{ title: string; intro: React.ReactNode; children: React.ReactNode }> = ({ title, intro, children }) => {
    useEffect(() => {
        document.title = `${title} · FileHolder`;
        return () => {
            document.title = 'FileHolder';
        };
    }, [title]);

    return (
        <article className="max-w-[720px] mx-auto px-4 sm:px-6 py-10 sm:py-14 space-y-8">
            <header className="space-y-3">
                <h1 className="text-[28px] sm:text-[34px] leading-tight font-semibold tracking-tight">{title}</h1>
                <p className="text-sm text-muted">Last updated {LEGAL_PAGES_UPDATED}</p>
                <div className="text-fg-soft sm:text-[17px] space-y-3">{intro}</div>
            </header>
            <ContactBox />
            {children}
        </article>
    );
};

/** Who runs the site and how to reach them, at the top of both pages, where it's easy to find. */
export const ContactBox: React.FC = () => (
    <aside aria-label="Contact" className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
        <Mail aria-hidden="true" className="w-5 h-5 shrink-0 mt-0.5 text-accent" />
        <p className="text-fg-soft">
            FileHolder is run by <strong className="text-fg">{OPERATOR_NAME}</strong>, a private individual, as a
            portfolio project.{' '}
            {CONTACT_EMAIL ? (
                <>For anything about these terms or your data, write to <a href={`mailto:${CONTACT_EMAIL}`} className={LINK}>{CONTACT_EMAIL}</a>.</>
            ) : (
                <>Contact details are available from the operator of this site.</>
            )}
        </p>
    </aside>
);

export const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <section className="space-y-3">
        <h2 className="text-[19px] font-semibold tracking-tight">{title}</h2>
        <div className="space-y-3 text-fg-soft leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1.5 [&_strong]:text-fg">
            {children}
        </div>
    </section>
);

export const MailLink: React.FC<{ address: string }> = ({ address }) => (
    <a href={`mailto:${address}`} className={LINK}>{address}</a>
);

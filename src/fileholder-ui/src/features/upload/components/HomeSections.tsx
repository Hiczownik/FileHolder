import { Link2, Lock } from "lucide-react";

const STEPS = [
    {
        title: 'Pick files and rules',
        text: 'Add up to 50 files. Choose when the bundle expires and how many times it can be downloaded.',
    },
    {
        title: 'Upload straight to storage',
        text: "Your browser sends the files directly to storage over short-lived links. With encryption on, they're encrypted before they leave your device.",
    },
    {
        title: 'Share the link',
        text: 'Send the link or show its QR code. When the time or the downloads run out, the files are deleted.',
    },
] as const;

export const HowItWorks: React.FC = () => (
    <section id="how" aria-labelledby="how-title" className="border-t border-line bg-surface scroll-mt-4">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-16 space-y-8">
            <h2 id="how-title" className="text-2xl sm:text-[28px] font-semibold tracking-tight">How it works</h2>
            <ol className="grid gap-8 sm:grid-cols-3">
                {STEPS.map((step, index) => (
                    <li key={step.title} className="space-y-2.5">
                        <span aria-hidden="true" className="w-8 h-8 rounded-full bg-accent-tint text-accent text-sm font-semibold flex items-center justify-center">
                            {index + 1}
                        </span>
                        <h3 className="text-[17px] font-semibold">{step.title}</h3>
                        <p className="text-fg-soft">{step.text}</p>
                    </li>
                ))}
            </ol>
        </div>
    </section>
);

interface ModeProps {
    readonly icon: React.ReactNode;
    readonly title: string;
    readonly needs: string;
    readonly whoCanOpen: string;
    readonly badge?: string;
}

const ModeCard: React.FC<ModeProps> = ({ icon, title, needs, whoCanOpen, badge }) => (
    <article className={`rounded-2xl border bg-surface p-6 space-y-4 ${badge ? 'border-accent' : 'border-line'}`}>
        <div className="flex items-center gap-2.5 flex-wrap">
            {icon}
            <h3 className="text-[17px] font-semibold">{title}</h3>
            {badge && (
                <span className="ml-auto text-xs font-semibold text-accent bg-accent-tint px-2.5 py-0.5 rounded-full">{badge}</span>
            )}
        </div>
        <dl className="space-y-3">
            <div>
                <dt className="text-sm text-muted">The recipient needs</dt>
                <dd className="mt-0.5">{needs}</dd>
            </div>
            <div>
                <dt className="text-sm text-muted">Who can open the files</dt>
                <dd className="mt-0.5">{whoCanOpen}</dd>
            </div>
        </dl>
    </article>
);

export const EncryptionModes: React.FC = () => (
    <section id="modes" aria-labelledby="modes-title" className="border-t border-line scroll-mt-4">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-16 space-y-7">
            <div className="space-y-2 max-w-2xl">
                <h2 id="modes-title" className="text-2xl sm:text-[28px] font-semibold tracking-tight">Two ways to encrypt</h2>
                <p className="text-fg-soft">
                    Either way, the key never reaches the server. Pick the mode when you upload; it can&apos;t be changed later.
                </p>
            </div>
            <div className="grid gap-5 md:grid-cols-2">
                <ModeCard
                    icon={<Link2 aria-hidden="true" className="w-5 h-5 text-accent" />}
                    title="Link only"
                    needs="The link, or its QR code"
                    whoCanOpen="Anyone who has the link: chat history, synced browser history, a photo of the QR code"
                />
                <ModeCard
                    icon={<Lock aria-hidden="true" className="w-5 h-5 text-accent" />}
                    title="Link and passkey"
                    needs="The link and a passkey, sent separately"
                    whoCanOpen="Only someone with both. A leaked link alone is useless, and so is a leaked passkey."
                    badge="For sensitive files"
                />
            </div>
            <p className="text-sm text-muted max-w-3xl">
                What the server can still see: the number of files, roughly how big they are, the expiry, the download
                limit and whether a passkey is needed. File names and the title stay encrypted.
            </p>
        </div>
    </section>
);

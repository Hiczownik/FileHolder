import { Link } from 'react-router-dom';
import { LegalPage, MailLink, Section } from './LegalLayout';
import { useUploadLimits } from '../upload/hooks/useUploadLimits';
import { describeHours, longestExpiry } from '../upload/services/uploadLimits';
import { ABUSE_EMAIL } from '../../shared/utils/abuseReport';
import { CONTACT_EMAIL } from '../../shared/utils/operator';

const LINK = 'underline underline-offset-2 text-fg hover:text-accent rounded outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** What FileHolder does with personal data (GDPR art. 13), kept true to the code: see README, Production. */
export const PrivacyPage: React.FC = () => {
    const limits = useUploadLimits();
    const longest = describeHours(longestExpiry(limits));

    return (
        <LegalPage
            title="Privacy"
            intro={<p>FileHolder is built to keep as little as possible, for as short a time as possible. This page says exactly what that is.</p>}
        >
            <Section title="In short">
                <ul>
                    <li><strong>No accounts, no cookies, no analytics, no tracking.</strong></li>
                    <li><strong>Files delete themselves</strong> when a bundle expires (after {longest} at most) or runs out of downloads.</li>
                    <li><strong>FileHolder doesn&apos;t store IP addresses.</strong></li>
                    <li><strong>Encrypted bundles can&apos;t be read by anyone without the link</strong>, including FileHolder.</li>
                </ul>
            </Section>

            <Section title="What is processed, and for how long">
                <p>
                    <strong>Files you upload</strong> are stored so the people you send the link to can download them.
                    They are deleted within about an hour after the bundle expires, or after its last allowed download
                    has finished (a download may take up to 6 hours). A safety net in the storage deletes anything left
                    over within a few days.
                </p>
                <p>
                    <strong>Bundle details:</strong> for an ordinary bundle, its title, the files&apos; names, sizes and types,
                    and a hash of its password if it has one. For an encrypted bundle, only encrypted data and sizes: its
                    title and file names are encrypted in your browser. These are deleted together with the files. After
                    that, a minimal record (the link&apos;s code and a few dates) is kept for 7 days, so the link can say
                    it has expired.
                </p>
                <p>
                    <strong>Your IP address</strong> is used for a moment in memory, to limit how many requests one
                    address can make, and is then discarded; it isn&apos;t written to any log or database. Only while
                    investigating abuse may the server log a shortened address (the network, never the full address),
                    for as short a time as the investigation needs.
                </p>
                <p>
                    <strong>Reports you send</strong> to {ABUSE_EMAIL ? <MailLink address={ABUSE_EMAIL} /> : 'the abuse address'}
                    {CONTACT_EMAIL ? <> or <MailLink address={CONTACT_EMAIL} /></> : null} are kept in the operator&apos;s
                    mailbox as long as needed to deal with them. When a bundle is removed after a report, a record of the
                    removal (the link&apos;s code, the date and the reason) is kept; it holds none of the bundle&apos;s
                    contents.
                </p>
                <p>
                    <strong>In your browser</strong>, FileHolder keeps your light or dark theme choice. While a tab is
                    open, it also keeps what that tab needs to reopen a bundle after a reload (an encrypted bundle&apos;s
                    keys, the current download), which the browser forgets when the tab closes. Some browsers (Safari)
                    save a large download through the site&apos;s private storage first; that copy is deleted about an
                    hour later, and anything left behind within a day. No cookies are set.
                </p>
                {limits.accessCodesEnabled && (
                    <p>
                        <strong>Access codes</strong> allow larger bundles. For each code, FileHolder counts how many
                        bundles were uploaded with it, how many bytes, and when it was first and last used; it never
                        records which bundle came with which code. A code from a personal link is kept in that tab
                        until it closes, and removed from the address bar.
                    </p>
                )}
            </Section>

            <Section title="Who else handles data">
                <ul>
                    <li>
                        <strong>OVHcloud</strong> hosts the server in Poland. Its network carries all traffic to the site.
                        It keeps automatic backups of the server for 7 days, which can hold bundle details (not files) for
                        up to 7 days after FileHolder has deleted them.
                    </li>
                    <li>
                        <strong>Cloudflare</strong> stores the files, in its European Union storage, and runs the
                        site&apos;s DNS and the forwarding of email to the addresses above. Your browser uploads and
                        downloads files directly from Cloudflare, so Cloudflare sees your IP address under its own policy.
                    </li>
                    <li><strong>Let&apos;s Encrypt</strong> issues the site&apos;s HTTPS certificate and never sees visitors.</li>
                </ul>
            </Section>

            <Section title="Why">
                <p>
                    Processing is based on legitimate interest (GDPR article 6(1)(f)): providing the file sharing you ask
                    for, and keeping the service secure and free of abuse. Uploading a bundle is asking for that service.
                </p>
            </Section>

            <Section title="Your rights">
                <p>
                    You can ask for access to your data, its correction or deletion, a restriction of its use, or object
                    to it, by writing to {CONTACT_EMAIL ? <MailLink address={CONTACT_EMAIL} /> : 'the operator'}. FileHolder has
                    no accounts and stores no IP addresses, so include the bundle&apos;s link to say which data is yours;
                    most of it deletes itself within a day anyway.
                </p>
                <p>
                    You can also complain to the Polish data protection authority, the President of the Personal Data
                    Protection Office (UODO,{' '}
                    <a href="https://uodo.gov.pl/en" className={LINK} rel="noreferrer">uodo.gov.pl</a>).
                </p>
            </Section>

            <Section title="Changes">
                <p>
                    If this page changes, the date at the top changes with it. See also the{' '}
                    <Link to="/terms" className={LINK}>terms of use</Link>.
                </p>
            </Section>
        </LegalPage>
    );
};

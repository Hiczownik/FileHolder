import { Link } from 'react-router-dom';
import { LegalPage, MailLink, Section } from './LegalLayout';
import { useUploadLimits } from '../upload/hooks/useUploadLimits';
import { describeHours } from '../upload/services/uploadLimits';
import { formatSize } from '../../shared/utils/formatSize';
import { ABUSE_EMAIL } from '../../shared/utils/abuseReport';
import { CONTACT_EMAIL } from '../../shared/utils/operator';

const LINK = 'underline underline-offset-2 text-fg hover:text-accent rounded outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** The rules for using FileHolder: what it is, what's not allowed, removals, no guarantees. */
export const TermsPage: React.FC = () => {
    const limits = useUploadLimits();

    return (
        <LegalPage
            title="Terms of use"
            intro={<p>By uploading files to FileHolder, you agree to these terms. They are short; please read them.</p>}
        >
            <Section title="What FileHolder is">
                <p>
                    FileHolder is a free demonstration of a file-sharing service, built as a portfolio project. You can share
                    up to {limits.maxFilesPerBundle} files ({formatSize(limits.maxBundleSizeBytes)} in total) as one link that
                    stops working after the time you choose, {describeHours(limits.maxExpiryHours)} at most, or after a
                    number of downloads. Its features and limits may change, and it may be paused, emptied or shut down at
                    any time, without notice.
                </p>
            </Section>

            <Section title="What you may not do">
                <p>Only upload files you have the right to share. Don&apos;t use FileHolder to upload or share:</p>
                <ul>
                    <li>anything illegal, including content that sexually exploits children;</li>
                    <li>malware, or links and files meant to trick people (phishing);</li>
                    <li>material that infringes someone else&apos;s rights, such as copyright or privacy;</li>
                    <li>other people&apos;s personal data, unless you&apos;re allowed to share it.</li>
                </ul>
                <p>
                    Don&apos;t try to get around the limits, overload the service, or break into it. If you find a
                    security problem, please report it
                    {CONTACT_EMAIL ? <> to <MailLink address={CONTACT_EMAIL} /></> : ' to the operator'} instead.
                </p>
            </Section>

            <Section title="Reports and removal">
                <p>
                    Anyone can report a bundle with the <em>Report it</em> link on its page, or by writing to{' '}
                    {ABUSE_EMAIL ? <MailLink address={ABUSE_EMAIL} /> : 'the operator'}; include the link (without the part
                    after <code>#</code>, which is the key of an encrypted bundle).
                </p>
                <p>
                    Any bundle may be removed at any time, in particular after a report. Encrypted bundles can be removed too:
                    FileHolder can&apos;t see inside them, so it acts on the report. A removed link says so. Each removal is
                    recorded with the link&apos;s code, the date and the reason. Because FileHolder has no accounts and keeps
                    no contact details, it can&apos;t tell uploaders that their bundle was removed.
                </p>
            </Section>

            <Section title="No guarantees">
                <p>
                    FileHolder is provided as it is, without any guarantee that it works, is available, or keeps your files:
                    they are deleted automatically, so never use it as the only copy of anything. As far as the law allows,
                    the operator isn&apos;t liable for any loss from using it. Nothing in these terms limits rights you have
                    as a consumer that can&apos;t be limited.
                </p>
            </Section>

            <Section title="Privacy, law and changes">
                <p>
                    How data is handled is explained on the <Link to="/privacy" className={LINK}>privacy page</Link>. These
                    terms are governed by Polish law. If they change, the date at the top changes with them; the terms in
                    force when you upload apply to that upload.
                </p>
            </Section>
        </LegalPage>
    );
};

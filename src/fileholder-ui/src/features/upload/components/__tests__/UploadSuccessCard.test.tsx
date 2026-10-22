import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UploadSuccessCard } from '../UploadSuccessCard';
import type { UploadResult } from '../../types';

describe('UploadSuccessCard Component', () => {
    const shareLink = 'https://fileholder.test/f/share_abc';
    const linkKey = 'q3-_ZZ0x9Lm2Wk7Qp4Rt8Vy1Hd6Jb3Nc5Fg0Ks2Ue7Xa';
    const encryptedLink = `${shareLink}#k=${linkKey}`;
    const passkey = 'K7QM-2HXP-9RTA';
    const linkKeyNote = 'Anyone with this link or QR code can open the files.';
    const passkeyNote = "Send the passkey in a different message or app. The link alone won't open the files.";
    const BYTES_PER_KB = 1024;
    const TOTAL_KB = 3;
    const FILE_COUNT = 2;
    const THREE_DAYS_IN_HOURS = 72;
    const MAX_DOWNLOADS = 10;

    const standard: UploadResult = {
        shareLink,
        bundle: {
            title: 'Q3 review',
            fileCount: FILE_COUNT,
            totalBytes: TOTAL_KB * BYTES_PER_KB,
            expireInHours: THREE_DAYS_IN_HOURS,
            maxDownloads: MAX_DOWNLOADS,
        },
    };

    const renderCard = (overrides: Partial<UploadResult> = {}) =>
        render(<UploadSuccessCard result={{ ...standard, ...overrides }} onReset={vi.fn()} />);

    it('shows the link with a copy button, and a QR code for it', () => {
        renderCard();

        expect(screen.getByLabelText('Share link')).toHaveValue(shareLink);
        expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
        expect(screen.getByTitle('QR code for the share link')).toBeInTheDocument();
        expect(screen.getByText('Show QR code')).toBeInTheDocument();
    });

    it('sums up the bundle and its rules', () => {
        renderCard();

        expect(screen.getByText('Q3 review · 2 files · 3 KB')).toBeInTheDocument();
        expect(screen.getByText('in 3 days')).toBeInTheDocument();
        expect(screen.getByText('10 allowed')).toBeInTheDocument();
        expect(screen.getByText('Standard')).toBeInTheDocument();
    });

    it('leaves the title out of the summary when there is none, and counts hours below a day', () => {
        renderCard({ bundle: { ...standard.bundle, title: '', fileCount: 1, expireInHours: 1 } });

        expect(screen.getByText('1 file · 3 KB')).toBeInTheDocument();
        expect(screen.getByText('in 1 hour')).toBeInTheDocument();
    });

    it('takes focus, so the result is announced and in view', () => {
        renderCard();

        expect(screen.getByRole('heading', { name: 'Your link is ready' })).toHaveFocus();
    });

    it('shows no key note and no passkey for a standard bundle', () => {
        renderCard();

        expect(screen.queryByText(linkKeyNote)).not.toBeInTheDocument();
        expect(screen.queryByText(passkeyNote)).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Passkey')).not.toBeInTheDocument();
    });

    it('warns that the link alone opens a link-key bundle, and shows the full link with its key', () => {
        renderCard({ shareLink: encryptedLink, keyMode: 'LinkKey' });

        expect(screen.getByText(linkKeyNote)).toBeInTheDocument();
        expect(screen.queryByText(passkeyNote)).not.toBeInTheDocument();
        expect(screen.getByLabelText('Share link')).toHaveValue(encryptedLink);
        expect(screen.getByText('Encrypted, link only')).toBeInTheDocument();
    });

    it('shows the passkey to copy, and says to send it separately', () => {
        renderCard({ shareLink: encryptedLink, keyMode: 'LinkKeyAndPasskey', passkey });

        expect(screen.getByLabelText('Passkey')).toHaveValue(passkey);
        expect(screen.getByRole('button', { name: 'Copy passkey' })).toBeInTheDocument();
        expect(screen.getByText(passkeyNote)).toBeInTheDocument();
        expect(screen.queryByText(linkKeyNote)).not.toBeInTheDocument();
    });

    it('says what removing photo metadata did', () => {
        renderCard({ metadataSummary: { cleaned: 1, notCleaned: ['IMG_0002.HEIC'], motionPhotos: 0 } });

        expect(screen.getByText('Removed metadata from 1 photo. 1 file couldn\'t be cleaned and keeps its metadata: IMG_0002.HEIC.')).toBeInTheDocument();
    });

    it('says nothing about metadata when removal was off or touched nothing', () => {
        renderCard({ metadataSummary: { cleaned: 0, notCleaned: [], motionPhotos: 0 } });

        expect(screen.queryByText('Removed metadata', { exact: false })).not.toBeInTheDocument();
    });
});

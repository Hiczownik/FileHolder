import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UploadSuccessCard } from '../UploadSuccessCard';

describe('UploadSuccessCard Component', () => {
    const shareLink = 'https://fileholder.test/f/share_abc';
    const linkKey = 'q3-_ZZ0x9Lm2Wk7Qp4Rt8Vy1Hd6Jb3Nc5Fg0Ks2Ue7Xa';
    const encryptedLink = `${shareLink}#k=${linkKey}`;
    const linkKeyNote = 'Anyone with this link or QR code can open the files.';
    const passkeyNote = "The link alone won't open the files. Share the passkey separately (not in the same message).";

    it('renders a QR code for the share link', () => {
        render(<UploadSuccessCard shareLink={shareLink} onReset={vi.fn()} />);

        expect(screen.getByDisplayValue(shareLink)).toBeInTheDocument();
        expect(screen.getByTitle('QR code for the share link')).toBeInTheDocument();
        expect(screen.getByText('Scan to open the link on another device.')).toBeInTheDocument();
    });

    it('shows no key note for a standard bundle', () => {
        render(<UploadSuccessCard shareLink={shareLink} onReset={vi.fn()} />);

        expect(screen.queryByText(linkKeyNote)).not.toBeInTheDocument();
        expect(screen.queryByText(passkeyNote)).not.toBeInTheDocument();
    });

    it('warns that the link alone opens a link-key bundle, and shows the full link with its key', () => {
        render(<UploadSuccessCard shareLink={encryptedLink} keyMode="LinkKey" onReset={vi.fn()} />);

        expect(screen.getByText(linkKeyNote)).toBeInTheDocument();
        expect(screen.queryByText(passkeyNote)).not.toBeInTheDocument();
        expect(screen.getByDisplayValue(encryptedLink)).toBeInTheDocument();
    });

    it('says what removing photo metadata did', () => {
        render(<UploadSuccessCard shareLink={shareLink} metadataSummary={{ cleaned: 1, notCleaned: ['IMG_0002.HEIC'], motionPhotos: 0 }} onReset={vi.fn()} />);

        expect(screen.getByText('Removed metadata from 1 photo. 1 file couldn\'t be cleaned and keeps its metadata: IMG_0002.HEIC.')).toBeInTheDocument();
    });

    it('says nothing about metadata when removal was off or touched nothing', () => {
        render(<UploadSuccessCard shareLink={shareLink} metadataSummary={{ cleaned: 0, notCleaned: [], motionPhotos: 0 }} onReset={vi.fn()} />);

        expect(screen.queryByText('Removed metadata', { exact: false })).not.toBeInTheDocument();
    });

    it('reminds the uploader to send the passkey separately when the bundle needs one', () => {
        render(<UploadSuccessCard shareLink={encryptedLink} keyMode="LinkKeyAndPasskey" onReset={vi.fn()} />);

        expect(screen.getByText(passkeyNote)).toBeInTheDocument();
        expect(screen.queryByText(linkKeyNote)).not.toBeInTheDocument();
    });
});

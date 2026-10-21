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

    it('reminds the uploader to send the passkey separately when the bundle needs one', () => {
        render(<UploadSuccessCard shareLink={encryptedLink} keyMode="LinkKeyAndPasskey" onReset={vi.fn()} />);

        expect(screen.getByText(passkeyNote)).toBeInTheDocument();
        expect(screen.queryByText(linkKeyNote)).not.toBeInTheDocument();
    });
});

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UploadSuccessCard } from '../UploadSuccessCard';

describe('UploadSuccessCard Component', () => {
    const shareLink = 'https://fileholder.test/f/share_abc';
    const passkeyNote = 'The QR code holds only the link. Share the passkey separately.';

    it('renders a QR code for the share link', () => {
        render(<UploadSuccessCard shareLink={shareLink} isEncrypted={false} onReset={vi.fn()} />);

        expect(screen.getByDisplayValue(shareLink)).toBeInTheDocument();
        expect(screen.getByTitle('QR code for the share link')).toBeInTheDocument();
        expect(screen.getByText('Scan to open the link on another device.')).toBeInTheDocument();
    });

    it('does not mention the passkey for a standard bundle', () => {
        render(<UploadSuccessCard shareLink={shareLink} isEncrypted={false} onReset={vi.fn()} />);

        expect(screen.queryByText(passkeyNote)).not.toBeInTheDocument();
    });

    it('reminds the uploader that the QR code does not hold the passkey for an encrypted bundle', () => {
        render(<UploadSuccessCard shareLink={shareLink} isEncrypted={true} onReset={vi.fn()} />);

        expect(screen.getByText(passkeyNote)).toBeInTheDocument();
    });
});

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UploadForm } from '../UploadForm';
import type { UploadState } from '../../types';

const idleUploadState: UploadState = { status: 'idle' };

const renderWithAFile = (uploadsPaused: boolean): void => {
    render(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} uploadsPaused={uploadsPaused} />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'report.pdf', { type: 'application/pdf' })] } });
};

describe('UploadForm while uploads are paused', () => {
    it("stays to look at, but can't be sent", () => {
        renderWithAFile(true);

        expect(screen.getByRole('button', { name: 'Uploads are paused' })).toBeDisabled();
        expect(screen.getByText('New uploads are paused for now', { exact: false })).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: 'End-to-end encryption' })).toBeEnabled();
    });

    it('can be sent again once uploads are back', () => {
        renderWithAFile(false);

        expect(screen.getByRole('button', { name: 'Create share link' })).toBeEnabled();
    });
});

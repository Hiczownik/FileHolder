import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { UploadForm } from '../UploadForm';
import type { UploadState } from '../../types';

describe('UploadForm Component - E2EE Memory Boundary Guardrail', () => {
    const createMockFile = (name: string, size: number): File => {
        const file = new File(['dummy_content'], name, { type: 'application/octet-stream' });
        Object.defineProperty(file, 'size', { value: size, configurable: true });
        return file;
    };

    const idleUploadState: UploadState = { status: 'idle' };

    it('displays warning banner and disables submit button when multi-file E2EE exceeds 200 MB', async () => {
        const user = userEvent.setup();
        render(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} />);

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        const file1 = createMockFile('file1.pdf', 110 * 1024 * 1024);
        const file2 = createMockFile('file2.pdf', 110 * 1024 * 1024);

        fireEvent.change(fileInput, { target: { files: [file1, file2] } });

        const checkbox = screen.getByRole('checkbox');
        await user.click(checkbox);

        expect(
            screen.getByText(/limits client-side bundling to 200 MB/i)
        ).toBeInTheDocument();

        const submitButton = screen.getByRole('button', { name: /Generate Shareable Link/i });
        expect(submitButton).toBeDisabled();
    });

    it('clears warning banner and enables submit button when unencrypted even with 220 MB payload', async () => {
        const user = userEvent.setup();
        render(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} />);

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        const file1 = createMockFile('file1.pdf', 110 * 1024 * 1024);
        const file2 = createMockFile('file2.pdf', 110 * 1024 * 1024);

        fireEvent.change(fileInput, { target: { files: [file1, file2] } });

        const checkbox = screen.getByRole('checkbox');
        await user.click(checkbox);

        expect(screen.getByText(/limits client-side bundling to 200 MB/i)).toBeInTheDocument();
        const submitButton = screen.getByRole('button', { name: /Generate Shareable Link/i });
        expect(submitButton).toBeDisabled();

        // Uncheck E2EE
        await user.click(checkbox);

        expect(screen.queryByText(/limits client-side bundling to 200 MB/i)).not.toBeInTheDocument();
        expect(submitButton).toBeEnabled();
    });

    it('allows single file up to 1 GB when E2EE is enabled without warning', async () => {
        const user = userEvent.setup();
        render(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} />);

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        const file = createMockFile('archive.zip', 500 * 1024 * 1024); // 500 MB

        fireEvent.change(fileInput, { target: { files: [file] } });

        const checkbox = screen.getByRole('checkbox');
        await user.click(checkbox);

        expect(screen.queryByText(/limits client-side bundling to 200 MB/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Single-file End-to-End Encryption is limited to 1 GB/i)).not.toBeInTheDocument();

        const submitButton = screen.getByRole('button', { name: /Generate Shareable Link/i });
        expect(submitButton).toBeEnabled();
    });
});
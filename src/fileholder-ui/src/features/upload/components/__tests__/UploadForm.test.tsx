import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { UploadForm } from '../UploadForm';
import type { UploadState } from '../../types';

describe('UploadForm Component - Zero-Knowledge E2EE Form Guardrails', () => {
    const createMockFile = (name: string, size: number): File => {
        const file = new File(['dummy_content'], name, { type: 'application/octet-stream' });
        Object.defineProperty(file, 'size', { value: size, configurable: true });
        return file;
    };

    const idleUploadState: UploadState = { status: 'idle' };

    it('requires password and disables submit when E2EE is enabled without a passkey', async () => {
        const user = userEvent.setup();
        render(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} />);

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        const file = createMockFile('document.pdf', 1024);
        fireEvent.change(fileInput, { target: { files: [file] } });

        const submitButton = screen.getByRole('button', { name: /Generate Shareable Link/i });
        expect(submitButton).toBeEnabled();

        // Enable E2EE
        const checkbox = screen.getByRole('checkbox');
        await user.click(checkbox);

        // Password is now required for E2EE; submit button must be disabled
        expect(submitButton).toBeDisabled();
        expect(screen.getByText(/Vault Passkey \(Required for E2EE\)/i)).toBeInTheDocument();
    });

    it('enables submit button when passkey is entered for E2EE', async () => {
        const user = userEvent.setup();
        render(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} />);

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        const file = createMockFile('document.pdf', 1024);
        fireEvent.change(fileInput, { target: { files: [file] } });

        const checkbox = screen.getByRole('checkbox');
        await user.click(checkbox);

        const passwordInput = screen.getByPlaceholderText(/Enter or generate a secure passkey/i);
        await user.type(passwordInput, 'MySecurePass123!');

        const submitButton = screen.getByRole('button', { name: /Generate Shareable Link/i });
        expect(submitButton).toBeEnabled();
    });

    it('generates and populates a secure passkey when clicking Generate Secure Passkey', async () => {
        const user = userEvent.setup();
        render(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} />);

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        const file = createMockFile('document.pdf', 1024);
        fireEvent.change(fileInput, { target: { files: [file] } });

        const checkbox = screen.getByRole('checkbox');
        await user.click(checkbox);

        const generateBtn = screen.getByRole('button', { name: /Generate Secure Passkey/i });
        await user.click(generateBtn);

        const passwordInput = screen.getByPlaceholderText(/Enter or generate a secure passkey/i) as HTMLInputElement;
        expect(passwordInput.value).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

        const submitButton = screen.getByRole('button', { name: /Generate Shareable Link/i });
        expect(submitButton).toBeEnabled();
    });

    it('allows multi-file payloads exceeding 200 MB without warnings under streaming E2EE', async () => {
        const user = userEvent.setup();
        render(<UploadForm uploadState={idleUploadState} onUpload={vi.fn()} />);

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        const file1 = createMockFile('file1.pdf', 110 * 1024 * 1024);
        const file2 = createMockFile('file2.pdf', 110 * 1024 * 1024);
        fireEvent.change(fileInput, { target: { files: [file1, file2] } });

        const checkbox = screen.getByRole('checkbox');
        await user.click(checkbox);

        // No 200 MB warning banner rendered
        expect(screen.queryByText(/limits client-side bundling to 200 MB/i)).not.toBeInTheDocument();

        // Provide password
        const passwordInput = screen.getByPlaceholderText(/Enter or generate a secure passkey/i);
        await user.type(passwordInput, 'Passkey123!');

        const submitButton = screen.getByRole('button', { name: /Generate Shareable Link/i });
        expect(submitButton).toBeEnabled();
    });
});
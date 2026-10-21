import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { UploadForm } from '../UploadForm';
import type { UploadState } from '../../types';

describe('UploadForm Component - Zero-Knowledge E2EE Form Guardrails', () => {
    const BYTES_PER_KB = 1024;
    const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
    const LARGE_FILE_MB = 110;
    const SMALL_FILE_BYTES = BYTES_PER_KB;
    const LARGE_FILE_BYTES = LARGE_FILE_MB * BYTES_PER_MB;
    const PASSKEY_PLACEHOLDER = 'Enter or generate a secure passkey';

    const createMockFile = (name: string, size: number): File => {
        const file = new File(['dummy_content'], name, { type: 'application/octet-stream' });
        Object.defineProperty(file, 'size', { value: size, configurable: true });
        return file;
    };

    const idleUploadState: UploadState = { status: 'idle' };

    const renderWithFiles = (files: readonly File[] = [createMockFile('document.pdf', SMALL_FILE_BYTES)]) => {
        const onUpload = vi.fn();
        render(<UploadForm uploadState={idleUploadState} onUpload={onUpload} />);
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        fireEvent.change(fileInput, { target: { files } });
        return { onUpload, submitButton: screen.getByRole('button', { name: 'Generate Shareable Link' }) };
    };

    const e2eeCheckbox = (): HTMLElement => screen.getByRole('checkbox', { name: 'End-to-end encryption' });
    const passkeyCheckbox = (): HTMLElement => screen.getByRole('checkbox', { name: 'Also require a passkey' });

    it('needs no passkey for an encrypted bundle by default: the link carries the key', async () => {
        const user = userEvent.setup();
        const { onUpload, submitButton } = renderWithFiles();

        await user.click(e2eeCheckbox());

        expect(passkeyCheckbox()).not.toBeChecked();
        expect(screen.queryByPlaceholderText(PASSKEY_PLACEHOLDER)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Generate Secure Passkey' })).not.toBeInTheDocument();
        expect(screen.getByText('The link is the secret', { exact: false })).toBeInTheDocument();
        expect(submitButton).toBeEnabled();

        await user.click(submitButton);
        expect(onUpload).toHaveBeenCalledWith(expect.objectContaining({ isEncrypted: true, requirePasskey: false }), expect.any(Array));
    });

    it('offers the passkey option only for encrypted bundles', async () => {
        const user = userEvent.setup();
        renderWithFiles();

        expect(screen.queryByRole('checkbox', { name: 'Also require a passkey' })).not.toBeInTheDocument();
        expect(screen.getByPlaceholderText('Leave empty for public link')).toBeInTheDocument();

        await user.click(e2eeCheckbox());
        expect(passkeyCheckbox()).toBeInTheDocument();
    });

    it('requires a passkey and disables submit when "Also require a passkey" is on without one', async () => {
        const user = userEvent.setup();
        const { submitButton } = renderWithFiles();
        expect(submitButton).toBeEnabled();

        await user.click(e2eeCheckbox());
        await user.click(passkeyCheckbox());

        expect(submitButton).toBeDisabled();
        expect(screen.getByText('Passkey (Required)')).toBeInTheDocument();
        expect(screen.getByText("The link alone won't open the files", { exact: false })).toBeInTheDocument();
    });

    it('enables submit once the required passkey is entered', async () => {
        const user = userEvent.setup();
        const { onUpload, submitButton } = renderWithFiles();

        await user.click(e2eeCheckbox());
        await user.click(passkeyCheckbox());
        await user.type(screen.getByPlaceholderText(PASSKEY_PLACEHOLDER), 'MySecurePass123!');

        expect(submitButton).toBeEnabled();
        await user.click(submitButton);
        expect(onUpload).toHaveBeenCalledWith(
            expect.objectContaining({ isEncrypted: true, requirePasskey: true, password: 'MySecurePass123!' }),
            expect.any(Array));
    });

    it('generates and populates a secure passkey when clicking Generate Secure Passkey', async () => {
        const user = userEvent.setup();
        const { submitButton } = renderWithFiles();

        await user.click(e2eeCheckbox());
        await user.click(passkeyCheckbox());
        await user.click(screen.getByRole('button', { name: 'Generate Secure Passkey' }));

        const passwordInput = screen.getByPlaceholderText(PASSKEY_PLACEHOLDER) as HTMLInputElement;
        // Three dash-separated groups of four: matches "AB12-CD34-EF56"; rejects "ab12-cd34".
        // https://regex101.com/?regex=%5E%5BA-Z0-9%5D%7B4%7D-%5BA-Z0-9%5D%7B4%7D-%5BA-Z0-9%5D%7B4%7D%24&testString=AB12-CD34-EF56%0Aab12-cd34
        expect(passwordInput.value).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
        expect(submitButton).toBeEnabled();
    });

    it('allows multi-file payloads exceeding 200 MB without warnings under streaming E2EE', async () => {
        const user = userEvent.setup();
        const { submitButton } = renderWithFiles([createMockFile('file1.pdf', LARGE_FILE_BYTES), createMockFile('file2.pdf', LARGE_FILE_BYTES)]);

        await user.click(e2eeCheckbox());

        expect(screen.queryByText('limits client-side bundling to 200 MB', { exact: false })).not.toBeInTheDocument();
        expect(submitButton).toBeEnabled();
    });
});

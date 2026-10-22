import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { UploadForm } from '../UploadForm';
import type { UploadState } from '../../types';

const TAKEN_2023 = Date.parse('2023-06-01T10:00:00Z');
const TAKEN_2024 = Date.parse('2024-06-01T10:00:00Z');
const BOTH_FILES = 2;
const idleUploadState: UploadState = { status: 'idle' };

// Same name and same size (5 bytes); only the modification time differs.
const photo = (lastModified: number): File => new File(['12345'], 'img.jpg', { lastModified });

const pick = (files: File[]): void => {
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files } });
};

const submittedFiles = async (onUpload: ReturnType<typeof vi.fn>): Promise<File[]> => {
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create share link' }));
    await waitFor(() => expect(onUpload).toHaveBeenCalled());
    return onUpload.mock.calls[0][1] as File[];
};

describe('UploadForm with files that look alike', () => {
    it('uploads both of two different files that share a name and size', async () => {
        const onUpload = vi.fn();
        render(<UploadForm uploadState={idleUploadState} onUpload={onUpload} />);

        pick([photo(TAKEN_2023)]);
        pick([photo(TAKEN_2024)]);

        expect(screen.queryByText('already in the list', { exact: false })).not.toBeInTheDocument();
        expect(await submittedFiles(onUpload)).toHaveLength(BOTH_FILES);
    });

    it('says so when it skips a file that is already in the list', async () => {
        const onUpload = vi.fn();
        render(<UploadForm uploadState={idleUploadState} onUpload={onUpload} />);

        pick([photo(TAKEN_2024)]);
        pick([photo(TAKEN_2024)]);

        expect(screen.getByText('Skipped 1 file already in the list: img.jpg.')).toBeInTheDocument();
        expect(await submittedFiles(onUpload)).toHaveLength(1);
    });
});

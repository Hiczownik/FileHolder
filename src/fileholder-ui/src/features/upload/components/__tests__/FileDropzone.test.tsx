import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import  { FileDropzone } from '../FileDropzone';
import { userEvent } from '@testing-library/user-event';

describe('FileDropzone Component', () => {
    const createFile = (name: string, size: number): File => {
        const file = new File(['x'.repeat(size)], name, { type: 'text/plain' });
        Object.defineProperty(file, 'size', { value: size });
        return file;
    };

    it('renders initial dropzone with instruction when no files are selected', () => {
        render(
            <FileDropzone
                selectedFiles={[]}
                onFilesSelect={vi.fn()}
                onRemoveFile={vi.fn()} stripMetadata
            />
        );

        expect(screen.getByText(/Drop files here/i)).toBeInTheDocument();
        expect(screen.getByText('Up to 50 files, 5 GB in total')).toBeInTheDocument();
        expect(screen.queryByRole('list', { name: 'Selected files' })).not.toBeInTheDocument();
    });

    it('renders selected files list with accurate count and formatted sizes', () => {
        const files = [
            createFile('report.pdf', 1024),
            createFile('chart.png', 2048),
        ];

        render(
            <FileDropzone
                selectedFiles={files}
                onFilesSelect={vi.fn()}
                onRemoveFile={vi.fn()} stripMetadata
            />
        );

        expect(screen.getByText('2 files')).toBeInTheDocument();
        expect(screen.getByText('report.pdf')).toBeInTheDocument();
        expect(screen.getByText('chart.png')).toBeInTheDocument();
        expect(screen.getByText('1 KB')).toBeInTheDocument();
        expect(screen.getByText('2 KB')).toBeInTheDocument();
    });

    it('calls onRemoveFile with correct index when delete icon is clicked', async () => {
        const user = userEvent.setup();
        const handleRemove = vi.fn();
        const files = [createFile('file1.txt', 500), createFile('file2.txt', 600)];

        render(
            <FileDropzone
                selectedFiles={files}
                onFilesSelect={vi.fn()}
                onRemoveFile={handleRemove} stripMetadata
            />
        )

        const removeButtons = screen.getAllByRole('button', { name: /^Remove / });
        expect(removeButtons).toHaveLength(2);

        await user.click(removeButtons[0]);
        expect(handleRemove).toHaveBeenCalledWith(0);

        await user.click(removeButtons[1]);
        expect(handleRemove).toHaveBeenCalledWith(1);
    });

    it('keeps the browser from opening a dropped file, and selects it instead', () => {
        const onFilesSelect = vi.fn();
        const dropped = new File(['%PDF'], 'contract.pdf', { type: 'application/pdf' });
        render(<FileDropzone selectedFiles={[]} onFilesSelect={onFilesSelect} onRemoveFile={vi.fn()} stripMetadata />);

        // fireEvent returns false when the handler called preventDefault.
        const browserDefaultRan = fireEvent.drop(screen.getByText('choose files'), { dataTransfer: { files: [dropped] } });

        expect(browserDefaultRan).toBe(false);
        expect(onFilesSelect).toHaveBeenCalledWith([dropped]);
    });
});

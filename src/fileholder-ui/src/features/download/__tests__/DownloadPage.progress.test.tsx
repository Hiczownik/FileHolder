import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DownloadPage } from '../DownloadPage';
import type { useFileDownload } from '../hooks/useFileDownload';
import type { FileItemMetadata } from '../types';

type HookState = ReturnType<typeof useFileDownload>;

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
const RECEIVED_MB = 640;
const TOTAL_MB = 1536;
const PROGRESS = { receivedBytes: RECEIVED_MB * BYTES_PER_MB, totalBytes: TOTAL_MB * BYTES_PER_MB };

const hook = vi.hoisted(() => ({ state: null as HookState | null }));

vi.mock('../hooks/useFileDownload', () => ({
    useFileDownload: (): HookState => hook.state!,
}));

const file = (id: string): FileItemMetadata => ({ id, fileName: `${id}.pdf`, sizeBytes: 1, contentType: 'application/pdf' });

const stateWith = (files: FileItemMetadata[], overrides: Partial<HookState>): HookState => ({
    metadata: {
        shareToken: 'progress_token',
        title: 'Progress',
        totalSizeBytes: 1,
        fileCount: files.length,
        requiresPassword: false,
        isUnlocked: true,
        isEncrypted: true,
        isExpired: false,
        files,
    },
    password: '',
    isLoading: false,
    isUnlocking: false,
    downloadingFileId: null,
    isDownloadingAll: false,
    error: null,
    unavailable: null,
    lastSaveReport: null,
    downloadProgress: null,
    promptFor: null,
    setPassword: vi.fn(),
    handleUnlock: vi.fn(),
    handleDownloadFile: vi.fn(),
    handleDownloadAllZip: vi.fn(),
    ...overrides,
});

const renderPage = (): void => {
    render(
        <MemoryRouter initialEntries={['/f/progress_token']}>
            <Routes>
                <Route path="/f/:shareToken" element={<DownloadPage />} />
            </Routes>
        </MemoryRouter>
    );
};

describe('DownloadPage download progress', () => {
    it('shows decrypted bytes on the button of a single encrypted file', () => {
        hook.state = stateWith([file('f1')], { downloadingFileId: 'f1', downloadProgress: PROGRESS });

        renderPage();

        expect(screen.getByRole('button', { name: 'Decrypting… 640 MB of 1.5 GB' })).toBeDisabled();
    });

    it('shows decrypted bytes on the Download All button', () => {
        hook.state = stateWith([file('f1'), file('f2')], { isDownloadingAll: true, downloadProgress: PROGRESS });

        renderPage();

        expect(screen.getByRole('button', { name: 'Decrypting… 640 MB of 1.5 GB' })).toBeDisabled();
    });

    it('keeps the generic text when there is no progress to show', () => {
        hook.state = stateWith([file('f1')], { downloadingFileId: 'f1' });

        renderPage();

        expect(screen.getByRole('button', { name: 'Decrypting & Downloading File...' })).toBeInTheDocument();
    });
});

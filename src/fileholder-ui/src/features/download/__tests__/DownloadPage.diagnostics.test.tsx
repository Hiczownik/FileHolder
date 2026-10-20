import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DownloadPage } from '../DownloadPage';
import type { useFileDownload } from '../hooks/useFileDownload';

const LAST_SAVE = 'Saved "report.pdf" via memory.';

vi.mock('../hooks/useFileDownload', () => ({
    useFileDownload: (): ReturnType<typeof useFileDownload> => ({
        metadata: {
            shareToken: 'diag_token',
            title: 'Diagnostics',
            totalSizeBytes: 1,
            fileCount: 1,
            requiresPassword: false,
            isUnlocked: true,
            isEncrypted: true,
            isExpired: false,
            files: [{ id: 'f1', fileName: 'report.pdf', sizeBytes: 1, contentType: 'application/pdf' }],
        },
        password: '',
        isLoading: false,
        isUnlocking: false,
        downloadingFileId: null,
        isDownloadingAll: false,
        error: null,
        lastSaveReport: LAST_SAVE,
        downloadProgress: null,
        setPassword: vi.fn(),
        handleUnlock: vi.fn(),
        handleDownloadFile: vi.fn(),
        handleDownloadAllZip: vi.fn(),
    }),
}));

const renderAt = (url: string): void => {
    render(
        <MemoryRouter initialEntries={[url]}>
            <Routes>
                <Route path="/f/:shareToken" element={<DownloadPage />} />
            </Routes>
        </MemoryRouter>
    );
};

describe('DownloadPage diagnostics', () => {
    it('shows the diagnostics panel, with the last download, when the link has ?diagnostics', () => {
        renderAt('/f/diag_token?diagnostics');

        expect(screen.getByRole('region', { name: 'Download diagnostics' })).toBeInTheDocument();
        expect(screen.getByText((text) => text.includes(`Last download: ${LAST_SAVE}`))).toBeInTheDocument();
    });

    it('keeps the panel out of sight for everyone else', () => {
        renderAt('/f/diag_token');

        expect(screen.queryByRole('region', { name: 'Download diagnostics' })).not.toBeInTheDocument();
    });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DownloadPage } from '../DownloadPage';
import type { useFileDownload } from '../hooks/useFileDownload';
import type { FileItemMetadata } from '../types';

type HookState = ReturnType<typeof useFileDownload>;

const hook = vi.hoisted(() => ({ state: null as HookState | null }));

vi.mock('../hooks/useFileDownload', () => ({
    useFileDownload: (): HookState => hook.state!,
}));

const file = (id: string): FileItemMetadata => ({ id, fileName: `${id}.pdf`, sizeBytes: 1, contentType: 'application/pdf' });

const stateWith = (files: FileItemMetadata[], overrides: Partial<HookState> = {}): HookState => ({
    metadata: {
        shareToken: 'files_token',
        title: 'Site photos',
        totalSizeBytes: files.length,
        fileCount: files.length,
        requiresPassword: false,
        isUnlocked: true,
        isEncrypted: false,
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

const renderPage = (state: HookState): void => {
    hook.state = state;
    render(
        <MemoryRouter initialEntries={['/f/files_token']}>
            <Routes>
                <Route path="/f/:shareToken" element={<DownloadPage />} />
            </Routes>
        </MemoryRouter>
    );
};

describe('DownloadPage files', () => {
    it('offers the whole bundle as a ZIP and each file on its own', async () => {
        const user = userEvent.setup();
        const state = stateWith([file('plan'), file('survey')]);
        renderPage(state);

        expect(screen.getByRole('button', { name: 'Download all as ZIP' })).toBeEnabled();
        await user.click(screen.getByRole('button', { name: 'Download survey.pdf' }));

        expect(state.handleDownloadFile).toHaveBeenCalledWith('survey');
    });

    it('has one button for a single file, and no row button repeating it', () => {
        renderPage(stateWith([file('lease')]));

        expect(screen.getByRole('button', { name: 'Download file' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Download lease.pdf' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Download all as ZIP' })).not.toBeInTheDocument();
    });

    it('waits with every other download while one file downloads', () => {
        renderPage(stateWith([file('plan'), file('survey')], { downloadingFileId: 'plan' }));

        expect(screen.getByRole('button', { name: 'Download plan.pdf' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Download survey.pdf' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Download all as ZIP' })).toBeDisabled();
    });

    it('waits with the single files while the ZIP downloads', () => {
        renderPage(stateWith([file('plan'), file('survey')], { isDownloadingAll: true }));

        expect(screen.getByRole('button', { name: 'Download plan.pdf' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Download survey.pdf' })).toBeDisabled();
    });

    it('says calmly that an expired or used-up bundle is gone, and nothing else', () => {
        renderPage(stateWith([], { metadata: null, error: 'Link Expired', unavailable: 'gone' }));

        expect(screen.getByRole('heading', { name: 'This bundle is no longer available' })).toHaveFocus();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Share your own files' })).toHaveAttribute('href', '/');
    });

    it('says when a link opens no bundle at all', () => {
        renderPage(stateWith([], { metadata: null, error: 'Not found', unavailable: 'notFound' }));

        expect(screen.getByRole('heading', { name: "This link doesn't open a bundle" })).toBeInTheDocument();
    });
});

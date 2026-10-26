import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SamplePage } from '../SamplePage';
import { SAMPLE_POINTER_PATH } from '../samplePointer';

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const POINTER = {
    link: `${window.location.origin}/f/abc123#k=linkKey`,
    createdAt: '2026-10-26T12:00:00.000Z',
    expiresAt: '2026-10-27T12:00:00.000Z',
};

const Bundle: React.FC = () => {
    const location = useLocation();
    return <p>bundle page at {`${location.pathname}${location.hash}`}</p>;
};

const renderSample = (): void => {
    render(
        <MemoryRouter initialEntries={['/sample']}>
            <Routes>
                <Route path="/sample" element={<SamplePage />} />
                <Route path="/f/:shareToken" element={<Bundle />} />
            </Routes>
        </MemoryRouter>,
    );
};

const answer = (status: number, body: unknown): void => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
};

describe('/sample', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('forwards to the current sample bundle, key included, never from a cache', async () => {
        answer(HTTP_OK, POINTER);

        renderSample();

        expect(await screen.findByText('bundle page at /f/abc123#k=linkKey')).toBeInTheDocument();
        expect(globalThis.fetch).toHaveBeenCalledWith(SAMPLE_POINTER_PATH, { cache: 'no-store' });
    });

    it('says so when there is no sample', async () => {
        answer(HTTP_NOT_FOUND, {});

        renderSample();

        expect(await screen.findByRole('heading', { name: "The sample bundle isn't available right now" })).toHaveFocus();
    });

    it('never forwards anywhere else', async () => {
        answer(HTTP_OK, { ...POINTER, link: 'https://evil.example/f/abc123#k=linkKey' });

        renderSample();

        expect(await screen.findByRole('heading', { name: "The sample bundle isn't available right now" })).toBeInTheDocument();
    });

    it('says so when the pointer cannot be fetched', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

        renderSample();

        expect(await screen.findByRole('heading', { name: "The sample bundle isn't available right now" })).toBeInTheDocument();
    });
});

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';

const OPERATOR = 'Henryk I';
const CONTACT = 'security@fileholder.app';
const ABUSE = 'abuse@fileholder.app';
const DEMO_BYTES = 262_144_000;
const ONE_DAY_HOURS = 24;
const MAX_FILES = 50;

/**
 * The pages read the operator and addresses when they load, so each test imports fresh copies with them set, and
 * mocks the limits request on the fresh copy of the upload API the pages will use.
 */
async function renderPage(page: 'terms' | 'privacy', settings: Record<string, string>): Promise<void> {
    Object.entries(settings).forEach(([name, value]) => vi.stubEnv(name, value));
    vi.resetModules();
    const { uploadApi } = await import('../../upload/api/uploadApi');
    vi.spyOn(uploadApi, 'getLimits').mockResolvedValue({
        maxBundleSizeBytes: DEMO_BYTES, maxFilesPerBundle: MAX_FILES, minExpiryHours: 1, maxExpiryHours: ONE_DAY_HOURS,
    });
    const { TermsPage } = await import('../TermsPage');
    const { PrivacyPage } = await import('../PrivacyPage');
    render(<MemoryRouter>{page === 'terms' ? <TermsPage /> : <PrivacyPage />}</MemoryRouter>);
}

const CONFIGURED = { VITE_OPERATOR_NAME: OPERATOR, VITE_CONTACT_EMAIL: CONTACT, VITE_ABUSE_EMAIL: ABUSE };

describe('legal pages', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('privacy names the operator and how to reach them, up front', async () => {
        await renderPage('privacy', CONFIGURED);

        expect(screen.getByRole('heading', { level: 1, name: 'Privacy' })).toBeInTheDocument();
        const contact = screen.getByRole('complementary', { name: 'Contact' });
        expect(contact).toHaveTextContent(OPERATOR);
        expect(screen.getAllByRole('link', { name: CONTACT })[0]).toHaveAttribute('href', `mailto:${CONTACT}`);
    });

    it("privacy says FileHolder stores no IP addresses, names its providers and the 7-day backups", async () => {
        await renderPage('privacy', CONFIGURED);

        expect(screen.getByText("FileHolder doesn't store IP addresses.", { exact: false })).toBeInTheDocument();
        expect(screen.getByText('OVHcloud')).toBeInTheDocument();
        expect(screen.getByText('Cloudflare')).toBeInTheDocument();
        expect(screen.getByText('keeps automatic backups of the server for 7 days', { exact: false })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'uodo.gov.pl' })).toHaveAttribute('href', 'https://uodo.gov.pl/en');
    });

    it("privacy gives the deployment's own longest expiry, from the server", async () => {
        await renderPage('privacy', CONFIGURED);

        expect(await screen.findByText('after 24 hours at most', { exact: false })).toBeInTheDocument();
    });

    it("terms give the deployment's limits and how to report a bundle", async () => {
        await renderPage('terms', CONFIGURED);

        expect(screen.getByRole('heading', { level: 1, name: 'Terms of use' })).toBeInTheDocument();
        expect(await screen.findByText('up to 50 files (250 MB in total)', { exact: false })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: ABUSE })).toHaveAttribute('href', `mailto:${ABUSE}`);
        expect(screen.getByRole('link', { name: 'privacy page' })).toHaveAttribute('href', '/privacy');
    });

    it('fall back to neutral wording when no operator is configured', async () => {
        await renderPage('terms', { VITE_OPERATOR_NAME: '', VITE_CONTACT_EMAIL: '' });

        expect(screen.getByRole('complementary', { name: 'Contact' })).toHaveTextContent('the operator of this site');
        expect(screen.queryByRole('link', { name: CONTACT })).not.toBeInTheDocument();
    });
});

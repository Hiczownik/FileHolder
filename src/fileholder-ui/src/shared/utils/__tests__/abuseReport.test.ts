import { describe, it, expect, vi, afterEach } from 'vitest';

const ABUSE_EMAIL = 'abuse@fileholder.app';

/** abuseReport.ts reads the address when it loads, so each setting needs a fresh copy of the module. */
const loadWithEmail = async (email: string): Promise<typeof import('../abuseReport')> => {
    vi.stubEnv('VITE_ABUSE_EMAIL', email);
    vi.resetModules();
    return import('../abuseReport');
};

describe('abuse report links', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('mail the configured address', async () => {
        const { abuseReportHref } = await loadWithEmail(ABUSE_EMAIL);

        expect(abuseReportHref()).toBe(`mailto:${ABUSE_EMAIL}?subject=Abuse%20report`);
    });

    it("name the bundle's link, but never its key", async () => {
        const { abuseReportHref } = await loadWithEmail(ABUSE_EMAIL);

        const href = abuseReportHref('https://fileholder.app/f/Ab3dE6gH#k=THE_SECRET_LINK_KEY')!;

        expect(decodeURIComponent(href)).toContain('Link: https://fileholder.app/f/Ab3dE6gH\n');
        expect(href).not.toContain('THE_SECRET_LINK_KEY');
        expect(href).not.toContain('%23');
    });

    it('are hidden when no address is configured', async () => {
        const { abuseReportHref, ABUSE_EMAIL: configured } = await loadWithEmail('');

        expect(configured).toBeUndefined();
        expect(abuseReportHref()).toBeUndefined();
        expect(abuseReportHref('https://fileholder.app/f/Ab3dE6gH')).toBeUndefined();
    });
});

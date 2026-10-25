import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadApi } from '../../api/uploadApi';
import {
    DEFAULT_UPLOAD_LIMITS,
    defaultExpiry,
    describeHours,
    expiryChoices,
    forgetUploadLimits,
    loadUploadLimits,
    type UploadLimits,
} from '../uploadLimits';

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const DEMO_BUNDLE_MIB = 250;
const MAX_FILES = 50;
const ONE_HOUR = 1;
const SIX_HOURS = 6;
const HALF_DAY = 12;
const ONE_DAY = 24;
const DAY_AND_A_HALF = 36;
const TWO_DAYS = 48;
const THREE_DAYS = 72;
const ONE_WEEK = 168;
// The failed request, then the one asked again after it.
const REQUESTS_AFTER_A_FAILURE = 2;

const DEMO: UploadLimits = {
    maxBundleSizeBytes: DEMO_BUNDLE_MIB * BYTES_PER_MIB,
    maxFilesPerBundle: MAX_FILES,
    minExpiryHours: ONE_HOUR,
    maxExpiryHours: ONE_DAY,
};

describe('upload limits', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        forgetUploadLimits();
    });

    it("uses the server's limits, asking only once", async () => {
        const getLimits = vi.spyOn(uploadApi, 'getLimits').mockResolvedValue(DEMO);

        expect(await loadUploadLimits()).toEqual(DEMO);
        expect(await loadUploadLimits()).toEqual(DEMO);
        expect(getLimits).toHaveBeenCalledTimes(1);
    });

    it.each([
        { label: 'the request fails', answer: () => Promise.reject(new Error('Network Error')) },
        { label: 'the answer is not limits', answer: () => Promise.resolve('<html>proxy error</html>') },
        { label: 'a limit is missing', answer: () => Promise.resolve({ ...DEMO, maxExpiryHours: undefined }) },
        { label: 'the expiry range is backwards', answer: () => Promise.resolve({ ...DEMO, minExpiryHours: TWO_DAYS }) },
    ])('falls back to the defaults when $label, and asks again next time', async ({ answer }) => {
        const getLimits = vi.spyOn(uploadApi, 'getLimits').mockImplementation(answer);

        expect(await loadUploadLimits()).toEqual(DEFAULT_UPLOAD_LIMITS);
        await loadUploadLimits();
        expect(getLimits).toHaveBeenCalledTimes(REQUESTS_AFTER_A_FAILURE);
    });

    it.each([
        { max: ONE_WEEK, choices: [ONE_HOUR, HALF_DAY, ONE_DAY, THREE_DAYS, ONE_WEEK] },
        { max: ONE_DAY, choices: [ONE_HOUR, HALF_DAY, ONE_DAY] },
        { max: TWO_DAYS, choices: [ONE_HOUR, HALF_DAY, ONE_DAY, TWO_DAYS] },
        { max: SIX_HOURS, choices: [ONE_HOUR, SIX_HOURS] },
    ])('offers the usual expiries up to $max hours, and the maximum itself', ({ max, choices }) => {
        expect(expiryChoices({ ...DEMO, maxExpiryHours: max })).toEqual(choices);
    });

    it('starts the form at 24 hours, or at the maximum when that is shorter', () => {
        expect(defaultExpiry(DEFAULT_UPLOAD_LIMITS)).toBe(ONE_DAY);
        expect(defaultExpiry({ ...DEMO, maxExpiryHours: HALF_DAY })).toBe(HALF_DAY);
    });

    it.each([
        { hours: ONE_HOUR, text: '1 hour' },
        { hours: HALF_DAY, text: '12 hours' },
        { hours: ONE_DAY, text: '24 hours' },
        { hours: DAY_AND_A_HALF, text: '36 hours' },
        { hours: THREE_DAYS, text: '3 days' },
        { hours: ONE_WEEK, text: '7 days' },
    ])('describes $hours hours as "$text"', ({ hours, text }) => {
        expect(describeHours(hours)).toBe(text);
    });
});

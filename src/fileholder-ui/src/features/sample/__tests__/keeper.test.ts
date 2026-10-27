import { describe, it, expect, vi } from 'vitest';
import { keepSampleFresh, renewalReason, type KeeperSettings, type SampleStatus, type SampleStore } from '../keeper/keeper';
import type { SamplePointer } from '../samplePointer';

const LIFETIME_HOURS = 24;
const RENEW_AFTER_HOURS = 12;
const MIN_REMAINING_DOWNLOADS = 20;
const ALL_DOWNLOADS_LEFT = 100;
const SETTINGS: KeeperSettings = { lifetimeHours: LIFETIME_HOURS, renewAfterHours: RENEW_AFTER_HOURS, minRemainingDownloads: MIN_REMAINING_DOWNLOADS };
const CREATED_AT = new Date('2026-10-26T00:00:00.000Z');
const POINTER: SamplePointer = {
    link: 'https://fileholder.app/f/old#k=key',
    createdAt: CREATED_AT.toISOString(),
    expiresAt: '2026-10-27T00:00:00.000Z',
};
const HOUR_MS = 3_600_000;
const hoursLater = (hours: number): Date => new Date(CREATED_AT.getTime() + hours * HOUR_MS);
const FRESH: SampleStatus = { isExpired: false, remainingDownloads: ALL_DOWNLOADS_LEFT };
const NEW_LINK = 'https://fileholder.app/f/new#k=key';
const ONE_HOUR = 1;
const ELEVEN_HOURS = 11;
const TWELVE_HOURS = 12;
const AT_THRESHOLD = 20;
const ABOVE_THRESHOLD = 21;

function storeWith(pointer: SamplePointer | undefined, status: SampleStatus = FRESH): SampleStore {
    return {
        readPointer: vi.fn().mockResolvedValue(pointer),
        writePointer: vi.fn().mockResolvedValue(undefined),
        statusOf: vi.fn().mockResolvedValue(status),
        upload: vi.fn().mockResolvedValue(NEW_LINK),
    };
}

describe('when the sample needs replacing', () => {
    it.each([
        ['while it is fresh', FRESH, ONE_HOUR, undefined],
        ['just before it is due', FRESH, ELEVEN_HOURS, undefined],
        ['once it is due', FRESH, TWELVE_HOURS, 'due'],
        ['when it is gone', 'gone' as const, ONE_HOUR, 'gone'],
        ['when it has expired', { isExpired: true, remainingDownloads: ALL_DOWNLOADS_LEFT }, ONE_HOUR, 'expired'],
        ['when few downloads are left', { isExpired: false, remainingDownloads: AT_THRESHOLD }, ONE_HOUR, 'few downloads left'],
        ['while enough downloads are left', { isExpired: false, remainingDownloads: ABOVE_THRESHOLD }, ONE_HOUR, undefined],
        ['without a download limit', { isExpired: false, remainingDownloads: null }, ONE_HOUR, undefined],
    ])('%s', (_case, status, hours, reason) => {
        expect(renewalReason(POINTER, status, hoursLater(hours), SETTINGS)).toBe(reason);
    });
});

describe('a round of the keeper', () => {
    it('makes the first sample, and points at it', async () => {
        const store = storeWith(undefined);
        const now = hoursLater(ONE_HOUR);

        expect(await keepSampleFresh(store, SETTINGS, now)).toBe('no sample yet');

        expect(store.upload).toHaveBeenCalledWith(now);
        expect(store.writePointer).toHaveBeenCalledWith({
            link: NEW_LINK,
            createdAt: now.toISOString(),
            expiresAt: hoursLater(ONE_HOUR + SETTINGS.lifetimeHours).toISOString(),
        });
    });

    it('leaves a fresh sample alone', async () => {
        const store = storeWith(POINTER);

        expect(await keepSampleFresh(store, SETTINGS, hoursLater(ONE_HOUR))).toBeUndefined();

        expect(store.upload).not.toHaveBeenCalled();
        expect(store.writePointer).not.toHaveBeenCalled();
    });

    it('replaces a sample that is due', async () => {
        const store = storeWith(POINTER);

        expect(await keepSampleFresh(store, SETTINGS, hoursLater(TWELVE_HOURS))).toBe('due');

        expect(store.writePointer).toHaveBeenCalledWith(expect.objectContaining({ link: NEW_LINK }));
    });

    it('keeps pointing at the old sample when the upload fails', async () => {
        const store = storeWith(POINTER, 'gone');
        vi.mocked(store.upload).mockRejectedValue(new Error('storage is down'));

        await expect(keepSampleFresh(store, SETTINGS, hoursLater(ONE_HOUR))).rejects.toThrow('storage is down');

        expect(store.writePointer).not.toHaveBeenCalled();
    });
});

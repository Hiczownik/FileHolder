import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
    NORMAL_STATUS,
    STATUS_URL,
    describeUntil,
    forgetServiceStatus,
    loadServiceStatus,
    parseServiceStatus,
    refreshServiceStatus,
    subscribeToServiceStatus,
} from '../serviceStatus';

const UNTIL = '2030-01-01T14:00:00Z';
const ONE_HOUR_MS = 3_600_000;

describe('service status', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        forgetServiceStatus();
    });

    it('is asked for next to the files API', () => {
        expect(STATUS_URL).toBe('http://localhost:8080/api/v1/status');
    });

    it("reads the server's answer", () => {
        expect(parseServiceStatus({ mode: 'UploadsPaused', message: 'Back soon.', until: UNTIL })).toEqual({
            mode: 'UploadsPaused',
            message: 'Back soon.',
            until: new Date(UNTIL),
        });
    });

    it.each([
        ['nothing', null],
        ['an unknown mode', { mode: 'Sleeping' }],
        ['a string', 'Closed'],
    ])('reads %s as Normal: the server enforces the mode either way', (_, value) => {
        expect(parseServiceStatus(value)).toEqual(NORMAL_STATUS);
    });

    it('drops a blank message and an unreadable until', () => {
        expect(parseServiceStatus({ mode: 'Closed', message: '  ', until: 'soon' })).toEqual({ mode: 'Closed', message: null, until: null });
    });

    it('asks once per page load, and shares the answer', async () => {
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: { mode: 'ReadOnly', message: null, until: null } });

        const [first, second] = await Promise.all([loadServiceStatus(), loadServiceStatus()]);

        expect(first.mode).toBe('ReadOnly');
        expect(second).toBe(first);
        expect(get).toHaveBeenCalledTimes(1);
        expect(get).toHaveBeenCalledWith(STATUS_URL);
    });

    it("is Normal when the server can't be asked, so the app still shows", async () => {
        vi.spyOn(axios, 'get').mockRejectedValue(new Error('Network Error'));

        expect(await loadServiceStatus()).toEqual(NORMAL_STATUS);
    });

    it('asks again when refreshed, and tells everyone showing it', async () => {
        vi.spyOn(axios, 'get')
            .mockResolvedValueOnce({ data: { mode: 'Normal' } })
            .mockResolvedValueOnce({ data: { mode: 'UploadsPaused' } });
        const listener = vi.fn();
        subscribeToServiceStatus(listener);

        await loadServiceStatus();
        await refreshServiceStatus();

        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'UploadsPaused' }));
        expect((await loadServiceStatus()).mode).toBe('UploadsPaused');
    });

    it('says when the owner expects to be back, only while that is ahead', () => {
        const now = new Date(UNTIL);

        const ahead = describeUntil(new Date(now.getTime() + ONE_HOUR_MS), now);
        expect(ahead?.startsWith('Expected back ')).toBe(true);
        expect(ahead?.endsWith('.')).toBe(true);
        expect(describeUntil(new Date(now.getTime() - ONE_HOUR_MS), now)).toBeNull();
        expect(describeUntil(null, now)).toBeNull();
    });
});

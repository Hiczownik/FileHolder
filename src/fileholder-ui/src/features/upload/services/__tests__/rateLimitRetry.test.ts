import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { rateLimitWaitMs, withRateLimitRetry } from '../rateLimitRetry';

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_BAD_REQUEST = 400;
const MS_PER_SECOND = 1000;
const RETRY_AFTER_SECONDS = 7;
const DEFAULT_WAIT_MS = 5000;
const MAX_WAIT_MS = 60_000;
const OVERLONG_RETRY_AFTER = '3600';
const WAITS_WITHIN_BUDGET = 3;
const DATE_OFFSET_SECONDS = 10;
const CALLS_WITH_ONE_RETRY = 2;

const httpError = (status: number, retryAfter?: string): AxiosError =>
    new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
        status,
        statusText: '',
        data: null,
        headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
        config: { headers: new AxiosHeaders() },
    });

describe('rateLimitWaitMs', () => {
    it('reads Retry-After in seconds', () => {
        expect(rateLimitWaitMs(httpError(HTTP_TOO_MANY_REQUESTS, String(RETRY_AFTER_SECONDS)))).toBe(RETRY_AFTER_SECONDS * MS_PER_SECOND);
    });

    it('reads Retry-After as an HTTP date', () => {
        const now = Date.parse('2026-10-21T12:00:00Z');
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const header = new Date(now + DATE_OFFSET_SECONDS * MS_PER_SECOND).toUTCString();

        expect(rateLimitWaitMs(httpError(HTTP_TOO_MANY_REQUESTS, header))).toBe(DATE_OFFSET_SECONDS * MS_PER_SECOND);
        vi.restoreAllMocks();
    });

    it('waits a few seconds when the header is missing, and never longer than a minute', () => {
        expect(rateLimitWaitMs(httpError(HTTP_TOO_MANY_REQUESTS))).toBe(DEFAULT_WAIT_MS);
        expect(rateLimitWaitMs(httpError(HTTP_TOO_MANY_REQUESTS, OVERLONG_RETRY_AFTER))).toBe(MAX_WAIT_MS);
    });

    it('ignores anything that is not a 429', () => {
        expect(rateLimitWaitMs(httpError(HTTP_BAD_REQUEST))).toBeNull();
        expect(rateLimitWaitMs(new Error('network'))).toBeNull();
    });
});

describe('withRateLimitRetry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('waits as long as Retry-After says, then sends the request again', async () => {
        const request = vi.fn()
            .mockRejectedValueOnce(httpError(HTTP_TOO_MANY_REQUESTS, String(RETRY_AFTER_SECONDS)))
            .mockResolvedValue('ok');

        const result = withRateLimitRetry(request);
        await vi.advanceTimersByTimeAsync(RETRY_AFTER_SECONDS * MS_PER_SECOND - 1);
        expect(request).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe('ok');
        expect(request).toHaveBeenCalledTimes(CALLS_WITH_ONE_RETRY);
    });

    it('does not retry other errors', async () => {
        const request = vi.fn().mockRejectedValue(httpError(HTTP_BAD_REQUEST));

        await expect(withRateLimitRetry(request)).rejects.toMatchObject({ response: { status: HTTP_BAD_REQUEST } });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('gives up once it has waited three minutes in all', async () => {
        const request = vi.fn().mockRejectedValue(httpError(HTTP_TOO_MANY_REQUESTS, OVERLONG_RETRY_AFTER));

        const result = withRateLimitRetry(request);
        const settled = expect(result).rejects.toMatchObject({ response: { status: HTTP_TOO_MANY_REQUESTS } });
        await vi.advanceTimersByTimeAsync(WAITS_WITHIN_BUDGET * MAX_WAIT_MS);
        await settled;

        // Three one-minute waits fit the budget; a fourth would not, so the fourth 429 is the error.
        expect(request).toHaveBeenCalledTimes(WAITS_WITHIN_BUDGET + 1);
    });

    it('stops waiting as soon as the upload is cancelled', async () => {
        const controller = new AbortController();
        const request = vi.fn().mockRejectedValue(httpError(HTTP_TOO_MANY_REQUESTS, String(RETRY_AFTER_SECONDS)));

        const result = withRateLimitRetry(request, controller.signal);
        const settled = expect(result).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(1);
        controller.abort();
        await settled;

        expect(request).toHaveBeenCalledTimes(1);
    });
});

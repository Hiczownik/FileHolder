import { isAxiosError } from 'axios';

const HTTP_TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;
// Used when a 429 comes without a readable Retry-After.
const DEFAULT_WAIT_SECONDS = 5;
// The server's windows are a minute long, so a longer wait would be a misread header.
const MAX_WAIT_SECONDS = 60;
// After this much waiting in total, the request fails like any other, rather than stalling the upload for good.
const MAX_TOTAL_WAIT_SECONDS = 180;

export const abortError = (): DOMException => new DOMException('Upload aborted by user', 'AbortError');

/** Retry-After is either a number of seconds or an HTTP date; the API sends seconds. */
const parseRetryAfterSeconds = (header: unknown): number => {
    if (typeof header !== 'string' || header.trim() === '') return DEFAULT_WAIT_SECONDS;

    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds;

    const date = Date.parse(header);
    return Number.isNaN(date) ? DEFAULT_WAIT_SECONDS : (date - Date.now()) / MS_PER_SECOND;
};

/** How long a 429 asks the client to wait, or null when the error is anything else. */
export const rateLimitWaitMs = (err: unknown): number | null => {
    if (!isAxiosError(err) || err.response?.status !== HTTP_TOO_MANY_REQUESTS) return null;

    const seconds = parseRetryAfterSeconds(err.response.headers['retry-after']);
    return Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS) * MS_PER_SECOND;
};

const waitUnlessAborted = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });

/**
 * Sends an API request, and when the server answers 429 waits as long as its Retry-After says and sends it
 * again. These waits don't count as failed attempts: a large bundle can briefly outpace the rate limit
 * without anything being wrong.
 */
export async function withRateLimitRetry<T>(
    request: () => Promise<T>,
    signal?: AbortSignal,
    waitedMs = 0
): Promise<T> {
    try {
        return await request();
    } catch (err: unknown) {
        const waitMs = rateLimitWaitMs(err);
        if (waitMs === null || waitedMs + waitMs > MAX_TOTAL_WAIT_SECONDS * MS_PER_SECOND) {
            throw err;
        }
        await waitUnlessAborted(waitMs, signal);
        return withRateLimitRetry(request, signal, waitedMs + waitMs);
    }
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import { uploadApi } from '../../api/uploadApi';
import { accessCodeStore, checkAccessCode, takeAccessCodeFromAddressBar } from '../accessCode';
import { DEFAULT_UPLOAD_LIMITS } from '../uploadLimits';

const CODE = 'a03-7F3K-9Q2M-X8PD';
const REFUSAL = "This access code isn't valid or has expired. You can still upload with the smaller limits.";
const ROUTER_STATE = { idx: 3 };
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const WITH_CODE = { ...DEFAULT_UPLOAD_LIMITS, accessCodesEnabled: true };

const refusedWith = (status: number, data?: unknown): AxiosError =>
    new AxiosError('refused', undefined, undefined, undefined, { status, data } as AxiosResponse);

describe('the access code store', () => {
    beforeEach(() => {
        sessionStorage.clear();
        accessCodeStore.forget();
    });

    it('keeps the code in sessionStorage, so a reload of the tab still has it', () => {
        accessCodeStore.save(CODE);
        accessCodeStore.forget();

        expect(accessCodeStore.get()).toBe(CODE);
    });

    it('forgets the code when cleared', () => {
        accessCodeStore.save(CODE);
        accessCodeStore.clear();
        accessCodeStore.forget();

        expect(accessCodeStore.get()).toBeNull();
    });

    it('still keeps the code in memory when sessionStorage is unavailable', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });

        accessCodeStore.save(CODE);

        expect(accessCodeStore.get()).toBe(CODE);
        vi.restoreAllMocks();
    });
});

describe('a personal link', () => {
    it('gives its code and removes it from the address bar, keeping the rest of the address', () => {
        window.history.replaceState(ROUTER_STATE, '', `/?code=${CODE}&lang=en#top`);

        expect(takeAccessCodeFromAddressBar()).toBe(CODE);

        expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/?lang=en#top');
        expect(window.history.state).toEqual(ROUTER_STATE);
    });

    it('gives nothing without a code, and leaves the address alone', () => {
        window.history.replaceState(null, '', '/?lang=en');
        const replace = vi.spyOn(window.history, 'replaceState');

        expect(takeAccessCodeFromAddressBar()).toBeUndefined();

        expect(replace).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it('removes an empty code too', () => {
        window.history.replaceState(null, '', '/?code=');

        expect(takeAccessCodeFromAddressBar()).toBeUndefined();
        expect(window.location.search).toBe('');
    });
});

describe('checking an access code', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("gives a valid code's limits", async () => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockResolvedValue(WITH_CODE);

        expect(await checkAccessCode(CODE)).toEqual({ status: 'valid', limits: WITH_CODE });
        expect(uploadApi.checkAccessCode).toHaveBeenCalledWith(CODE);
    });

    it("gives the server's message for an invalid code", async () => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockRejectedValue(refusedWith(HTTP_BAD_REQUEST, { detail: 'Server says no.' }));

        expect(await checkAccessCode(CODE)).toEqual({ status: 'invalid', message: 'Server says no.' });
    });

    it('explains an invalid code itself when the server gives no message', async () => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockRejectedValue(refusedWith(HTTP_BAD_REQUEST));

        expect(await checkAccessCode(CODE)).toEqual({ status: 'invalid', message: REFUSAL });
    });

    it.each([
        ['the server is unreachable', new Error('Network Error')],
        ['codes are off', refusedWith(HTTP_NOT_FOUND)],
        ['the server is busy', refusedWith(HTTP_TOO_MANY_REQUESTS)],
    ])("says the code couldn't be checked when %s", async (_case, error) => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockRejectedValue(error);

        expect(await checkAccessCode(CODE)).toEqual({ status: 'unavailable' });
    });

    it('says the code couldn\'t be checked when the answer is something else', async () => {
        vi.spyOn(uploadApi, 'checkAccessCode').mockResolvedValue({ unexpected: true } as never);

        expect(await checkAccessCode(CODE)).toEqual({ status: 'unavailable' });
    });
});

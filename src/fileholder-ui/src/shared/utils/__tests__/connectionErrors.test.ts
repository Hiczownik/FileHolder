import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { isConnectionLost } from '../connectionErrors';

const HTTP_UNAUTHORIZED = 401;

const axiosErrorWith = (code: string, status?: number): AxiosError =>
    new AxiosError('Request failed', code, undefined, undefined, status === undefined ? undefined : {
        status,
        statusText: '',
        data: null,
        headers: {},
        config: { headers: new AxiosHeaders() },
    });

describe('isConnectionLost', () => {
    it.each([
        ['Chrome', new TypeError('Failed to fetch')],
        ['Chrome, mid-stream', new TypeError('network error')],
        ['Firefox', new TypeError('NetworkError when attempting to fetch resource.')],
        ['Safari', new TypeError('Load failed')],
        ['Safari, mid-stream', new TypeError('The network connection was lost.')],
        ['an API call that got no answer', axiosErrorWith('ERR_NETWORK')],
    ])('recognises a dropped connection (%s)', (_, err) => {
        expect(isConnectionLost(err)).toBe(true);
    });

    it.each([
        ['a tampered file', new Error('Decryption failed at chunk 1: the file is corrupted, incomplete or was tampered with.')],
        ['a programming error', new TypeError('x is not a function')],
        ['an answer from the server', axiosErrorWith('ERR_BAD_REQUEST', HTTP_UNAUTHORIZED)],
        ['a request the page cancelled', axiosErrorWith('ERR_CANCELED')],
    ])('does not mistake %s for one', (_, err) => {
        expect(isConnectionLost(err)).toBe(false);
    });
});

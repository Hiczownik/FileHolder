import { describe, it, expect } from 'vitest';
import { parseApiError } from '../parseApiError';
import { AxiosError, AxiosHeaders } from 'axios';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const HTTP_TOO_MANY_REQUESTS = 429;

describe('parseApiError Utility', () => {
    const createMockAxiosError = (status: number, data: unknown ): AxiosError => {
        return new AxiosError(
            'Request failed with status code ' + status,
            'ERR_BAD_REQUEST',
            undefined,
            undefined,
            {
                status,
                statusText: 'Error',
                data,
                headers: {},
                config: { headers: new AxiosHeaders() },
            }
        );
    };

    it('flattens ASP.NET Core ValidationProblem errors dictionary into a string', () => {
        const error = createMockAxiosError(HTTP_BAD_REQUEST, {
            title: 'One or more validation errors occurred.',
            errors: {
                FileName: ['Forbidden file extension.'],
                SizeBytes: ['File size must be greater than 0.'],
            },
        });

        const message = parseApiError(error);
        expect(message).toBe('Forbidden file extension. File size must be greater than 0.');
    });

    it('extracts detail field from RFC 7807 ProblemDetails', () => {
        const error = createMockAxiosError(HTTP_GONE, {
            title: 'Link Expired',
            detail: 'This shared file group has expired or reached its download limit.',
            status: HTTP_GONE,
        });

        const message = parseApiError(error);
        expect(message).toBe('This shared file group has expired or reached its download limit.');
    });

    it('falls back to title field if detail is missing', () => {
        const error = createMockAxiosError(HTTP_NOT_FOUND, {
            title: 'Resource Not Found',
            status: HTTP_NOT_FOUND,
        });

        const message = parseApiError(error);
        expect(message).toBe('Resource Not Found');
    });

    it('shows the lockout detail for a bundle locked after too many wrong passwords', () => {
        const error = createMockAxiosError(HTTP_TOO_MANY_REQUESTS, {
            title: 'Too Many Attempts',
            detail: 'Too many incorrect passwords. Try again in 2 minutes.',
            status: HTTP_TOO_MANY_REQUESTS,
        });

        expect(parseApiError(error)).toBe('Too many incorrect passwords. Try again in 2 minutes.');
    });

    it('shows a friendly message when the rate limiter answers 429 with an empty body', () => {
        const error = createMockAxiosError(HTTP_TOO_MANY_REQUESTS, '');

        expect(parseApiError(error)).toBe('Too many requests. Please wait a moment and try again.');
    });

    it('extracts network client error message when response is undefined', () => {
        const error = new AxiosError('Network Error');
        const message = parseApiError(error);
        expect(message).toBe('Client Error: Network Error');
    });
});
import { describe, it, expect } from 'vitest';
import { parseApiError } from '../parseApiError';
import { AxiosError, AxiosHeaders } from 'axios';

describe('parseApiError Utility', () => {
    const createMockAxiosError = (status: number, data: any): AxiosError => {
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
        const error = createMockAxiosError(400, {
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
        const error = createMockAxiosError(410, {
            title: 'Link Expired',
            detail: 'This shared file group has expired or reached its download limit.',
            status: 410,
        });

        const message = parseApiError(error);
        expect(message).toBe('This shared file group has expired or reached its download limit.');
    });

    it('falls back to title field if detail is missing', () => {
        const error = createMockAxiosError(404, {
            title: 'Resource Not Found',
            status: 404,
        });

        const message = parseApiError(error);
        expect(message).toBe('Resource Not Found');
    });

    it('extracts network client error message when response is undefined', () => {
        const error = new AxiosError('Network Error');
        const message = parseApiError(error);
        expect(message).toBe('Client Error: Network Error');
    });
});
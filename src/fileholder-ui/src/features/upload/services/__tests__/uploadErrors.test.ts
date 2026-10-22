import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { UPLOAD_CONNECTION_LOST_MESSAGE, describeUploadError, uploadRefusedMessage } from '../uploadErrors';

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;

const answeredWith = (status: number, data: unknown): AxiosError =>
    new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', undefined, undefined, {
        status,
        statusText: '',
        data,
        headers: {},
        config: { headers: new AxiosHeaders() },
    });

const S3_ERROR = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code></Error>';

describe('describeUploadError', () => {
    it('says the connection was lost when a request got no answer', () => {
        expect(describeUploadError(new AxiosError('Network Error', 'ERR_NETWORK'))).toBe(UPLOAD_CONNECTION_LOST_MESSAGE);
    });

    it.each([
        ['storage failing a part (XML)', HTTP_INTERNAL_SERVER_ERROR, S3_ERROR],
        ['storage refusing a signature (XML)', HTTP_FORBIDDEN, '<Error><Code>SignatureDoesNotMatch</Code></Error>'],
        ['a proxy in front of the API (HTML)', HTTP_BAD_GATEWAY, '<html><body>502 Bad Gateway</body></html>'],
        ['an empty answer', HTTP_INTERNAL_SERVER_ERROR, ''],
    ])('gives the status and says nothing was shared for %s', (_, status, body) => {
        expect(describeUploadError(answeredWith(status, body))).toBe(uploadRefusedMessage(status));
    });

    it("keeps the API's own explanation", () => {
        const problem = { title: 'Bad Request', detail: 'The bundle cannot be larger than 5 GB.' };
        expect(describeUploadError(answeredWith(HTTP_BAD_REQUEST, problem))).toBe('The bundle cannot be larger than 5 GB.');
    });

    it("keeps the rate limiter's wording for its empty 429", () => {
        expect(describeUploadError(answeredWith(HTTP_TOO_MANY_REQUESTS, ''))).toBe('Too many requests. Please wait a moment and try again.');
    });

    it('keeps errors raised in the page as they are', () => {
        expect(describeUploadError(new Error('Forbidden file extension detected.'))).toBe('Forbidden file extension detected.');
    });
});

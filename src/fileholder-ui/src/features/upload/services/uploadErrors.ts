import { isAxiosError } from 'axios';
import { isConnectionLost } from '../../../shared/utils/connectionErrors';
import { parseApiError } from '../../../shared/utils/parseApiError';

const HTTP_TOO_MANY_REQUESTS = 429;

export const UPLOAD_CONNECTION_LOST_MESSAGE =
    'The connection was lost while uploading, so nothing was shared. Check your connection and try again.';

export const uploadRefusedMessage = (status: number): string =>
    `The upload failed (the server answered HTTP ${status}), so nothing was shared. Please try again in a moment.`;

/**
 * What to tell the uploader when an upload fails. The API explains its own refusals in JSON, which parseApiError
 * reads; storage answers part uploads in XML, and a proxy in front of either may answer in HTML, neither of which
 * says anything the uploader could act on, so those get a plain message with the status instead.
 */
export function describeUploadError(err: unknown): string {
    if (isConnectionLost(err)) {
        return UPLOAD_CONNECTION_LOST_MESSAGE;
    }
    // The rate limiter answers 429 with an empty body; parseApiError already has the right words for it.
    if (isAxiosError(err) && err.response && err.response.status !== HTTP_TOO_MANY_REQUESTS) {
        const { data, status } = err.response;
        if (typeof data !== 'object' || data === null) {
            return uploadRefusedMessage(status);
        }
    }
    return parseApiError(err);
}

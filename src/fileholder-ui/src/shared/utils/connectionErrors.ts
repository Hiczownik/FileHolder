import { isAxiosError } from 'axios';

// Matches the TypeError messages browsers give when a fetch or its body stream fails on the network:
// Chrome "Failed to fetch" / "network error", Firefox "NetworkError when attempting to fetch resource.",
// Safari "Load failed" / "The network connection was lost.". Doesn't match a programming error like
// "x is not a function".
// https://regex101.com/?regex=fetch%7Cnetwork%7Cload%20failed%7Cconnection&flags=gim&testString=Failed%20to%20fetch%0ANetworkError%20when%20attempting%20to%20fetch%20resource.%0ALoad%20failed%0Ax%20is%20not%20a%20function
const NETWORK_FAILURE = /fetch|network|load failed|connection/i;

/** True when a request or download failed because the connection dropped, not because of what came back. */
export function isConnectionLost(err: unknown): boolean {
    if (isAxiosError(err)) {
        // No response at all means the request never got an answer, e.g. the device went offline.
        return err.response === undefined && err.code !== 'ERR_CANCELED';
    }
    return err instanceof TypeError && NETWORK_FAILURE.test(err.message);
}

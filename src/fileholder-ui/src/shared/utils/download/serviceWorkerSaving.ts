import { attachmentDisposition } from './contentDisposition';
import type { SaveOutcome, StreamedFile } from './streamSaving';

/**
 * Page side of public/download-sw.js (the protocol is described there). The worker serves the stream as an
 * ordinary download, so the browser writes it to disk as it arrives.
 */

export const DOWNLOAD_WORKER_URL = '/download-sw.js';
export const DOWNLOAD_WORKER_SCOPE = '/__download/';

const MS_PER_SECOND = 1000;
const ACTIVATION_TIMEOUT_SECONDS = 5;
const REGISTERED_TIMEOUT_SECONDS = 3;
// Long enough for a slow iframe navigation; if the worker hasn't answered by then, it isn't going to.
const STARTED_TIMEOUT_SECONDS = 10;
const KEEPALIVE_INTERVAL_SECONDS = 10;
// The iframe is only needed until the browser has turned its navigation into a download.
const IFRAME_REMOVAL_DELAY_SECONDS = 60;

interface WorkerMessage {
    readonly type: 'registered' | 'started' | 'pull' | 'cancel';
}

export interface ServiceWorkerSavingDeps {
    readonly getWorker: () => Promise<ServiceWorker | null>;
    readonly openUrl: (url: string) => void;
}

export class DownloadCancelledError extends Error {
    constructor() {
        super('The download was cancelled.');
        this.name = 'DownloadCancelledError';
    }
}

const withTimeout = <T,>(promise: Promise<T>, seconds: number): Promise<T | null> =>
    Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), seconds * MS_PER_SECOND))]);

let activeWorker: Promise<ServiceWorker | null> | null = null;

const waitUntilActivated = (worker: ServiceWorker): Promise<ServiceWorker> =>
    new Promise((resolve) => {
        if (worker.state === 'activated') {
            resolve(worker);
            return;
        }
        worker.addEventListener('statechange', () => {
            if (worker.state === 'activated') {
                resolve(worker);
            }
        });
    });

const registerWorker = async (): Promise<ServiceWorker | null> => {
    try {
        const registration = await navigator.serviceWorker.register(DOWNLOAD_WORKER_URL, { scope: DOWNLOAD_WORKER_SCOPE });
        const worker = registration.active ?? registration.waiting ?? registration.installing;
        return worker ? await withTimeout(waitUntilActivated(worker), ACTIVATION_TIMEOUT_SECONDS) : null;
    } catch {
        // Blocked (e.g. Firefox private windows, or storage disabled): the next saving method takes over.
        return null;
    }
};

/** Registers the worker once per page load and reuses it. */
export const getDownloadWorker = (): Promise<ServiceWorker | null> => {
    activeWorker ??= registerWorker();
    return activeWorker;
};

/** Opens the download URL in a hidden iframe, so the page itself never navigates away. */
export const openInHiddenIframe = (url: string): void => {
    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    iframe.src = url;
    document.body.appendChild(iframe);
    setTimeout(() => iframe.remove(), IFRAME_REMOVAL_DELAY_SECONDS * MS_PER_SECOND);
};

const defaultDeps: ServiceWorkerSavingDeps = { getWorker: getDownloadWorker, openUrl: openInHiddenIframe };

/**
 * Returns 'unavailable' without having read from the stream when the worker can't serve this download, so
 * the caller can still save the stream another way. Once the worker reports the browser has the response,
 * there is no turning back: errors reject (and fail the browser's download) instead.
 */
export async function saveViaServiceWorker(
    stream: ReadableStream<Uint8Array>,
    file: StreamedFile,
    deps: ServiceWorkerSavingDeps = defaultDeps
): Promise<SaveOutcome> {
    const worker = await deps.getWorker();
    if (!worker) {
        return 'unavailable';
    }

    const id = crypto.randomUUID();
    const channel = new MessageChannel();
    const port = channel.port1;
    const messages: WorkerMessage[] = [];
    const waiters: ((message: WorkerMessage) => void)[] = [];

    port.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const waiter = waiters.shift();
        if (waiter) {
            waiter(event.data);
        } else {
            messages.push(event.data);
        }
    };
    const nextMessage = (): Promise<WorkerMessage> => {
        const queued = messages.shift();
        return queued ? Promise.resolve(queued) : new Promise((resolve) => waiters.push(resolve));
    };

    const keepalive = setInterval(() => worker.postMessage({ type: 'keepalive' }), KEEPALIVE_INTERVAL_SECONDS * MS_PER_SECOND);
    let handedOver = false;

    try {
        worker.postMessage({ type: 'register-download', id, disposition: attachmentDisposition(file.fileName) }, [channel.port2]);
        const registered = await withTimeout(nextMessage(), REGISTERED_TIMEOUT_SECONDS);
        if (registered?.type !== 'registered') {
            return 'unavailable';
        }

        deps.openUrl(`${DOWNLOAD_WORKER_SCOPE}${id}`);
        const started = await withTimeout(nextMessage(), STARTED_TIMEOUT_SECONDS);
        if (started?.type !== 'started') {
            return 'unavailable';
        }

        handedOver = true;
        await pump(stream.getReader(), port, nextMessage);
        return 'saved';
    } finally {
        clearInterval(keepalive);
        if (!handedOver) {
            // Should the iframe's request still reach the worker, this is the first answer it gets, so that
            // download fails at once instead of waiting on a page that has saved the file another way.
            port.postMessage({ type: 'error', message: 'This download was saved another way.' });
            port.close();
        }
    }
}

/** Answers each of the worker's pulls with the stream's next chunk, until the stream ends, fails or is cancelled. */
async function pump(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    port: MessagePort,
    nextMessage: () => Promise<WorkerMessage>
): Promise<void> {
    const message = await nextMessage();
    if (message.type === 'cancel') {
        await reader.cancel();
        port.close();
        throw new DownloadCancelledError();
    }
    if (message.type !== 'pull') {
        return pump(reader, port, nextMessage);
    }

    try {
        const { done, value } = await reader.read();
        if (done) {
            port.postMessage({ type: 'done' });
            port.close();
            return;
        }
        // Copied into a buffer of its own so it can be transferred rather than cloned.
        const bytes = value.slice().buffer;
        port.postMessage({ type: 'chunk', bytes }, [bytes]);
    } catch (err: unknown) {
        port.postMessage({ type: 'error', message: err instanceof Error ? err.message : 'The download failed.' });
        port.close();
        throw err;
    }

    return pump(reader, port, nextMessage);
}

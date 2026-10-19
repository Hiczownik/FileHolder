import { describe, it, expect, vi, afterEach } from 'vitest';
import { DOWNLOAD_WORKER_SCOPE, DownloadCancelledError, saveViaServiceWorker } from '../serviceWorkerSaving';

const FIRST_LENGTH = 3;
const SECOND_LENGTH = 2;
const FIRST = Uint8Array.from({ length: FIRST_LENGTH }, (_, i) => i + 1);
const SECOND = Uint8Array.from({ length: SECOND_LENGTH }, (_, i) => FIRST_LENGTH + i + 1);
const UUID_LENGTH = 36;
const REGISTERED_TIMEOUT_MS = 3_000;
const STARTED_TIMEOUT_MS = 10_000;

interface PortMessage {
    readonly type: string;
    readonly bytes?: ArrayBuffer;
    readonly message?: string;
}

/** Reads messages from a port one at a time, in order. */
const messageQueue = (port: MessagePort): (() => Promise<PortMessage>) => {
    const queued: PortMessage[] = [];
    const waiting: ((message: PortMessage) => void)[] = [];
    port.addEventListener('message', (event: MessageEvent<PortMessage>) => {
        const waiter = waiting.shift();
        if (waiter) waiter(event.data);
        else queued.push(event.data);
    });
    port.start();
    return () => {
        const next = queued.shift();
        return next ? Promise.resolve(next) : new Promise((resolve) => waiting.push(resolve));
    };
};

/** Plays the worker's part of download-sw.js: registers downloads and hands back the port for each. */
const createFakeWorker = (answersRegistration = true) => {
    const ports: MessagePort[] = [];
    const worker = {
        postMessage: (message: PortMessage, transfer?: Transferable[]) => {
            if (message.type !== 'register-download' || !answersRegistration) return;
            const port = transfer?.[0] as MessagePort;
            ports.push(port);
            port.postMessage({ type: 'registered' });
        },
    } as unknown as ServiceWorker;
    return { worker, ports };
};

/** Plays the browser downloading the worker's response: pulls chunks until done, error or cancel. */
const downloadFrom = async (next: () => Promise<PortMessage>, port: MessagePort, cancelAfterChunks?: number): Promise<number[]> => {
    port.postMessage({ type: 'started' });
    const pullAll = async (received: number[], chunks: number): Promise<number[]> => {
        if (chunks === cancelAfterChunks) {
            port.postMessage({ type: 'cancel' });
            return received;
        }
        port.postMessage({ type: 'pull' });
        const message = await next();
        if (message.type === 'done') return received;
        if (message.type !== 'chunk') throw new Error(message.message);
        return pullAll([...received, ...new Uint8Array(message.bytes!)], chunks + 1);
    };
    return pullAll([], 0);
};

const streamOf = (...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start: (controller) => {
            chunks.forEach((chunk) => controller.enqueue(chunk));
            controller.close();
        },
    });

describe('saveViaServiceWorker', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('streams every chunk, in order, to the download the worker serves', async () => {
        const { worker, ports } = createFakeWorker();
        let openedUrl = '';
        let downloaded: Promise<number[]> = Promise.resolve([]);
        const openUrl = (url: string): void => {
            openedUrl = url;
            downloaded = downloadFrom(messageQueue(ports[0]), ports[0]);
        };

        const outcome = await saveViaServiceWorker(streamOf(FIRST, SECOND), { fileName: 'a.bin' }, { getWorker: async () => worker, openUrl });

        expect(outcome).toBe('saved');
        expect(await downloaded).toEqual([...FIRST, ...SECOND]);
        expect(openedUrl.startsWith(DOWNLOAD_WORKER_SCOPE)).toBe(true);
        expect(openedUrl.length).toBe(DOWNLOAD_WORKER_SCOPE.length + UUID_LENGTH);
    });

    it('is unavailable, leaving the stream untouched, when there is no worker', async () => {
        const stream = streamOf(FIRST);

        expect(await saveViaServiceWorker(stream, { fileName: 'a.bin' }, { getWorker: async () => null, openUrl: vi.fn() })).toBe('unavailable');
        expect(stream.locked).toBe(false);
    });

    it('is unavailable when the worker never confirms the registration', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        const { worker } = createFakeWorker(false);
        const stream = streamOf(FIRST);
        const openUrl = vi.fn();

        const outcome = saveViaServiceWorker(stream, { fileName: 'a.bin' }, { getWorker: async () => worker, openUrl });
        await vi.advanceTimersByTimeAsync(REGISTERED_TIMEOUT_MS);

        expect(await outcome).toBe('unavailable');
        expect(openUrl).not.toHaveBeenCalled();
        expect(stream.locked).toBe(false);
    });

    it('is unavailable when the download never starts, and fails that download should it start later', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        const { worker, ports } = createFakeWorker();
        const stream = streamOf(FIRST);
        let markOpened: () => void = () => undefined;
        const opened = new Promise<void>((resolve) => { markOpened = resolve; });

        const outcome = saveViaServiceWorker(stream, { fileName: 'a.bin' }, { getWorker: async () => worker, openUrl: () => markOpened() });
        await opened;
        await vi.advanceTimersByTimeAsync(STARTED_TIMEOUT_MS);

        expect(await outcome).toBe('unavailable');
        expect(stream.locked).toBe(false);
        // The first thing a late request would read is an error, so it fails at once.
        expect(await messageQueue(ports[0])()).toMatchObject({ type: 'error' });
    });

    it('fails the download when the stream fails part way', async () => {
        const { worker, ports } = createFakeWorker();
        const failing = new ReadableStream<Uint8Array>({
            start: (controller) => {
                controller.enqueue(FIRST);
                controller.error(new Error('Decryption failed at chunk 1'));
            },
        });
        let downloaded: Promise<number[]> = Promise.resolve([]);
        const openUrl = (): void => {
            downloaded = downloadFrom(messageQueue(ports[0]), ports[0]);
        };

        await expect(saveViaServiceWorker(failing, { fileName: 'a.bin' }, { getWorker: async () => worker, openUrl }))
            .rejects.toThrow('Decryption failed at chunk 1');
        await expect(downloaded).rejects.toThrow('Decryption failed at chunk 1');
    });

    it('stops and reports a cancellation when the user cancels the download', async () => {
        const { worker, ports } = createFakeWorker();
        const cancel = vi.fn();
        const endless = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(FIRST), cancel });
        const openUrl = (): void => {
            void downloadFrom(messageQueue(ports[0]), ports[0], 1);
        };

        await expect(saveViaServiceWorker(endless, { fileName: 'a.bin' }, { getWorker: async () => worker, openUrl }))
            .rejects.toBeInstanceOf(DownloadCancelledError);
        expect(cancel).toHaveBeenCalled();
    });
});

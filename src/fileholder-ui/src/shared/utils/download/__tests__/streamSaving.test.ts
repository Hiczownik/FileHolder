import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    describeSaveResult,
    isWebKitUserAgent,
    MAX_IN_MEMORY_BYTES,
    memoryOnlyLimitProblem,
    planSaveMethods,
    removeStaleOpfsFiles,
    saveInMemory,
    saveStreamToDisk,
    unavailable,
    type BrowserCapabilities,
    type SaveMethod,
} from '../streamSaving';
import { saveBlobAsFile } from '../../downloadUtils';

vi.mock('../../downloadUtils', () => ({
    saveBlobAsFile: vi.fn(),
    triggerDirectDownload: vi.fn(),
}));

const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1';
const FIREFOX_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15';
const CHROME_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EDGE_DESKTOP = `${CHROME_DESKTOP} Edg/126.0.0.0`;
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const FIREFOX_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0';

const BYTE_COUNT = 8;
const BYTES = Uint8Array.from({ length: BYTE_COUNT }, (_, i) => i + 1);
// Half the test bytes, so the full stream is over the cap.
const SMALL_CAP = 4;

const streamOf = (...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start: (controller) => {
            chunks.forEach((chunk) => controller.enqueue(chunk));
            controller.close();
        },
    });

/** A source that opens a fresh stream of the given chunks. */
const sourceOf = (...chunks: readonly Uint8Array[]) => async (): Promise<ReadableStream<Uint8Array>> => streamOf(...chunks);

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<number[]> =>
    Array.from(new Uint8Array(await new Blob(await collect(stream.getReader(), []) as BlobPart[]).arrayBuffer()));

const collect = async (reader: ReadableStreamDefaultReader<Uint8Array>, parts: Uint8Array[]): Promise<Uint8Array[]> => {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
    return collect(reader, parts);
};

describe('isWebKitUserAgent', () => {
    it.each([SAFARI_MAC, SAFARI_IOS, CHROME_IOS, FIREFOX_IOS])('treats %s as WebKit', (userAgent) => {
        expect(isWebKitUserAgent(userAgent)).toBe(true);
    });

    it.each([CHROME_DESKTOP, EDGE_DESKTOP, CHROME_ANDROID, FIREFOX_DESKTOP])('does not treat %s as WebKit', (userAgent) => {
        expect(isWebKitUserAgent(userAgent)).toBe(false);
    });
});

describe('planSaveMethods', () => {
    const everything: BrowserCapabilities = { serviceWorker: true, isWebKit: false, fileSystemAccess: true, opfs: true };

    it.each([
        ['Chrome / Edge', everything, ['service-worker', 'file-system-access', 'opfs', 'memory']],
        ['Firefox', { ...everything, fileSystemAccess: false }, ['service-worker', 'opfs', 'memory']],
        ['Firefox private window', { ...everything, serviceWorker: false, fileSystemAccess: false }, ['opfs', 'memory']],
        ['Safari (service worker held back)', { ...everything, isWebKit: true, fileSystemAccess: false }, ['opfs', 'memory']],
        ['a page served over plain http', { serviceWorker: false, isWebKit: false, fileSystemAccess: false, opfs: false }, ['memory']],
    ] as const)('%s', (_, capabilities, expected) => {
        expect(planSaveMethods(capabilities).methods).toEqual(expected);
    });

    it('says why each method was left out', () => {
        const safari = { ...everything, isWebKit: true, fileSystemAccess: false };

        expect(planSaveMethods(safari).skipped).toEqual([
            { method: 'service-worker', reason: 'held back on WebKit' },
            { method: 'file-system-access', reason: 'no showSaveFilePicker' },
        ]);
    });
});

describe('saveStreamToDisk', () => {
    beforeEach(() => {
        vi.mocked(saveBlobAsFile).mockClear();
    });

    it('hands the unopened stream on when a method is unavailable', async () => {
        const received: number[][] = [];
        const methods: SaveMethod[] = [
            { name: 'service-worker', save: async () => unavailable('the download worker did not accept the download') },
            { name: 'opfs', save: async (open) => { received.push(await readAll(await open())); return 'saved'; } },
        ];
        const plan = { methods, skipped: [{ method: 'file-system-access' as const, reason: 'no showSaveFilePicker' }] };

        const result = await saveStreamToDisk(sourceOf(BYTES), { fileName: 'a.bin' }, plan);

        expect(received).toEqual([Array.from(BYTES)]);
        expect(result).toEqual({
            method: 'opfs',
            skipped: [
                { method: 'file-system-access', reason: 'no showSaveFilePicker' },
                { method: 'service-worker', reason: 'the download worker did not accept the download' },
            ],
        });
        expect(describeSaveResult(result)).toBe(
            'via opfs. Skipped: file-system-access (no showSaveFilePicker), service-worker (the download worker did not accept the download)');
    });

    it('opens the stream only once, even when a method opened it and still stepped aside', async () => {
        const source = vi.fn(async () => streamOf(BYTES));
        const methods: SaveMethod[] = [
            { name: 'service-worker', save: async (open) => { await open(); return unavailable('changed its mind'); } },
            { name: 'memory', save: async (open) => { await readAll(await open()); return 'saved'; } },
        ];

        await saveStreamToDisk(source, { fileName: 'a.bin' }, { methods, skipped: [] });

        expect(source).toHaveBeenCalledTimes(1);
    });

    it('does not fall back once a method has failed part way, and cancels the stream', async () => {
        const cancel = vi.fn();
        const source = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(BYTES), cancel });
        const fallback = vi.fn();
        const methods: SaveMethod[] = [
            {
                name: 'service-worker',
                save: async (open) => {
                    const reader = (await open()).getReader();
                    await reader.read();
                    reader.releaseLock();
                    throw new Error('disk full');
                },
            },
            { name: 'memory', save: fallback },
        ];

        await expect(saveStreamToDisk(async () => source, { fileName: 'a.bin' }, { methods, skipped: [] })).rejects.toThrow('disk full');
        expect(fallback).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalled();
    });

    it('fails without opening the stream when no method can save the file', async () => {
        const source = vi.fn(sourceOf(BYTES));

        await expect(saveStreamToDisk(source, { fileName: 'a.bin' }, { methods: [], skipped: [] })).rejects.toThrow('no way to save');
        expect(source).not.toHaveBeenCalled();
    });

    // Issue #25: the service worker was planned, but failed when the download started, leaving only memory.
    it('never opens (and so never counts) a download that turns out to be too large for the only method left', async () => {
        const source = vi.fn(sourceOf(BYTES));
        const methods: SaveMethod[] = [
            { name: 'service-worker', save: async () => unavailable('the download worker could not be registered') },
            { name: 'memory', save: (open, file) => saveInMemory(open, file) },
        ];

        await expect(saveStreamToDisk(source, { fileName: 'big.bin', sizeBytes: MAX_IN_MEMORY_BYTES + 1 }, { methods, skipped: [] }))
            .rejects.toThrow('can only save up to');
        expect(source).not.toHaveBeenCalled();
    });
});

describe('memoryOnlyLimitProblem', () => {
    const memoryOnly = { methods: [{ name: 'memory' as const, save: vi.fn() }], skipped: [] };
    const canStream = { methods: [{ name: 'service-worker' as const, save: vi.fn() }, ...memoryOnly.methods], skipped: [] };

    it('lets anything through when the browser can stream to disk', () => {
        expect(memoryOnlyLimitProblem(MAX_IN_MEMORY_BYTES * BYTE_COUNT, canStream)).toBeNull();
    });

    it('lets content up to the cap through on a memory-only browser', () => {
        expect(memoryOnlyLimitProblem(MAX_IN_MEMORY_BYTES, memoryOnly)).toBeNull();
    });

    it('refuses more than the cap on a memory-only browser, with advice', () => {
        const problem = memoryOnlyLimitProblem(MAX_IN_MEMORY_BYTES + 1, memoryOnly);

        expect(problem).toContain('can only save up to 1 GB');
        expect(problem).toContain('Chrome, Edge or Firefox');
    });
});

describe('saveInMemory', () => {
    beforeEach(() => {
        vi.mocked(saveBlobAsFile).mockClear();
    });

    it('saves everything the stream delivers under the given name', async () => {
        expect(await saveInMemory(sourceOf(BYTES.subarray(0, SMALL_CAP), BYTES.subarray(SMALL_CAP)), { fileName: 'a.bin' })).toBe('saved');

        const [blob, name] = vi.mocked(saveBlobAsFile).mock.calls[0];
        expect(name).toBe('a.bin');
        expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(Array.from(BYTES));
    });

    it('refuses a file declared larger than the cap without opening the stream', async () => {
        const source = vi.fn(sourceOf(BYTES));

        await expect(saveInMemory(source, { fileName: 'a.bin', sizeBytes: SMALL_CAP + 1 }, SMALL_CAP)).rejects.toThrow('can only save up to');
        expect(source).not.toHaveBeenCalled();
    });

    it('stops at the cap even when the declared size was too small', async () => {
        await expect(saveInMemory(sourceOf(BYTES), { fileName: 'a.bin', sizeBytes: 1 }, SMALL_CAP)).rejects.toThrow('can only save up to');
        expect(saveBlobAsFile).not.toHaveBeenCalled();
    });
});

describe('removeStaleOpfsFiles', () => {
    const PREFIX = 'fileholder-download-';
    const NOW = Date.parse('2026-10-21T12:00:00Z');
    const TWO_HOURS_MS = 7_200_000;
    const TWO_DAYS_MS = 172_800_000;
    const TWO_HOURS_AGO = NOW - TWO_HOURS_MS;
    const TWO_DAYS_AGO = NOW - TWO_DAYS_MS;

    const fakeRoot = (names: readonly string[]): { readonly root: FileSystemDirectoryHandle; readonly removed: string[] } => {
        const removed: string[] = [];
        const root = {
            keys: async function* keys(): AsyncGenerator<string> {
                yield* names;
            },
            removeEntry: async (name: string) => {
                removed.push(name);
            },
        } as unknown as FileSystemDirectoryHandle;
        return { root, removed };
    };

    const withLocks = (heldNames: readonly string[] | null): void => {
        const locks = heldNames === null ? undefined : { query: async () => ({ held: heldNames.map((name) => ({ name })) }) };
        Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    };

    afterEach(() => {
        Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    });

    // Issue #42: a download running in another tab for over an hour had its file deleted under it.
    it('keeps files another tab still holds, however old, and removes the ones no tab holds', async () => {
        const running = `${PREFIX}${TWO_DAYS_AGO}-a`;
        const abandoned = `${PREFIX}${TWO_HOURS_AGO}-b`;
        withLocks([running]);
        const { root, removed } = fakeRoot([running, abandoned, 'something-else']);

        await removeStaleOpfsFiles(root, NOW);

        expect(removed).toEqual([abandoned]);
    });

    it('falls back to a day-old cutoff where Web Locks are missing', async () => {
        const recent = `${PREFIX}${TWO_HOURS_AGO}-a`;
        const old = `${PREFIX}${TWO_DAYS_AGO}-b`;
        withLocks(null);
        const { root, removed } = fakeRoot([recent, old]);

        await removeStaleOpfsFiles(root, NOW);

        expect(removed).toEqual([old]);
    });
});

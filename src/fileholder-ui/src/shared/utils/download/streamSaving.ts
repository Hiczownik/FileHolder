import { saveBlobAsFile } from '../downloadUtils';
import { formatSize } from '../formatSize';
import { DownloadCancelledError, saveViaServiceWorker } from './serviceWorkerSaving';
import {
    describeError,
    unavailable,
    type SaveMethodName,
    type SaveOutcome,
    type SaveResult,
    type SkippedMethod,
    type StreamedFile,
} from './saveOutcome';

/**
 * Saves a stream (e.g. a file being decrypted as it downloads) to disk without holding it all in memory.
 * Browsers offer no single way to do that, so the methods are tried in order, the first that works wins:
 *
 *   1. service-worker       an ordinary download served by our worker: Chrome, Edge, Firefox
 *   2. file-system-access   a "Save as" dialog the page writes into: Chrome, Edge
 *   3. opfs                 written to the site's private disk storage, then downloaded: Safari (macOS, iOS)
 *   4. memory               collected in memory first, capped at MAX_IN_MEMORY_BYTES: anything else
 *
 * A method steps aside (with a reason) only if it has not read from the stream, so the next one can still
 * use it. The reasons are reported with the result, to show which browser feature was missing.
 */

export * from './saveOutcome';

export interface SaveMethod {
    readonly name: SaveMethodName;
    readonly save: (stream: ReadableStream<Uint8Array>, file: StreamedFile) => Promise<SaveOutcome>;
}

/** The methods to try, in order, and those left out up front because the browser lacks what they need. */
export interface SavePlan {
    readonly methods: readonly SaveMethod[];
    readonly skipped: readonly SkippedMethod[];
}

export interface BrowserCapabilities {
    readonly serviceWorker: boolean;
    readonly isWebKit: boolean;
    readonly fileSystemAccess: boolean;
    readonly opfs: boolean;
}

/**
 * Safari's handling of downloads served by a service worker has been unreliable. Until it has been checked
 * on real Apple devices, WebKit (Safari, and every browser on iOS) skips that method and uses OPFS.
 */
export const SERVICE_WORKER_SAVING_ON_WEBKIT = false;

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const MAX_IN_MEMORY_MIB = 1024;
export const MAX_IN_MEMORY_BYTES = MAX_IN_MEMORY_MIB * BYTES_PER_MIB;

// Matches WebKit browsers: Safari on macOS ("... AppleWebKit/605.1.15 ... Version/17.4 Safari/605.1.15") and
// every iOS browser, including Chrome ("CriOS") and Firefox ("FxiOS"), which must use WebKit there. Doesn't match
// desktop Chrome or Edge, whose user agents also say "AppleWebKit" but add "Chrome/", "Chromium/" or "Edg/".
// https://regex101.com/?regex=AppleWebKit&flags=&testString=Mozilla%2F5.0%20(Macintosh)%20AppleWebKit%2F605.1.15%20Version%2F17.4%20Safari%2F605.1.15
const WEBKIT_TOKEN = /AppleWebKit/;
// Matches Chromium-based browsers by their "Chrome/", "Chromium/" or "Edg/" token: "... Chrome/126.0 Safari/537.36"
// matches; Safari's "... Version/17.4 Safari/605.1.15" and iOS Chrome's "... CriOS/126.0 ..." don't.
// https://regex101.com/?regex=Chrome%5C%2F%7CChromium%5C%2F%7CEdg%5C%2F&flags=&testString=Mozilla%2F5.0%20AppleWebKit%2F537.36%20Chrome%2F126.0%20Safari%2F537.36%20Edg%2F126.0
const BLINK_TOKEN = /Chrome\/|Chromium\/|Edg\//;

export function isWebKitUserAgent(userAgent: string): boolean {
    return WEBKIT_TOKEN.test(userAgent) && !BLINK_TOKEN.test(userAgent);
}

export function detectCapabilities(): BrowserCapabilities {
    return {
        serviceWorker: window.isSecureContext && 'serviceWorker' in navigator,
        isWebKit: isWebKitUserAgent(navigator.userAgent),
        fileSystemAccess: window.isSecureContext && typeof (window as WindowWithSavePicker).showSaveFilePicker === 'function',
        opfs: window.isSecureContext && typeof navigator.storage?.getDirectory === 'function',
    };
}

/** Which methods to try, in order, given what this browser supports, and why the others are left out. */
export function planSaveMethods(capabilities: BrowserCapabilities): { readonly methods: SaveMethodName[]; readonly skipped: SkippedMethod[] } {
    const heldBackOnWebKit = capabilities.isWebKit && !SERVICE_WORKER_SAVING_ON_WEBKIT;
    const serviceWorkerReasons: readonly (readonly [boolean, string])[] = [
        [!capabilities.serviceWorker, 'no service worker support or not a secure context'],
        [heldBackOnWebKit, 'held back on WebKit'],
    ];
    const serviceWorkerReason = serviceWorkerReasons.find(([applies]) => applies)?.[1] ?? null;
    const candidates: readonly (readonly [SaveMethodName, string | null])[] = [
        ['service-worker', serviceWorkerReason],
        ['file-system-access', capabilities.fileSystemAccess ? null : 'no showSaveFilePicker'],
        ['opfs', capabilities.opfs ? null : 'no navigator.storage.getDirectory or not a secure context'],
        ['memory', null],
    ];
    return {
        methods: candidates.filter(([, reason]) => reason === null).map(([name]) => name),
        skipped: candidates.flatMap(([method, reason]) => (reason === null ? [] : [{ method, reason }])),
    };
}

// ---- file-system-access ----------------------------------------------------------------------------------

interface WindowWithSavePicker {
    readonly showSaveFilePicker?: (options: { readonly suggestedName: string }) => Promise<FileSystemFileHandle>;
}

interface NavigatorWithActivation {
    readonly userActivation?: { readonly isActive: boolean };
}

async function saveViaFileSystemAccess(stream: ReadableStream<Uint8Array>, file: StreamedFile): Promise<SaveOutcome> {
    const picker = (window as WindowWithSavePicker).showSaveFilePicker;
    if (!picker) {
        return unavailable('no showSaveFilePicker');
    }
    // The dialog may only open shortly after a click; by now the download may have taken too long to start.
    if ((navigator as NavigatorWithActivation).userActivation?.isActive === false) {
        return unavailable('the click that started the download is too long ago to open a dialog');
    }

    let handle: FileSystemFileHandle;
    try {
        handle = await picker({ suggestedName: file.fileName });
    } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
            throw new DownloadCancelledError();
        }
        return unavailable(describeError(err));
    }

    // pipeTo aborts the writable if the stream fails, so a failed download never leaves a partial file behind.
    await stream.pipeTo(await handle.createWritable());
    return 'saved';
}

// ---- opfs ------------------------------------------------------------------------------------------------

const OPFS_PREFIX = 'fileholder-download-';
// The browser copies the finished file to Downloads from here; it is deleted once that has surely finished.
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const OPFS_DELETE_AFTER_MINUTES = 5;
// Leftovers from tabs closed before their cleanup ran are removed on the next download.
const OPFS_STALE_AFTER_MINUTES = 60;
// Some headroom for the browser's own bookkeeping when checking the storage quota.
const QUOTA_HEADROOM = 1.1;

// The DOM types declare these, but older Safari versions lack them at runtime, so they are checked before use.
const canWrite = (handle: FileSystemFileHandle): boolean =>
    typeof (handle as Partial<FileSystemFileHandle>).createWritable === 'function';
const canList = (directory: FileSystemDirectoryHandle): boolean =>
    typeof (directory as Partial<FileSystemDirectoryHandle>).keys === 'function';

/** Deleting is best effort: a leftover file is removed on a later download. */
async function removeQuietly(root: FileSystemDirectoryHandle, name: string): Promise<void> {
    try {
        await root.removeEntry(name);
    } catch {
        // Already gone, or still in use; a later cleanup retries.
    }
}

const opfsTimestamp = (name: string): number => Number(name.slice(OPFS_PREFIX.length).split('-')[0]);

const collectNames = async (iterator: AsyncIterator<string>, names: string[]): Promise<string[]> => {
    const { done, value } = await iterator.next();
    return done ? names : collectNames(iterator, [...names, value]);
};

async function removeStaleOpfsFiles(root: FileSystemDirectoryHandle): Promise<void> {
    if (!canList(root)) return;
    const names = await collectNames(root.keys(), []);
    const cutoff = Date.now() - OPFS_STALE_AFTER_MINUTES * MS_PER_MINUTE;
    await Promise.all(names
        .filter((name) => name.startsWith(OPFS_PREFIX) && opfsTimestamp(name) < cutoff)
        .map((name) => removeQuietly(root, name)));
}

async function hasRoomFor(sizeBytes: number | undefined): Promise<boolean> {
    if (sizeBytes === undefined || !navigator.storage?.estimate) return true;
    const { quota, usage } = await navigator.storage.estimate();
    return quota === undefined || usage === undefined || quota - usage >= sizeBytes * QUOTA_HEADROOM;
}

interface PreparedOpfsFile {
    readonly root: FileSystemDirectoryHandle;
    readonly name: string;
    readonly handle: FileSystemFileHandle;
}

/** Everything that can fail before the stream is read; a failure here only makes OPFS unavailable. */
async function prepareOpfsFile(file: StreamedFile): Promise<PreparedOpfsFile | string> {
    try {
        const root = await navigator.storage.getDirectory();
        await removeStaleOpfsFiles(root);
        if (!(await hasRoomFor(file.sizeBytes))) {
            return 'not enough storage quota';
        }

        const name = `${OPFS_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
        const handle = await root.getFileHandle(name, { create: true });
        if (!canWrite(handle)) {
            await removeQuietly(root, name);
            return 'no createWritable';
        }
        return { root, name, handle };
    } catch (err: unknown) {
        return describeError(err);
    }
}

async function saveViaOpfs(stream: ReadableStream<Uint8Array>, file: StreamedFile): Promise<SaveOutcome> {
    const prepared = await prepareOpfsFile(file);
    if (typeof prepared === 'string') {
        return unavailable(prepared);
    }

    const { root, name, handle } = prepared;
    const remove = (): Promise<void> => removeQuietly(root, name);
    try {
        await stream.pipeTo(await handle.createWritable());
        // The File reads from disk as the browser saves it, so it never has to fit in memory.
        saveBlobAsFile(await handle.getFile(), file.fileName);
        setTimeout(() => void remove(), OPFS_DELETE_AFTER_MINUTES * MS_PER_MINUTE);
        return 'saved';
    } catch (err: unknown) {
        await remove();
        throw err;
    }
}

// ---- memory ----------------------------------------------------------------------------------------------

const tooLargeForMemory = (): Error =>
    new Error(`This browser can only save files up to ${formatSize(MAX_IN_MEMORY_BYTES)} this way. Try a recent Chrome, Edge, Firefox or Safari.`);

const collectWithCap = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    parts: Uint8Array[],
    total: number,
    maxBytes: number
): Promise<Uint8Array[]> => {
    const { done, value } = await reader.read();
    if (done) return parts;
    // Checked as bytes arrive too: the declared size comes from the uploader and may be wrong.
    if (total + value.byteLength > maxBytes) {
        await reader.cancel();
        throw tooLargeForMemory();
    }
    parts.push(value);
    return collectWithCap(reader, parts, total + value.byteLength, maxBytes);
};

/** Exported for tests, which pass a small cap. */
export async function saveInMemory(
    stream: ReadableStream<Uint8Array>,
    file: StreamedFile,
    maxBytes: number = MAX_IN_MEMORY_BYTES
): Promise<SaveOutcome> {
    if (file.sizeBytes !== undefined && file.sizeBytes > maxBytes) {
        await stream.cancel();
        throw tooLargeForMemory();
    }
    const parts = await collectWithCap(stream.getReader(), [], 0, maxBytes);
    saveBlobAsFile(new Blob(parts as BlobPart[], { type: 'application/octet-stream' }), file.fileName);
    return 'saved';
}

// ---- choosing --------------------------------------------------------------------------------------------

const METHODS: Readonly<Record<SaveMethodName, SaveMethod['save']>> = {
    'service-worker': saveViaServiceWorker,
    'file-system-access': saveViaFileSystemAccess,
    opfs: saveViaOpfs,
    memory: (stream, file) => saveInMemory(stream, file),
};

export function defaultSavePlan(capabilities: BrowserCapabilities = detectCapabilities()): SavePlan {
    const { methods, skipped } = planSaveMethods(capabilities);
    return { methods: methods.map((name) => ({ name, save: METHODS[name] })), skipped };
}

async function cancelQuietly(stream: ReadableStream<Uint8Array>): Promise<void> {
    try {
        await stream.cancel();
    } catch {
        // A stream that is locked or already errored needs no cancelling.
    }
}

/** Tries each method in order; returns the one that saved the file, and why the earlier ones didn't. */
export async function saveStreamToDisk(
    stream: ReadableStream<Uint8Array>,
    file: StreamedFile,
    plan: SavePlan = defaultSavePlan()
): Promise<SaveResult> {
    const [method, ...rest] = plan.methods;
    if (!method) {
        await stream.cancel();
        throw new Error('This browser has no way to save the file.');
    }

    let outcome: SaveOutcome;
    try {
        outcome = await method.save(stream, file);
    } catch (err: unknown) {
        // The method may have read part of the stream, so no other method can take over.
        await cancelQuietly(stream);
        throw err;
    }

    if (outcome === 'saved') {
        return { method: method.name, skipped: plan.skipped };
    }
    return saveStreamToDisk(stream, file, { methods: rest, skipped: [...plan.skipped, { method: method.name, reason: outcome.unavailable }] });
}

export { DownloadCancelledError };

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
    type StreamSource,
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
 * A method only opens the stream once it is ready to write it, and steps aside (with a reason) only if it has
 * not read from it, so the next one can still use it. A download that no method can save is never opened, so
 * it never uses up one of the bundle's downloads. The reasons are reported with the result, to show which
 * browser feature was missing.
 */

export * from './saveOutcome';

export interface SaveMethod {
    readonly name: SaveMethodName;
    readonly save: (open: StreamSource, file: StreamedFile) => Promise<SaveOutcome>;
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

interface RemovableHandle {
    readonly remove?: () => Promise<void>;
}

async function saveViaFileSystemAccess(open: StreamSource, file: StreamedFile): Promise<SaveOutcome> {
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

    // Opened only now, so the dialog appeared straight after the click, before any network round trip.
    const stream = await open().catch(async (err: unknown) => {
        // Some browsers create the picked file at once; don't leave it behind empty. Best effort.
        await (handle as RemovableHandle).remove?.().catch(() => undefined);
        throw err;
    });
    // pipeTo aborts the writable if the stream fails, so a failed download never leaves a partial file behind.
    await stream.pipeTo(await handle.createWritable());
    return 'saved';
}

// ---- opfs ------------------------------------------------------------------------------------------------

const OPFS_PREFIX = 'fileholder-download-';
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
// The browser copies the finished file to Downloads (or, on iOS, to Files) from here, and nothing reports when
// that is done. A few GB to Files on a phone can take many minutes, so the file is kept for an hour after.
const OPFS_DELETE_AFTER_MINUTES = 60;
// Only used where Web Locks are missing, so a file can't be told to be in use: leftovers older than a day go.
const OPFS_STALE_WITHOUT_LOCKS_HOURS = 24;
// Some headroom for the browser's own bookkeeping when checking the storage quota.
const QUOTA_HEADROOM = 1.1;

// The DOM types declare these, but older Safari versions lack them at runtime, so they are checked before use.
const canWrite = (handle: FileSystemFileHandle): boolean =>
    typeof (handle as Partial<FileSystemFileHandle>).createWritable === 'function';
const canList = (directory: FileSystemDirectoryHandle): boolean =>
    typeof (directory as Partial<FileSystemDirectoryHandle>).keys === 'function';
const locksOf = (): LockManager | undefined => (navigator as Partial<Navigator>).locks;

/** Deleting is best effort: a leftover file is removed on a later download. */
async function removeQuietly(root: FileSystemDirectoryHandle, name: string): Promise<void> {
    try {
        await root.removeEntry(name);
    } catch {
        // Already gone, or still in use; a later cleanup retries.
    }
}

const opfsTimestamp = (name: string): number => Number(name.slice(OPFS_PREFIX.length).split('-')[0]);

/**
 * Each OPFS file is marked in use by a Web Lock of the same name, held from before the file exists until it is
 * deleted. Locks are shared by every tab of the site and released when a tab closes, so the cleanup can tell
 * a file another tab is still writing or handing over from one a closed tab left behind.
 */
const holdLock = (name: string): Promise<() => void> =>
    new Promise((acquired) => {
        const locks = locksOf();
        if (!locks) {
            acquired(() => undefined);
            return;
        }
        void locks.request(name, () => new Promise<void>((release) => acquired(release)));
    });

const heldLockNames = async (): Promise<ReadonlySet<string> | null> => {
    const locks = locksOf();
    if (!locks) return null;
    const { held = [] } = await locks.query();
    return new Set(held.map((lock) => lock.name ?? ''));
};

const collectNames = async (iterator: AsyncIterator<string>, names: string[]): Promise<string[]> => {
    const { done, value } = await iterator.next();
    return done ? names : collectNames(iterator, [...names, value]);
};

/** Removes files no tab is using any more. Exported for tests. */
export async function removeStaleOpfsFiles(root: FileSystemDirectoryHandle, now: number = Date.now()): Promise<void> {
    if (!canList(root)) return;
    const names = (await collectNames(root.keys(), [])).filter((name) => name.startsWith(OPFS_PREFIX));
    const held = await heldLockNames();
    const cutoff = now - OPFS_STALE_WITHOUT_LOCKS_HOURS * MINUTES_PER_HOUR * MS_PER_MINUTE;
    const isStale = (name: string): boolean => (held ? !held.has(name) : opfsTimestamp(name) < cutoff);
    await Promise.all(names.filter(isStale).map((name) => removeQuietly(root, name)));
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
    /** Deletes the file and lets go of its lock. */
    readonly discard: () => Promise<void>;
}

/** Everything that can fail before the stream is opened; a failure here only makes OPFS unavailable. */
async function prepareOpfsFile(file: StreamedFile): Promise<PreparedOpfsFile | string> {
    // Locked before the file exists, so no cleanup can ever find it unlocked while this tab uses it.
    const name = `${OPFS_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
    const releaseLock = await holdLock(name);
    try {
        const root = await navigator.storage.getDirectory();
        const discard = async (): Promise<void> => {
            await removeQuietly(root, name);
            releaseLock();
        };
        await removeStaleOpfsFiles(root);
        if (!(await hasRoomFor(file.sizeBytes))) {
            releaseLock();
            return 'not enough storage quota';
        }

        const handle = await root.getFileHandle(name, { create: true });
        if (!canWrite(handle)) {
            await discard();
            return 'no createWritable';
        }
        return { root, name, handle, discard };
    } catch (err: unknown) {
        releaseLock();
        return describeError(err);
    }
}

async function saveViaOpfs(open: StreamSource, file: StreamedFile): Promise<SaveOutcome> {
    const prepared = await prepareOpfsFile(file);
    if (typeof prepared === 'string') {
        return unavailable(prepared);
    }

    const { handle, discard } = prepared;
    try {
        await (await open()).pipeTo(await handle.createWritable());
        // The File reads from disk as the browser saves it, so it never has to fit in memory.
        saveBlobAsFile(await handle.getFile(), file.fileName);
        setTimeout(() => void discard(), OPFS_DELETE_AFTER_MINUTES * MS_PER_MINUTE);
        return 'saved';
    } catch (err: unknown) {
        await discard();
        throw err;
    }
}

// ---- memory ----------------------------------------------------------------------------------------------

const OPEN_ELSEWHERE_ADVICE = 'Open the link in Chrome, Edge or Firefox on a computer to download it.';

const tooLargeForMemory = (): Error =>
    new Error(`This browser can only save up to ${formatSize(MAX_IN_MEMORY_BYTES)} from an encrypted bundle. ${OPEN_ELSEWHERE_ADVICE}`);

/**
 * Checked before a download starts (and is counted against the bundle's download limit): if this browser could
 * only save in memory, content over the memory cap would fail part way, so it is refused up front with advice
 * instead. The size comes from the bundle's manifest, which the uploader wrote, so the cap is still enforced as
 * bytes arrive. Returns the message to show, or null when the download can go ahead.
 */
export function memoryOnlyLimitProblem(sizeBytes: number, plan: SavePlan = defaultSavePlan()): string | null {
    const canStreamToDisk = plan.methods.some((method) => method.name !== 'memory');
    if (canStreamToDisk || sizeBytes <= MAX_IN_MEMORY_BYTES) {
        return null;
    }
    return `This is ${formatSize(sizeBytes)}, but this browser can only save up to ${formatSize(MAX_IN_MEMORY_BYTES)} from an encrypted bundle. ${OPEN_ELSEWHERE_ADVICE}`;
}

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
    open: StreamSource,
    file: StreamedFile,
    maxBytes: number = MAX_IN_MEMORY_BYTES
): Promise<SaveOutcome> {
    // Refused before the stream is opened, so content that can't fit never uses up a download.
    if (file.sizeBytes !== undefined && file.sizeBytes > maxBytes) {
        throw tooLargeForMemory();
    }
    const parts = await collectWithCap((await open()).getReader(), [], 0, maxBytes);
    saveBlobAsFile(new Blob(parts as BlobPart[], { type: 'application/octet-stream' }), file.fileName);
    return 'saved';
}

// ---- choosing --------------------------------------------------------------------------------------------

const METHODS: Readonly<Record<SaveMethodName, SaveMethod['save']>> = {
    'service-worker': saveViaServiceWorker,
    'file-system-access': saveViaFileSystemAccess,
    opfs: saveViaOpfs,
    memory: (open, file) => saveInMemory(open, file),
};

export function defaultSavePlan(capabilities: BrowserCapabilities = detectCapabilities()): SavePlan {
    const { methods, skipped } = planSaveMethods(capabilities);
    return { methods: methods.map((name) => ({ name, save: METHODS[name] })), skipped };
}

async function cancelQuietly(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    try {
        await stream?.cancel();
    } catch {
        // A stream that is locked or already errored needs no cancelling.
    }
}

interface OpenOnce {
    readonly open: StreamSource;
    readonly cancelIfOpened: () => Promise<void>;
}

/** Opens the source at most once, so a method that opened it and stepped aside hands the same, unread stream on. */
const openOnce = (source: StreamSource): OpenOnce => {
    let opened: Promise<ReadableStream<Uint8Array>> | null = null;
    return {
        open: () => {
            opened ??= source();
            return opened;
        },
        cancelIfOpened: async () => {
            if (opened) await cancelQuietly(await opened.catch(() => null));
        },
    };
};

async function tryMethods(source: OpenOnce, file: StreamedFile, plan: SavePlan): Promise<SaveResult> {
    const [method, ...rest] = plan.methods;
    if (!method) {
        await source.cancelIfOpened();
        throw new Error('This browser has no way to save the file.');
    }

    const outcome = await method.save(source.open, file).catch(async (err: unknown) => {
        // The method may have read part of the stream, so no other method can take over.
        await source.cancelIfOpened();
        throw err;
    });

    if (outcome === 'saved') {
        return { method: method.name, skipped: plan.skipped };
    }
    return tryMethods(source, file, { methods: rest, skipped: [...plan.skipped, { method: method.name, reason: outcome.unavailable }] });
}

/**
 * Tries each method in order; returns the one that saved the file, and why the earlier ones didn't. The stream is
 * only opened by the method that saves it, so when none can, the download is never started.
 */
export function saveStreamToDisk(source: StreamSource, file: StreamedFile, plan: SavePlan = defaultSavePlan()): Promise<SaveResult> {
    return tryMethods(openOnce(source), file, plan);
}

export { DownloadCancelledError };

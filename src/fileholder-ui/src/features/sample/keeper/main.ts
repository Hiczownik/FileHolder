// The sample keeper (#82; docs/operations.md, Sample Bundle): a small Node service next to the API that keeps one public, encrypted
// sample bundle alive and points /sample at it. It uploads with the browser's own code (uploadWorkflow.ts), so the
// sample is encrypted exactly as a visitor's bundle would be. Built by `npm run build:sample`, run by the Dockerfile's
// `sample` target. Settings come from the environment (docker-compose.prod.yml).
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios, { isAxiosError } from 'axios';
import { executeEncryptedUploadWorkflow } from '../../upload/services/uploadWorkflow';
import { downloadApi } from '../../download/api/downloadApi';
import { parseSamplePointer, shareTokenOf, type SamplePointer } from '../samplePointer';
import { buildSamplePdf } from './samplePdf';
import { keepSampleFresh, type KeeperSettings, type SampleStatus, type SampleStore } from './keeper';

const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const MS_PER_MINUTE = 60_000;
const MAX_DOWNLOADS = 100;
const DEFAULT_LIFETIME_HOURS = 24;
const DEFAULT_RENEW_AFTER_HOURS = 12;
const DEFAULT_MIN_REMAINING_DOWNLOADS = 20;
const DEFAULT_CHECK_MINUTES = 60;
const POINTER_FILE = 'current.json';
// An idle keeper wakes this rarely; the timer only keeps the process alive.
const IDLE_WAKE_MS = 24 * 60 * MS_PER_MINUTE;
const PHOTO_FILE = 'photo.jpg';
// Readable by nginx, which runs as another user.
const POINTER_FILE_MODE = 0o644;

function setting(name: string, fallback?: string): string {
    const value = process.env[name]?.trim() || fallback;
    if (value === undefined) throw new Error(`${name} is not set.`);
    return value;
}

function positiveSetting(name: string, fallback: number): number {
    const value = Number(setting(name, String(fallback)));
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
    return value;
}

const log = (message: string): void => console.log(`${new Date().toISOString()} sample: ${message}`);

/** What the upload code expects of a browser: WebCrypto, base64 and the page's address (for the share link). */
function actLikeABrowserAt(publicUrl: string): void {
    const browserGlobals = { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob, location: new URL(publicUrl) };
    Object.defineProperty(globalThis, 'window', { value: browserGlobals, configurable: true });
}

/**
 * Storage is reached at its public address in production, as browsers reach it. On this machine's production stack
 * (scripts/prod-local.ps1) that address is the host's localhost, so STORAGE_INTERNAL_URL sends the requests to the
 * storage container instead, still naming the public host: upload links are signed for it.
 */
function reachStorageThrough(publicUrl: string | undefined, internalUrl: string | undefined): void {
    if (!publicUrl || !internalUrl) return;
    const publicHost = new URL(publicUrl).host;
    axios.interceptors.request.use((config) => {
        if (!config.url?.startsWith(publicUrl)) return config;
        const headers = config.headers.concat({ Host: publicHost });
        return { ...config, url: `${internalUrl}${config.url.slice(publicUrl.length)}`, headers };
    });
}

function createStore(dataDir: string, contentDir: string, origin: string, accessCode: string, settings: KeeperSettings): SampleStore {
    const pointerPath = join(dataDir, POINTER_FILE);
    return {
        async readPointer(): Promise<SamplePointer | undefined> {
            try {
                return parseSamplePointer(JSON.parse(await readFile(pointerPath, 'utf8')), origin);
            } catch {
                return undefined;
            }
        },

        async writePointer(pointer: SamplePointer): Promise<void> {
            // Written beside it and renamed over it, so nginx never serves half a file.
            const temporary = `${pointerPath}.tmp`;
            await writeFile(temporary, JSON.stringify(pointer), { mode: POINTER_FILE_MODE });
            await rename(temporary, pointerPath);
        },

        async statusOf(pointer: SamplePointer): Promise<SampleStatus> {
            try {
                const metadata = await downloadApi.getGroupMetadata(shareTokenOf(pointer));
                return { isExpired: metadata.isExpired, remainingDownloads: metadata.remainingDownloads ?? null };
            } catch (err: unknown) {
                const status = isAxiosError(err) ? err.response?.status : undefined;
                if (status === HTTP_NOT_FOUND || status === HTTP_GONE) return 'gone';
                throw err;
            }
        },

        async upload(madeAt: Date): Promise<string> {
            const files = [new File([buildSamplePdf(origin, madeAt) as BlobPart], 'About-FileHolder.pdf', { type: 'application/pdf' })];
            try {
                const photo = await readFile(join(contentDir, PHOTO_FILE));
                files.push(new File([photo], 'Photo.jpg', { type: 'image/jpeg' }));
            } catch {
                log(`no ${PHOTO_FILE} in ${contentDir}; the sample has the PDF only`);
            }
            return executeEncryptedUploadWorkflow(
                { title: 'FileHolder sample', expireInHours: settings.lifetimeHours, maxDownloads: MAX_DOWNLOADS, isEncrypted: true },
                files,
                () => undefined,
                undefined,
                { accessCode },
            );
        },
    };
}

async function main(): Promise<void> {
    // The container stops on SIGTERM; Node as PID 1 would otherwise ignore it until Docker kills it.
    process.on('SIGTERM', () => process.exit(0));

    const accessCode = process.env.SAMPLE_ACCESS_CODE?.trim();
    if (!accessCode) {
        // Not an error: a deployment without a sample, and /sample says there's none. Stays running, idle, since
        // deploy.ps1 waits for every service to be up and would take an exit for a failed deploy.
        log('SAMPLE_ACCESS_CODE is not set, so there is no sample bundle. Create a code (scripts/admin.ps1 code-create s01 -NoExpiry) and set it.');
        setInterval(() => undefined, IDLE_WAKE_MS);
        return;
    }
    const origin = new URL(setting('PUBLIC_URL')).origin;
    const settings: KeeperSettings = {
        lifetimeHours: positiveSetting('SAMPLE_LIFETIME_HOURS', DEFAULT_LIFETIME_HOURS),
        renewAfterHours: positiveSetting('SAMPLE_RENEW_AFTER_HOURS', DEFAULT_RENEW_AFTER_HOURS),
        minRemainingDownloads: positiveSetting('SAMPLE_MIN_REMAINING_DOWNLOADS', DEFAULT_MIN_REMAINING_DOWNLOADS),
    };
    const checkEveryMs = positiveSetting('SAMPLE_CHECK_MINUTES', DEFAULT_CHECK_MINUTES) * MS_PER_MINUTE;

    actLikeABrowserAt(origin);
    reachStorageThrough(process.env.STORAGE_PUBLIC_URL?.trim(), process.env.STORAGE_INTERNAL_URL?.trim());
    const store = createStore(setting('SAMPLE_DATA_DIR', '/data'), setting('SAMPLE_CONTENT_DIR', '/app/content'), origin, accessCode, settings);

    const round = async (): Promise<void> => {
        try {
            const reason = await keepSampleFresh(store, settings, new Date());
            if (reason) log(`made a new sample (${reason})`);
        } catch (err: unknown) {
            // Kept running: the current sample, if any, still works, and the next round tries again. Only the
            // message: a request's details could include an upload link.
            log(`couldn't check or renew the sample: ${err instanceof Error ? err.message : String(err)}`);
        }
        setTimeout(() => void round(), checkEveryMs);
    };
    log(`started: renewing every ${settings.renewAfterHours} h, checking every ${checkEveryMs / MS_PER_MINUTE} min`);
    await round();
}

main().catch((err: unknown) => {
    log(`stopped: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});

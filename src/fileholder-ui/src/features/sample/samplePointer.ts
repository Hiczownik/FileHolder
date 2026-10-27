/**
 * The current sample bundle (#82): written by the sample keeper (sample/keeper.ts) into a volume nginx serves at
 * SAMPLE_POINTER_PATH, read by /sample to forward a visitor there. The link holds the bundle's key: the sample is public
 * by design, so this is the one bundle whose key the server has (docs/operations.md, Sample Bundle).
 */
export interface SamplePointer {
    /** The share link, `{origin}/f/{shareToken}#k={linkKey}`. */
    readonly link: string;
    /** When the bundle was uploaded, ISO 8601. */
    readonly createdAt: string;
    /** When it expires, ISO 8601. */
    readonly expiresAt: string;
}

/** Where nginx serves the pointer: the keeper's volume is mounted at /usr/share/nginx/html/sample-bundle. */
export const SAMPLE_POINTER_PATH = '/sample-bundle/current.json';

const SHARE_PATH_PREFIX = '/f/';

const isIsoDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/**
 * `value` as a pointer, or undefined when it isn't one. Its link must be a share link on `origin`, so a tampered or
 * stale file can't send visitors anywhere else.
 */
export function parseSamplePointer(value: unknown, origin: string): SamplePointer | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const pointer = value as Record<string, unknown>;
    if (typeof pointer.link !== 'string' || !isIsoDate(pointer.createdAt) || !isIsoDate(pointer.expiresAt)) return undefined;
    let url: URL;
    try {
        url = new URL(pointer.link);
    } catch {
        return undefined;
    }
    const shareToken = url.pathname.slice(SHARE_PATH_PREFIX.length);
    const valid = url.origin === origin && url.pathname.startsWith(SHARE_PATH_PREFIX) && shareToken.length > 0
        && !shareToken.includes('/') && url.search === '' && url.hash.length > 1;
    return valid ? { link: pointer.link, createdAt: pointer.createdAt, expiresAt: pointer.expiresAt } : undefined;
}

/** The share token in a pointer's link. */
export function shareTokenOf(pointer: SamplePointer): string {
    return new URL(pointer.link).pathname.slice(SHARE_PATH_PREFIX.length);
}

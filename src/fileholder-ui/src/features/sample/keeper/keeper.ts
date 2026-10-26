import type { SamplePointer } from '../samplePointer';

const MS_PER_HOUR = 3_600_000;

/** What the server says about the current sample, or 'gone' once it answers 404 or 410. */
export type SampleStatus =
    | { readonly isExpired: boolean; readonly remainingDownloads: number | null }
    | 'gone';

export interface KeeperSettings {
    /** How long each sample lives (at most what the access code allows). */
    readonly lifetimeHours: number;
    /** Renewed once it's this old, so a fresh one exists while the old one still works for whoever opened it. */
    readonly renewAfterHours: number;
    /** Renewed early when no more than this many downloads are left (someone may use them up on purpose). */
    readonly minRemainingDownloads: number;
}

/** What the keeper does to the outside world, apart from deciding: kept apart so the decisions can be tested. */
export interface SampleStore {
    readPointer(): Promise<SamplePointer | undefined>;
    writePointer(pointer: SamplePointer): Promise<void>;
    statusOf(pointer: SamplePointer): Promise<SampleStatus>;
    /** Uploads a new sample and returns its share link. */
    upload(madeAt: Date): Promise<string>;
}

export type RenewalReason = 'no sample yet' | 'gone' | 'expired' | 'due' | 'few downloads left';

/** Why the current sample needs replacing, or undefined while it's fine. */
export function renewalReason(pointer: SamplePointer, status: SampleStatus, now: Date, settings: KeeperSettings): RenewalReason | undefined {
    if (status === 'gone') return 'gone';
    if (status.isExpired) return 'expired';
    if (now.getTime() - Date.parse(pointer.createdAt) >= settings.renewAfterHours * MS_PER_HOUR) return 'due';
    if (status.remainingDownloads !== null && status.remainingDownloads <= settings.minRemainingDownloads) return 'few downloads left';
    return undefined;
}

/**
 * One round of the keeper: replaces the sample when it needs it, and says why, or does nothing. The pointer is only
 * rewritten once the new sample is uploaded, so /sample never points at a half-made one.
 */
export async function keepSampleFresh(store: SampleStore, settings: KeeperSettings, now: Date): Promise<RenewalReason | undefined> {
    const pointer = await store.readPointer();
    const reason = pointer ? renewalReason(pointer, await store.statusOf(pointer), now, settings) : 'no sample yet';
    if (reason === undefined) return undefined;

    const link = await store.upload(now);
    await store.writePointer({
        link,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + settings.lifetimeHours * MS_PER_HOUR).toISOString(),
    });
    return reason;
}

import { uploadApi } from '../api/uploadApi';
import { STANDARD_MAX_TOTAL_BYTES } from '../types';

/** What an upload may be on this deployment, as GET /api/v1/files/limits reports it (UploadLimits on the server). */
export interface UploadLimits {
    readonly maxBundleSizeBytes: number;
    readonly maxFilesPerBundle: number;
    readonly minExpiryHours: number;
    readonly maxExpiryHours: number;
}

const HOURS_PER_DAY = 24;
const HALF_DAY_HOURS = 12;
const THREE_DAYS_HOURS = 72;
const WEEK_HOURS = 168;
const DEFAULT_MAX_FILES_PER_BUNDLE = 50;

/**
 * The server's defaults: used until its answer arrives, and if it never does. The server enforces its real limits
 * either way, so a stale value only means a refusal comes from the server instead of from here.
 */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
    maxBundleSizeBytes: STANDARD_MAX_TOTAL_BYTES,
    maxFilesPerBundle: DEFAULT_MAX_FILES_PER_BUNDLE,
    minExpiryHours: 1,
    maxExpiryHours: WEEK_HOURS,
};

const EXPIRY_CHOICES_HOURS: readonly number[] = [1, HALF_DAY_HOURS, HOURS_PER_DAY, THREE_DAYS_HOURS, WEEK_HOURS];
const DEFAULT_EXPIRE_IN_HOURS = HOURS_PER_DAY;

const isPositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function isUploadLimits(value: unknown): value is UploadLimits {
    if (typeof value !== 'object' || value === null) return false;
    const limits = value as Record<string, unknown>;
    return isPositiveInteger(limits.maxBundleSizeBytes)
        && isPositiveInteger(limits.maxFilesPerBundle)
        && isPositiveInteger(limits.minExpiryHours)
        && isPositiveInteger(limits.maxExpiryHours)
        && limits.minExpiryHours <= limits.maxExpiryHours;
}

async function askServer(): Promise<UploadLimits> {
    try {
        const limits = await uploadApi.getLimits();
        if (isUploadLimits(limits)) return limits;
    } catch {
        // Falls through to the defaults below; the server still enforces its own limits.
    }
    request = null;
    return DEFAULT_UPLOAD_LIMITS;
}

let request: Promise<UploadLimits> | null = null;

/**
 * The deployment's limits, asked for once per page load and shared by everything that needs them. Falls back to
 * DEFAULT_UPLOAD_LIMITS when the server can't be asked or answers something else, and asks again next time.
 */
export function loadUploadLimits(): Promise<UploadLimits> {
    request ??= askServer();
    return request;
}

/** For tests: forget the limits asked for, so the next call asks again. */
export function forgetUploadLimits(): void {
    request = null;
}

/** The expiry choices the form offers: the usual ones within the limits, plus the maximum itself if it isn't one. */
export function expiryChoices(limits: UploadLimits): number[] {
    const choices = EXPIRY_CHOICES_HOURS.filter((hours) => hours >= limits.minExpiryHours && hours <= limits.maxExpiryHours);
    if (!choices.includes(limits.maxExpiryHours)) choices.push(limits.maxExpiryHours);
    return choices;
}

/** The expiry the form starts at: 24 hours, or the maximum when that's shorter. */
export function defaultExpiry(limits: UploadLimits): number {
    return Math.min(DEFAULT_EXPIRE_IN_HOURS, limits.maxExpiryHours);
}

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`;

/** "1 hour", "12 hours", "24 hours", "3 days", "36 hours": days only when they're whole and more than one. */
export function describeHours(hours: number): string {
    return hours > HOURS_PER_DAY && hours % HOURS_PER_DAY === 0 ? plural(hours / HOURS_PER_DAY, 'day') : plural(hours, 'hour');
}

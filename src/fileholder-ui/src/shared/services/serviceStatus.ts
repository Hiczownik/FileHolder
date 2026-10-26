import axios from 'axios';
import { formatShortDateTime } from '../utils/timeLeft';

/** How much of FileHolder is open, as GET /api/v1/status reports it (ServiceMode on the server). */
export type ServiceMode = 'Normal' | 'UploadsPaused' | 'ReadOnly' | 'Closed';

export interface ServiceStatus {
    readonly mode: ServiceMode;
    /** The owner's words for visitors, if they gave any. */
    readonly message: string | null;
    /** When the owner expects to switch back. Informational: nothing switches back by itself. */
    readonly until: Date | null;
}

export const NORMAL_STATUS: ServiceStatus = { mode: 'Normal', message: null, until: null };

const MODES: readonly ServiceMode[] = ['Normal', 'UploadsPaused', 'ReadOnly', 'Closed'];

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api/v1/files';
// The status lives next to the files API. Matches a trailing "/files" or "/files/": "/api/v1/files" becomes "/api/v1",
// while "/api/v1/filesystem" doesn't match.
// https://regex101.com/?regex=%5C%2Ffiles%5C%2F%3F%24&testString=%2Fapi%2Fv1%2Ffiles%0A%2Fapi%2Fv1%2Ffilesystem
const FILES_SUFFIX = /\/files\/?$/;
export const STATUS_URL = `${API_BASE_URL.replace(FILES_SUFFIX, '')}/status`;

/** Checks the server's answer; anything unexpected reads as Normal, since the server enforces the mode itself. */
export function parseServiceStatus(value: unknown): ServiceStatus {
    if (typeof value !== 'object' || value === null) return NORMAL_STATUS;
    const raw = value as Record<string, unknown>;
    if (!MODES.includes(raw.mode as ServiceMode)) return NORMAL_STATUS;

    const until = typeof raw.until === 'string' ? new Date(raw.until) : null;
    return {
        mode: raw.mode as ServiceMode,
        message: typeof raw.message === 'string' && raw.message.trim() !== '' ? raw.message : null,
        until: until && !Number.isNaN(until.getTime()) ? until : null,
    };
}

async function askServer(): Promise<ServiceStatus> {
    try {
        const response = await axios.get<unknown>(STATUS_URL);
        return parseServiceStatus(response.data);
    } catch {
        // Not knowing the mode mustn't hide the app: the server still refuses what the mode doesn't allow.
        return NORMAL_STATUS;
    }
}

let current: ServiceStatus | null = null;
let request: Promise<ServiceStatus> | null = null;
const listeners = new Set<(status: ServiceStatus) => void>();

async function askAndShare(): Promise<ServiceStatus> {
    const status = await askServer();
    current = status;
    listeners.forEach((listener) => listener(status));
    return status;
}

function fetchStatus(): Promise<ServiceStatus> {
    request = askAndShare();
    return request;
}

/** The mode, asked for once per page load and shared by everything that shows it. */
export function loadServiceStatus(): Promise<ServiceStatus> {
    return request ?? fetchStatus();
}

/** Asks again, e.g. after the server refused an upload: the mode may have changed since the page loaded. */
export function refreshServiceStatus(): Promise<ServiceStatus> {
    return fetchStatus();
}

/** The last answer, or null before the first. */
export function currentServiceStatus(): ServiceStatus | null {
    return current;
}

export function subscribeToServiceStatus(listener: (status: ServiceStatus) => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** For tests: forget the status asked for, so the next call asks again. */
export function forgetServiceStatus(): void {
    current = null;
    request = null;
    listeners.clear();
}

/** "Expected back Oct 27, 14:00", in the viewer's time zone, while that's still ahead. */
export function describeUntil(until: Date | null, now: Date = new Date()): string | null {
    return until && until > now ? `Expected back ${formatShortDateTime(until)}.` : null;
}

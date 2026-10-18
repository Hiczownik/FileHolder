import type { DownloadSessionResponse } from "../types";

const STORAGE_KEY_PREFIX = 'dlsession_';

export interface StoredDownloadSession {
    readonly id: string;
    readonly expiresAt: string;
}

const storageKey = (shareToken: string): string => `${STORAGE_KEY_PREFIX}${shareToken}`;

// In-memory copy so the session survives even where sessionStorage is unavailable (private browsing).
const memorySessions = new Map<string, StoredDownloadSession>();

const isExpired = (session: StoredDownloadSession, now: Date): boolean =>
    new Date(session.expiresAt).getTime() <= now.getTime();

/**
 * Remembers the open download session per share token, so fetching more files or refreshing
 * the page reuses it instead of consuming another of the bundle's downloads.
 */
export const downloadSessionStore = {
    get(shareToken: string, now: Date = new Date()): StoredDownloadSession | null {
        let session = memorySessions.get(shareToken) ?? null;

        if (!session) {
            try {
                const raw = sessionStorage.getItem(storageKey(shareToken));
                session = raw ? (JSON.parse(raw) as StoredDownloadSession) : null;
            } catch {
                session = null;
            }
        }

        if (!session || isExpired(session, now)) {
            downloadSessionStore.clear(shareToken);
            return null;
        }

        return session;
    },

    save(shareToken: string, response: DownloadSessionResponse): StoredDownloadSession {
        const session: StoredDownloadSession = { id: response.downloadSessionId, expiresAt: response.expiresAt };
        memorySessions.set(shareToken, session);
        try {
            sessionStorage.setItem(storageKey(shareToken), JSON.stringify(session));
        } catch {
            // Ignore storage quota or disabled storage in private browsing
        }
        return session;
    },

    clear(shareToken: string): void {
        memorySessions.delete(shareToken);
        try {
            sessionStorage.removeItem(storageKey(shareToken));
        } catch {
            // Ignore
        }
    },
};

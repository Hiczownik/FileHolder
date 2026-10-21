const STORAGE_KEY_PREFIX = 'linkkey_';

const storageKey = (shareToken: string): string => `${STORAGE_KEY_PREFIX}${shareToken}`;

// In-memory copy so the key survives even where sessionStorage is unavailable (private browsing).
const memoryKeys = new Map<string, string>();

/**
 * Remembers each bundle's link key for this tab. The key is removed from the address bar once read, so without
 * this a reload would lose it. sessionStorage is per tab and cleared when the tab closes.
 */
export const linkKeyStore = {
    get(shareToken: string): string | null {
        const cached = memoryKeys.get(shareToken);
        if (cached !== undefined) return cached;

        try {
            const stored = sessionStorage.getItem(storageKey(shareToken));
            if (stored !== null) memoryKeys.set(shareToken, stored);
            return stored;
        } catch {
            return null;
        }
    },

    save(shareToken: string, linkKey: string): void {
        memoryKeys.set(shareToken, linkKey);
        try {
            sessionStorage.setItem(storageKey(shareToken), linkKey);
        } catch {
            // Ignore storage quota or disabled storage in private browsing
        }
    },

    clear(shareToken: string): void {
        memoryKeys.delete(shareToken);
        try {
            sessionStorage.removeItem(storageKey(shareToken));
        } catch {
            // Ignore
        }
    },
};

import { isAxiosError } from 'axios';
import { uploadApi } from '../api/uploadApi';
import { isUploadLimits, type UploadLimits } from './uploadLimits';

const STORAGE_KEY = 'access_code';
const HTTP_BAD_REQUEST = 400;
const CODE_PARAM = 'code';
const DEFAULT_REFUSAL = "This access code isn't valid or has expired. You can still upload with the smaller limits.";

/** What checking an access code found (#169). */
export type AccessCodeCheck =
    | { readonly status: 'valid'; readonly limits: UploadLimits }
    | { readonly status: 'invalid'; readonly message: string }
    // The server couldn't be asked, or doesn't use codes: try again, or upload with the usual limits.
    | { readonly status: 'unavailable' };

// In-memory copy, as for link keys, so the code survives where sessionStorage is unavailable (private browsing).
let memoryCode: string | null | undefined;

/**
 * Keeps the access code for this tab: it's removed from the address bar once read, so without this a reload would
 * lose it. sessionStorage is per tab and cleared when the tab closes.
 */
export const accessCodeStore = {
    get(): string | null {
        if (memoryCode !== undefined) return memoryCode;
        try {
            memoryCode = sessionStorage.getItem(STORAGE_KEY);
        } catch {
            memoryCode = null;
        }
        return memoryCode;
    },

    save(code: string): void {
        memoryCode = code;
        try {
            sessionStorage.setItem(STORAGE_KEY, code);
        } catch {
            // Disabled storage (private browsing): the in-memory copy still works until a reload.
        }
    },

    clear(): void {
        memoryCode = null;
        try {
            sessionStorage.removeItem(STORAGE_KEY);
        } catch {
            // As above.
        }
    },

    /** For tests: forget the in-memory copy, so the next read goes to sessionStorage. */
    forget(): void {
        memoryCode = undefined;
    },
};

/**
 * The code in a personal link (`/?code=a03-…`), removed from the address bar so it isn't left in the visible URL, a
 * bookmark or a screenshot. Other query parameters, the fragment and the router's history state are kept.
 */
export function takeAccessCodeFromAddressBar(): string | undefined {
    const url = new URL(window.location.href);
    const code = url.searchParams.get(CODE_PARAM)?.trim();
    if (url.searchParams.has(CODE_PARAM)) {
        url.searchParams.delete(CODE_PARAM);
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
    return code || undefined;
}

/** Asks the server which limits `code` unlocks. Never throws. */
export async function checkAccessCode(code: string): Promise<AccessCodeCheck> {
    try {
        const limits = await uploadApi.checkAccessCode(code);
        return isUploadLimits(limits) ? { status: 'valid', limits } : { status: 'unavailable' };
    } catch (err: unknown) {
        if (isAxiosError(err) && err.response?.status === HTTP_BAD_REQUEST) {
            const detail = (err.response.data as { detail?: unknown } | undefined)?.detail;
            return { status: 'invalid', message: typeof detail === 'string' ? detail : DEFAULT_REFUSAL };
        }
        return { status: 'unavailable' };
    }
}

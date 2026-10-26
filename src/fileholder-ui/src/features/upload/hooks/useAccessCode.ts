import { useCallback, useEffect, useState } from 'react';
import { accessCodeStore, checkAccessCode, takeAccessCodeFromAddressBar } from '../services/accessCode';
import type { UploadLimits } from '../services/uploadLimits';

export type AccessCodeState =
    | { readonly status: 'none' }
    | { readonly status: 'checking'; readonly code: string }
    | { readonly status: 'valid'; readonly code: string; readonly limits: UploadLimits }
    | { readonly status: 'invalid'; readonly code: string; readonly message: string }
    | { readonly status: 'unavailable'; readonly code: string };

export interface AccessCode {
    readonly state: AccessCodeState;
    /** The code to send with the upload: only a valid one, so an invalid one never blocks uploading with the small limits. */
    readonly validCode: string | undefined;
    /** Keeps `code` for the tab and checks it with the server. */
    apply(code: string): void;
    remove(): void;
}

/**
 * The visitor's access code (#169): from a personal link (`/?code=…`) or typed in, kept for the tab, and checked with
 * the server so the form shows the limits it unlocks. Does nothing while `enabled` is false (codes off).
 */
export function useAccessCode(enabled: boolean): AccessCode {
    // Read and kept on the first render, even before the server says codes are on (the limits arrive later), so a
    // personal link never leaves its code in the address bar and the code isn't lost meanwhile.
    const [state, setState] = useState<AccessCodeState>(() => {
        const fromLink = takeAccessCodeFromAddressBar();
        if (fromLink) accessCodeStore.save(fromLink);
        const code = accessCodeStore.get();
        return code ? { status: 'checking', code } : { status: 'none' };
    });
    const checking = state.status === 'checking' ? state.code : undefined;

    useEffect(() => {
        if (!enabled || checking === undefined) return;
        let active = true;
        const check = async (): Promise<void> => {
            const result = await checkAccessCode(checking);
            if (!active) return;
            if (result.status === 'valid') setState({ status: 'valid', code: checking, limits: result.limits });
            else if (result.status === 'invalid') {
                // Not kept: a reload shouldn't keep showing a code that doesn't work.
                accessCodeStore.clear();
                setState({ status: 'invalid', code: checking, message: result.message });
            }
            else setState({ status: 'unavailable', code: checking });
        };
        void check();
        return () => {
            active = false;
        };
    }, [enabled, checking]);

    const apply = useCallback((raw: string): void => {
        const code = raw.trim();
        if (!code) return;
        accessCodeStore.save(code);
        setState({ status: 'checking', code });
    }, []);

    const remove = useCallback((): void => {
        accessCodeStore.clear();
        setState({ status: 'none' });
    }, []);

    return { state, validCode: state.status === 'valid' ? state.code : undefined, apply, remove };
}

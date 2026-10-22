import { useCallback, useEffect, useRef, useState } from 'react';

/** What the visitor picked: follow the system, or one theme regardless of it. */
export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export interface UseThemeResult {
    readonly mode: ThemeMode;
    readonly resolvedTheme: ResolvedTheme;
    readonly setMode: (mode: ThemeMode) => void;
    /** System → Light → Dark → System, the order of the header toggle. */
    readonly cycle: () => void;
}

// Shared with public/theme-init.js, which applies the saved choice before React runs.
export const THEME_STORAGE_KEY = 'fileholder-theme';
export const THEME_SWITCHING_CLASS = 'theme-switching';
// Matches the transition length in index.css, so the class goes once the cross-fade has finished.
export const THEME_SWITCH_MS = 350;

const NEXT_MODE: Readonly<Record<ThemeMode, ThemeMode>> = { system: 'light', light: 'dark', dark: 'system' };
const LIGHT_QUERY = '(prefers-color-scheme: light)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
// The canvas colour of each theme (index.css), for the phone browser's bar.
const THEME_COLORS: Readonly<Record<ResolvedTheme, string>> = { light: '#F6F7F5', dark: '#0F1211' };

let switchingTimer: ReturnType<typeof setTimeout> | undefined;

const readSavedMode = (): ThemeMode => {
    try {
        const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
        return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch {
        // Private modes and blocked site data throw; the choice just isn't remembered.
        return 'system';
    }
};

const saveMode = (mode: ThemeMode): void => {
    try {
        if (mode === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
        else window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
        // As above: the theme still switches, it just isn't kept for the next visit.
    }
};

const matches = (query: string): boolean => window.matchMedia?.(query).matches ?? false;

const readSystemTheme = (): ResolvedTheme => (matches(LIGHT_QUERY) ? 'light' : 'dark');

const applyTheme = (theme: ResolvedTheme, animate: boolean): void => {
    const root = document.documentElement;
    if (root.dataset.theme === theme) return;

    if (animate && !matches(REDUCED_MOTION_QUERY)) {
        root.classList.add(THEME_SWITCHING_CLASS);
        clearTimeout(switchingTimer);
        switchingTimer = setTimeout(() => root.classList.remove(THEME_SWITCHING_CLASS), THEME_SWITCH_MS);
    }
    root.dataset.theme = theme;
};

/** A theme picked by hand colours the bar in both schemes; following the system restores each scheme's own colour. */
const applyThemeColor = (forced: ResolvedTheme | null): void => {
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
        const scheme: ResolvedTheme = (meta.getAttribute('media') ?? '').includes('light') ? 'light' : 'dark';
        meta.setAttribute('content', THEME_COLORS[forced ?? scheme]);
    });
};

export const useTheme = (): UseThemeResult => {
    const [mode, setModeState] = useState<ThemeMode>(readSavedMode);
    const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(readSystemTheme);
    // theme-init.js has already set the theme for the first render; only later changes cross-fade.
    const hasApplied = useRef(false);
    const resolvedTheme = mode === 'system' ? systemTheme : mode;

    useEffect(() => {
        const query = window.matchMedia?.(LIGHT_QUERY);
        if (!query) return;
        const onChange = (event: MediaQueryListEvent): void => setSystemTheme(event.matches ? 'light' : 'dark');
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);

    useEffect(() => {
        applyTheme(resolvedTheme, hasApplied.current);
        hasApplied.current = true;
        applyThemeColor(mode === 'system' ? null : resolvedTheme);
    }, [mode, resolvedTheme]);

    const setMode = useCallback((next: ThemeMode): void => {
        saveMode(next);
        setModeState(next);
    }, []);

    const cycle = useCallback((): void => setMode(NEXT_MODE[mode]), [mode, setMode]);

    return { mode, resolvedTheme, setMode, cycle };
};

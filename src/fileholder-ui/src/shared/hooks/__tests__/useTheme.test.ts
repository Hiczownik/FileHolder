import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { THEME_STORAGE_KEY, THEME_SWITCHING_CLASS, THEME_SWITCH_MS, useTheme } from '../useTheme';
import { installMediaQueryStub } from './mediaQueryStub';

const LIGHT_BAR = '#F6F7F5';
const DARK_BAR = '#0F1211';
// System → Light → Dark → System.
const FULL_CYCLE_STEPS = 3;

const addThemeColorMetas = (): void => {
    document.head.innerHTML = `
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="${LIGHT_BAR}">
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="${DARK_BAR}">`;
};

const barColors = (): string[] =>
    Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((meta) => meta.getAttribute('content') ?? '');

const root = document.documentElement;

describe('useTheme', () => {
    beforeEach(() => {
        localStorage.clear();
        delete root.dataset.theme;
        root.classList.remove(THEME_SWITCHING_CLASS);
        addThemeColorMetas();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('follows the system by default', () => {
        installMediaQueryStub({ systemLight: true });

        const { result } = renderHook(() => useTheme());

        expect(result.current.mode).toBe('system');
        expect(result.current.resolvedTheme).toBe('light');
        expect(root.dataset.theme).toBe('light');
    });

    it('cycles system, light, dark and back to system', () => {
        installMediaQueryStub({ systemLight: false });
        const { result } = renderHook(() => useTheme());

        const seen = [result.current.mode];
        Array.from({ length: FULL_CYCLE_STEPS }).forEach(() => {
            act(() => result.current.cycle());
            seen.push(result.current.mode);
        });

        expect(seen).toEqual(['system', 'light', 'dark', 'system']);
    });

    it('remembers a picked theme and forgets it when back on system', () => {
        installMediaQueryStub();
        const { result, unmount } = renderHook(() => useTheme());

        act(() => result.current.setMode('light'));
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
        unmount();

        const { result: next } = renderHook(() => useTheme());
        expect(next.current.mode).toBe('light');

        act(() => next.current.setMode('system'));
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    });

    it('switches live when the system changes, only while following it', () => {
        const media = installMediaQueryStub({ systemLight: false });
        const { result } = renderHook(() => useTheme());

        act(() => media.setSystemLight(true));
        expect(result.current.resolvedTheme).toBe('light');

        act(() => result.current.setMode('dark'));
        act(() => media.setSystemLight(false));
        act(() => media.setSystemLight(true));
        expect(result.current.resolvedTheme).toBe('dark');
        expect(root.dataset.theme).toBe('dark');
    });

    it('still works when storage throws', () => {
        installMediaQueryStub({ systemLight: true });
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });

        const { result } = renderHook(() => useTheme());
        expect(result.current.mode).toBe('system');

        act(() => result.current.setMode('dark'));
        expect(root.dataset.theme).toBe('dark');
        vi.restoreAllMocks();
    });

    it('cross-fades only while switching, not on the first render', () => {
        vi.useFakeTimers();
        installMediaQueryStub({ systemLight: false });
        // As theme-init.js leaves it before React starts.
        root.dataset.theme = 'dark';
        const { result } = renderHook(() => useTheme());
        expect(root.classList.contains(THEME_SWITCHING_CLASS)).toBe(false);

        act(() => result.current.setMode('light'));
        expect(root.classList.contains(THEME_SWITCHING_CLASS)).toBe(true);

        act(() => vi.advanceTimersByTime(THEME_SWITCH_MS));
        expect(root.classList.contains(THEME_SWITCHING_CLASS)).toBe(false);
    });

    it('never cross-fades when the system asks for reduced motion', () => {
        installMediaQueryStub({ systemLight: false, reducedMotion: true });
        root.dataset.theme = 'dark';
        const { result } = renderHook(() => useTheme());

        act(() => result.current.setMode('light'));

        expect(root.dataset.theme).toBe('light');
        expect(root.classList.contains(THEME_SWITCHING_CLASS)).toBe(false);
    });

    it('colours the browser bar for a picked theme in both schemes, and per scheme on system', () => {
        installMediaQueryStub();
        const { result } = renderHook(() => useTheme());
        expect(barColors()).toEqual([LIGHT_BAR, DARK_BAR]);

        act(() => result.current.setMode('light'));
        expect(barColors()).toEqual([LIGHT_BAR, LIGHT_BAR]);

        act(() => result.current.setMode('system'));
        expect(barColors()).toEqual([LIGHT_BAR, DARK_BAR]);
    });
});

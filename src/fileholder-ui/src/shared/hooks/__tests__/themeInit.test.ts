import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { THEME_STORAGE_KEY } from '../useTheme';
import { installMediaQueryStub } from './mediaQueryStub';

// public/theme-init.js runs as a plain script before React, so it's read and run as the browser would.
const script = fs.readFileSync(path.resolve(__dirname, '../../../../public/theme-init.js'), 'utf8');
const runThemeInit = (): void => new Function(script)();

describe('theme-init.js', () => {
    beforeEach(() => {
        localStorage.clear();
        delete document.documentElement.dataset.theme;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('follows the system when nothing is saved', () => {
        installMediaQueryStub({ systemLight: true });
        runThemeInit();
        expect(document.documentElement.dataset.theme).toBe('light');
    });

    it('uses a saved choice over the system', () => {
        installMediaQueryStub({ systemLight: true });
        localStorage.setItem(THEME_STORAGE_KEY, 'dark');
        runThemeInit();
        expect(document.documentElement.dataset.theme).toBe('dark');
    });

    it('ignores a saved value it does not know', () => {
        installMediaQueryStub({ systemLight: false });
        localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
        runThemeInit();
        expect(document.documentElement.dataset.theme).toBe('dark');
    });

    it('does not throw when storage is blocked', () => {
        installMediaQueryStub({ systemLight: true });
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        expect(runThemeInit).not.toThrow();
        expect(document.documentElement.dataset.theme).toBe('light');
    });
});

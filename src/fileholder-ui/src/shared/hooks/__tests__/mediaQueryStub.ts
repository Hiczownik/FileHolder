import { vi } from 'vitest';

/** A window.matchMedia stand-in whose answers the test sets, and whose system theme can change mid-test. */
export interface MediaQueryStub {
    /** Switches the system theme and tells listeners, as the OS does when its appearance changes. */
    readonly setSystemLight: (isLight: boolean) => void;
}

interface StubOptions {
    readonly systemLight?: boolean;
    readonly reducedMotion?: boolean;
}

export const installMediaQueryStub = ({ systemLight = false, reducedMotion = false }: StubOptions = {}): MediaQueryStub => {
    const state = { systemLight };
    const listeners = new Set<(event: MediaQueryListEvent) => void>();

    vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
        const isLightQuery = query.includes('prefers-color-scheme: light');
        const isMotionQuery = query.includes('prefers-reduced-motion');
        return {
            get matches() {
                if (isLightQuery) return state.systemLight;
                return isMotionQuery ? reducedMotion : false;
            },
            media: query,
            onchange: null,
            addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
                if (isLightQuery) listeners.add(listener);
            },
            removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
                listeners.delete(listener);
            },
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(),
        } as unknown as MediaQueryList;
    });

    return {
        setSystemLight: (isLight: boolean) => {
            state.systemLight = isLight;
            listeners.forEach((listener) => listener({ matches: isLight } as MediaQueryListEvent));
        },
    };
};

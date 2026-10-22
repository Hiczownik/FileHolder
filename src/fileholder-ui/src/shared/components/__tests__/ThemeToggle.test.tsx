import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThemeToggle } from '../ThemeToggle';
import { installMediaQueryStub } from '../../hooks/__tests__/mediaQueryStub';

describe('ThemeToggle', () => {
    beforeEach(() => {
        localStorage.clear();
        installMediaQueryStub({ systemLight: false });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('names the current mode and moves to the next one on click', async () => {
        const user = userEvent.setup();
        render(<ThemeToggle />);

        const toggle = screen.getByRole('button', { name: 'Theme: system' });
        await user.click(toggle);

        expect(toggle).toHaveAccessibleName('Theme: light');
        expect(document.documentElement.dataset.theme).toBe('light');
    });

    it('works from the keyboard', async () => {
        const user = userEvent.setup();
        render(<ThemeToggle />);

        await user.tab();
        expect(screen.getByRole('button', { name: 'Theme: system' })).toHaveFocus();

        await user.keyboard('{Enter}');
        await user.keyboard(' ');
        expect(screen.getByRole('button')).toHaveAccessibleName('Theme: dark');
    });

    it('turns its icon in only after a click, not on page load', async () => {
        const user = userEvent.setup();
        render(<ThemeToggle />);
        const icon = (): Element | null => screen.getByRole('button').querySelector('svg');

        expect(icon()).not.toHaveClass('animate-theme-icon');
        await user.click(screen.getByRole('button'));
        expect(icon()).toHaveClass('animate-theme-icon');
    });
});

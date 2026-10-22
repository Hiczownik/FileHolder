import { useState } from 'react';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useTheme, type ThemeMode } from '../hooks/useTheme';
import { cn } from '../utils/cn';

const MODE_ICONS: Readonly<Record<ThemeMode, LucideIcon>> = { system: Monitor, light: Sun, dark: Moon };

/** Cycles System → Light → Dark. Its name says the current mode, so a screen reader hears what a click changes. */
export const ThemeToggle: React.FC = () => {
    const { mode, cycle } = useTheme();
    // The icon turns in only after a click, never when the page first loads.
    const [hasCycled, setHasCycled] = useState(false);
    const Icon = MODE_ICONS[mode];
    const label = `Theme: ${mode}`;

    const handleClick = (): void => {
        setHasCycled(true);
        cycle();
    };

    return (
        <button
            type="button"
            onClick={handleClick}
            aria-label={label}
            title={label}
            className="w-11 h-11 shrink-0 rounded-xl border border-line bg-surface text-fg-soft hover:bg-surface-raised flex items-center justify-center cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
            <Icon key={mode} aria-hidden="true" className={cn('w-[18px] h-[18px]', hasCycled && 'animate-theme-icon')} />
        </button>
    );
};

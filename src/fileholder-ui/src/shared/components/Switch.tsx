import { cn } from '../utils/cn';

type Props = Omit<React.ComponentProps<'input'>, 'type' | 'role'>;

/**
 * An on/off setting: a real checkbox with role="switch", so it works with forms (react-hook-form's register),
 * the keyboard and screen readers. Name it with a <label htmlFor> or aria-label as for any input.
 */
export const Switch: React.FC<Props> = ({ className, ...props }) => (
    <input
        type="checkbox"
        role="switch"
        className={cn(
            'relative w-11 h-[26px] shrink-0 appearance-none rounded-full bg-line-strong cursor-pointer transition-colors checked:bg-accent-solid',
            "after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:w-5 after:h-5 after:rounded-full after:bg-surface after:transition-transform checked:after:translate-x-[18px]",
            'motion-reduce:transition-none motion-reduce:after:transition-none',
            'outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className,
        )}
        {...props}
    />
);

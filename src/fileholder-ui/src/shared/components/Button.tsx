import React, { type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '../utils/cn';

// eslint-disable-next-line react-refresh/only-export-components
export const buttonVariants = cva(
    'font-semibold rounded-xl transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-canvas',
    {
        variants: {
            variant: {
                primary: 'bg-accent-solid hover:bg-accent-solid/90 text-on-accent focus:ring-accent',
                secondary: 'bg-surface hover:bg-surface-raised text-fg border border-line hover:border-line-strong focus:ring-line-strong',
                // on-accent reads on the solid danger colour in both themes (white on dark red, dark on light red).
                danger: 'bg-danger hover:bg-danger/90 text-on-accent focus:ring-danger',
                outline: 'bg-transparent hover:bg-surface-raised text-fg-soft border border-line hover:border-line-strong focus:ring-line-strong',
            },
            size: {
                sm: 'text-xs px-3 py-1.5',
                md: 'text-sm px-4 py-2.5',
                lg: 'text-sm px-5 py-3 w-full',
            },
        },
        defaultVariants: {
            variant: 'primary',
            size: 'md',
        },
    }
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
    isLoading?: boolean;
    loadingText?: string;
}

export const Button: React.FC<ButtonProps> = ({
    className,
    variant,
    size,
    isLoading,
    loadingText,
    children,
    disabled,
    ...props
}) => {
    return (
        <button
            className={cn(buttonVariants({ variant, size }), className)}
            disabled={disabled || isLoading}
            {...props}
        >
            {isLoading ? (
                <>
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    <span>{loadingText || children}</span>
                </>
            ) : (
                children
            )}
        </button>
    )
}
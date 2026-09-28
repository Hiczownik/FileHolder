import React, { type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '../utils/cn';

export const buttonVariants = cva(
    'font-semibold rounded-xl transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-950',
    {
        variants: {
            variant: {
                primary: 'bg-indigo-600 hover:bg-indigo-500 text-white focus:ring-indigo-500',
                secondary: 'bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 hover:border-slate-700 focus:ring-slate-700',
                danger: 'bg-rose-600 hover:bg-rose-500 text-white focus:ring-nose-500',
                outline: 'bg-transparent hover:bg-slate-800/60 text-slate-300 border border-slate-800 hover:border-slate-700 focus:ring-slate-700',
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
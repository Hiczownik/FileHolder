import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertCircle, CheckCircle2, Info, AlertTriangle } from 'lucide-react';
import { cn } from '../utils/cn';

const alertVariants = cva('p-4 rounded-xl border text-sm flex items-start gap-3', {
    variants: {
        variant: {
            error: 'bg-rose-500/10 border-rose-500/30 text-rose-400',
            success: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
            warning: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
            info: 'bg-indigo-500/10 border-indigo-500/30 text-indigo-400',
        },
    },
    defaultVariants: {
        variant: 'error',
    },
});

const iconMap = {
    error: AlertCircle,
    success: CheckCircle2,
    warning: AlertTriangle,
    info: Info,
};

export interface StatusAlertProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {
    message: string;
}

export const StatusAlert: React.FC<StatusAlertProps> = ({ 
    variant = 'error',
    message,
    className,
    ...props
}) => {
    const Icon = iconMap[variant || 'error'];

    return (
        <div className={cn(alertVariants({ variant }), className)} {...props}>
            <Icon className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">{message}</div>
        </div>
    );
};
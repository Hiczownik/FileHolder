import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertCircle, CheckCircle2, Info, AlertTriangle } from 'lucide-react';
import { cn } from '../utils/cn';

const alertVariants = cva('p-4 rounded-xl border text-sm flex items-start gap-3', {
    variants: {
        variant: {
            error: 'bg-danger-tint border-danger/30 text-danger',
            success: 'bg-success-tint border-success/30 text-success',
            warning: 'bg-warning-tint border-warning/30 text-warning',
            info: 'bg-accent-tint border-accent/40 text-accent',
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
    const kind = variant || 'error';
    const Icon = iconMap[kind];

    // Errors interrupt a screen reader; the rest are read when it's next idle. data-variant lets tests find a kind
    // of alert without depending on its colours.
    return (
        <div
            role={kind === 'error' ? 'alert' : 'status'}
            data-variant={kind}
            className={cn(alertVariants({ variant }), className)}
            {...props}
        >
            <Icon aria-hidden="true" className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">{message}</div>
        </div>
    );
};
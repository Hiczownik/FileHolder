import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button, type ButtonProps } from './Button';

interface Props {
    text: string;
    /** What the button says before copying, e.g. "Copy link"; it says "Copied!" for a moment after. */
    label?: string;
    variant?: ButtonProps['variant'];
    size?: ButtonProps['size'];
    className?: string;
}

// How long the button says "Copied!" before going back to its label.
const COPIED_FEEDBACK_MS = 2000;

export const CopyButton: React.FC<Props> = ({ text, label = 'Copy', variant = 'primary', size = 'sm', className }) => {
    const [copied, setCopied] = useState<boolean>(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
        }
    };

    return (
        <Button
            type="button"
            variant={variant}
            size={size}
            onClick={handleCopy}
            className={className}
        >
            {copied ? <Check aria-hidden="true" className="w-4 h-4" /> : <Copy aria-hidden="true" className="w-4 h-4" />}
            {/* Announced when it changes, so a screen reader hears that the copy worked. */}
            <span aria-live="polite">{copied ? 'Copied!' : label}</span>
        </Button>
    );
};

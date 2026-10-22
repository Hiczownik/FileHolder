import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from './Button';

interface Props {
    text: string;
    className?: string;
}

// How long the button says "Copied!" before going back to "Copy".
const COPIED_FEEDBACK_MS = 2000;

export const CopyButton: React.FC<Props> = ({ text, className }) => {
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
            variant="primary"
            size="sm"
            onClick={handleCopy}
            className={className}
        >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            <span>{copied ? 'Copied!' : 'Copy'}</span>
        </Button>
    );
};
import React from 'react';
import { Lock } from 'lucide-react';
import { Button } from '../../../shared/components/Button';
import { cn } from '../../../shared/utils/cn';
import type { PromptKind } from '../hooks/useFileDownload';

interface Props {
  /** A plain bundle's server-checked password, or an encrypted bundle's passkey (needed as well as the link). */
  kind: PromptKind;
  password: string;
  isUnlocking: boolean;
  onPasswordChange: (value: string) => void;
  onUnlock: (e: React.FormEvent) => void;
}

const PROMPT_TEXT: Readonly<Record<PromptKind, { title: string; description: string; label: string; footnote: string }>> = {
  password: {
    title: 'Enter the password',
    description: 'The sender protected these files with a password.',
    label: 'Password',
    footnote: "Don't have it? Ask the sender.",
  },
  passkey: {
    title: 'Enter the passkey',
    description: 'The sender gave it to you separately from this link.',
    label: 'Passkey',
    footnote: "Don't have it? Ask the sender. The passkey never reaches our server; your browser uses it to decrypt the files.",
  },
};

export const PasswordPrompt: React.FC<Props> = ({
  kind,
  password,
  isUnlocking,
  onPasswordChange,
  onUnlock,
}) => {
  const text = PROMPT_TEXT[kind];
  const isPasskey = kind === 'passkey';
  return (
    <form onSubmit={onUnlock} aria-labelledby="unlock-title" className="space-y-4 rounded-2xl border border-line bg-canvas p-5">
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 shrink-0 rounded-full bg-accent-tint text-accent flex items-center justify-center">
          <Lock aria-hidden="true" className="w-[18px] h-[18px]" />
        </span>
        <div>
          <h2 id="unlock-title" className="text-lg font-semibold">{text.title}</h2>
          <p className="text-sm text-muted">{text.description}</p>
        </div>
      </div>

      <div>
        <label htmlFor="unlock-secret" className="block text-sm font-medium mb-1.5">{text.label}</label>
        <input
          id="unlock-secret"
          type="password"
          required
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          placeholder={isPasskey ? 'XXXX-XXXX-XXXX' : undefined}
          autoComplete={isPasskey ? 'off' : 'current-password'}
          autoCapitalize={isPasskey ? 'characters' : undefined}
          spellCheck={false}
          className={cn(
            'w-full h-12 px-3.5 rounded-[10px] border border-line-strong bg-surface text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40',
            isPasskey && 'font-mono tracking-[0.08em]',
          )}
        />
      </div>

      <Button type="submit" variant="primary" size="lg" isLoading={isUnlocking} loadingText="Unlocking..." className="h-12 text-base">
        Unlock files
      </Button>

      <p className="text-sm text-muted">{text.footnote}</p>
    </form>
  );
};

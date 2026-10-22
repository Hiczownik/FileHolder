import React from 'react';
import { Lock } from 'lucide-react';
import { Button } from '../../../shared/components/Button';
import type { PromptKind } from '../hooks/useFileDownload';

interface Props {
  /** A plain bundle's server-checked password, or an encrypted bundle's passkey (needed as well as the link). */
  kind: PromptKind;
  password: string;
  isUnlocking: boolean;
  onPasswordChange: (value: string) => void;
  onUnlock: (e: React.FormEvent) => void;
}

const PROMPT_TEXT: Readonly<Record<PromptKind, { title: string; description: string; placeholder: string }>> = {
  password: {
    title: 'Password Protected Transfer',
    description: 'Enter the password to unlock the bundle manifest and download files.',
    placeholder: 'Enter password',
  },
  passkey: {
    title: 'Passkey Required',
    description: 'These files need the passkey the sender gave you separately, as well as this link.',
    placeholder: 'Enter passkey',
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
  return (
    <form onSubmit={onUnlock} className="bg-canvas p-6 rounded-2xl border border-line space-y-4 text-center">
      <div className="p-3 bg-accent-tint rounded-full w-12 h-12 mx-auto flex items-center justify-center text-accent border border-accent/30">
        <Lock className="w-6 h-6" />
      </div>

      <div>
        <h3 className="text-base font-bold text-fg">{text.title}</h3>
        <p className="text-xs text-muted mt-1">{text.description}</p>
      </div>

      <input
        type="password"
        required
        placeholder={text.placeholder}
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm text-fg outline-none focus:border-accent"
      />

      <Button
        type="submit"
        variant="primary"
        size="lg"
        isLoading={isUnlocking}
        loadingText="Unlocking..."
      >
        Unlock Files
      </Button>
    </form>
  );
};
import React from 'react';
import { Lock } from 'lucide-react';
import { Button } from '../../../shared/components/Button';

interface Props {
  password: string;
  isUnlocking: boolean;
  onPasswordChange: (value: string) => void;
  onUnlock: (e: React.FormEvent) => void;
}

export const PasswordPrompt: React.FC<Props> = ({
  password,
  isUnlocking,
  onPasswordChange,
  onUnlock,
}) => {
  return (
    <form onSubmit={onUnlock} className="bg-slate-950 p-6 rounded-2xl border border-slate-800 space-y-4 text-center">
      <div className="p-3 bg-indigo-500/10 rounded-full w-12 h-12 mx-auto flex items-center justify-center text-indigo-400 border border-indigo-500/20">
        <Lock className="w-6 h-6" />
      </div>

      <div>
        <h3 className="text-base font-bold text-white">Password Protected Transfer</h3>
        <p className="text-xs text-slate-400 mt-1">
          Enter the password to unlock the bundle manifest and download files.
        </p>
      </div>

      <input
        type="password"
        required
        placeholder="Enter password"
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500"
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
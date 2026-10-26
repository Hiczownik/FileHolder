import { useId, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '../../../shared/components/Button';
import { StatusAlert } from '../../../shared/components/StatusAlert';
import { formatSize } from '../../../shared/utils/formatSize';
import { describeHours, type UploadLimits } from '../services/uploadLimits';
import type { AccessCode } from '../hooks/useAccessCode';

const FIELD = "w-full h-11 px-3 rounded-[10px] border border-line-strong bg-surface text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 font-mono uppercase placeholder:normal-case placeholder:font-sans";
const TEXT_BUTTON = "underline underline-offset-2 hover:text-fg rounded outline-none focus-visible:ring-2 focus-visible:ring-accent";

const describe = (limits: UploadLimits): string => `up to ${formatSize(limits.maxBundleSizeBytes)}, kept for at most ${describeHours(limits.maxExpiryHours)}`;

interface Props {
    /** The limits without a code. */
    readonly baseLimits: UploadLimits;
    readonly accessCode: AccessCode;
}

/**
 * Above the upload form when access codes are on (#169): the limits without a code and how to enter one, or the
 * limits the code unlocked. A code from a personal link arrives already applied.
 */
export const AccessCodePanel: React.FC<Props> = ({ baseLimits, accessCode }) => {
    const { state } = accessCode;
    const [open, setOpen] = useState(false);
    const [typed, setTyped] = useState('');
    const inputId = useId();

    if (state.status === 'valid') {
        return (
            <div role="status" className="flex items-start gap-3 rounded-xl border border-success/30 bg-success-tint p-4 text-sm text-success">
                <KeyRound aria-hidden="true" className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="flex-1">
                    Access code applied: {describe(state.limits)}.{' '}
                    <button type="button" onClick={accessCode.remove} className={TEXT_BUTTON}>Remove</button>
                </p>
            </div>
        );
    }

    if (state.status === 'checking') {
        return <p role="status" className="text-sm text-muted">Checking your access code…</p>;
    }

    const showForm = open || state.status === 'invalid' || state.status === 'unavailable';
    const submit = (event: React.FormEvent): void => {
        event.preventDefault();
        accessCode.apply(typed || ('code' in state ? state.code : ''));
    };

    return (
        <div className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm text-fg-soft">
            <p>
                Demo limits: {describe(baseLimits)}.{' '}
                {!showForm && (
                    <button type="button" onClick={() => setOpen(true)} className={TEXT_BUTTON}>Have an access code?</button>
                )}
            </p>
            {state.status === 'invalid' && <StatusAlert variant="warning" message={state.message} />}
            {state.status === 'unavailable' && (
                <StatusAlert variant="warning" message="The access code couldn't be checked just now. Try again, or upload with the limits above." />
            )}
            {showForm && (
                <form onSubmit={submit} className="flex gap-2 items-end" aria-label="Access code">
                    <div className="flex-1 min-w-0">
                        <label htmlFor={inputId} className="block text-sm font-medium mb-1.5 text-fg">Access code</label>
                        <input
                            id={inputId}
                            className={FIELD}
                            value={typed}
                            onChange={(e) => setTyped(e.target.value)}
                            placeholder={'code' in state ? state.code : 'a01-XXXX-XXXX-XXXX'}
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </div>
                    <Button type="submit" variant="secondary" className="h-11">Apply</Button>
                </form>
            )}
        </div>
    );
};

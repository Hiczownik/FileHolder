import { formatSize } from '../../../shared/utils/formatSize';
import { planSaveMethods, type BrowserCapabilities } from '../../../shared/utils/download/streamSaving';
import { describeBuild, type BuildInfo } from '../../../shared/utils/buildInfo';

/** The text of the ?diagnostics panel (SaveDiagnostics.tsx), kept apart so it can be tested on its own. */

export interface StorageEstimate {
    readonly usage?: number;
    readonly quota?: number;
}

export interface DiagnosticsInput {
    readonly capabilities: BrowserCapabilities;
    readonly storage: StorageEstimate | null;
    readonly lastSaveReport: string | null;
    readonly userAgent: string;
    readonly secureContext: boolean;
    readonly uiBuild: BuildInfo;
    /** From GET /api/v1/status; null when it hasn't answered with one. */
    readonly apiBuild: BuildInfo | null;
}

/** A page from before a deploy talks to the new API: worth knowing when something behaves oddly. */
const describeApiBuild = (ui: BuildInfo, api: BuildInfo | null): string => {
    if (!api) return 'not known';
    const differs = api.version !== ui.version || (api.commit !== ui.commit && api.commit !== 'unknown' && ui.commit !== 'unknown');
    return differs ? `${describeBuild(api)} (differs from the UI: reload the page)` : describeBuild(api);
};

const describeStorage = (storage: StorageEstimate | null): string => {
    if (storage?.quota === undefined || storage.usage === undefined) {
        return 'no estimate available';
    }
    return `${formatSize(storage.quota - storage.usage)} free of ${formatSize(storage.quota)}`;
};

export function buildDiagnosticsReport(input: DiagnosticsInput): string {
    const plan = planSaveMethods(input.capabilities);
    const skipped = plan.skipped.map((s) => `${s.method} (${s.reason})`).join(', ') || 'none';
    return [
        `Will try, in order: ${plan.methods.join(' → ')}`,
        `Left out up front: ${skipped}`,
        `Secure context (HTTPS): ${input.secureContext ? 'yes' : 'no'}`,
        `Site storage: ${describeStorage(input.storage)}`,
        `Last download: ${input.lastSaveReport ?? 'none yet'}`,
        `Browser: ${input.userAgent}`,
        `UI build: ${describeBuild(input.uiBuild)}`,
        `API build: ${describeApiBuild(input.uiBuild, input.apiBuild)}`,
    ].join('\n');
}

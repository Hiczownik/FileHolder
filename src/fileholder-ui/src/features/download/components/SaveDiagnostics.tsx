import React, { useEffect, useState } from 'react';
import { CopyButton } from '../../../shared/components/CopyButton';
import { detectCapabilities } from '../../../shared/utils/download/streamSaving';
import { buildDiagnosticsReport, type StorageEstimate } from '../services/diagnosticsReport';
import { UI_BUILD } from '../../../shared/utils/buildInfo';
import { useServiceStatus } from '../../../shared/hooks/useServiceStatus';

/**
 * Shown only with ?diagnostics in the link: how this browser can save encrypted downloads, and how the last one
 * was saved. Meant for checking a browser without developer tools, e.g. Safari on an iPhone without a Mac; the
 * Copy button gives the whole report as text to paste elsewhere.
 */

interface Props {
    readonly lastSaveReport: string | null;
}

export const SaveDiagnostics: React.FC<Props> = ({ lastSaveReport }) => {
    const [storage, setStorage] = useState<StorageEstimate | null>(null);
    const serviceStatus = useServiceStatus();

    useEffect(() => {
        let isCancelled = false;
        const estimate = async (): Promise<void> => {
            try {
                const result = await navigator.storage?.estimate?.();
                if (!isCancelled && result) setStorage(result);
            } catch {
                // Left as "no estimate available".
            }
        };
        void estimate();
        return () => {
            isCancelled = true;
        };
    }, [lastSaveReport]);

    const report = buildDiagnosticsReport({
        capabilities: detectCapabilities(),
        storage,
        lastSaveReport,
        userAgent: navigator.userAgent,
        secureContext: window.isSecureContext,
        uiBuild: UI_BUILD,
        apiBuild: serviceStatus?.apiBuild ?? null,
    });

    return (
        <section aria-label="Download diagnostics" className="space-y-2 border-t border-line pt-4">
            <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Diagnostics</h2>
                <CopyButton text={report} />
            </div>
            <pre className="text-[11px] leading-relaxed text-fg-soft bg-canvas border border-line rounded-xl p-3 whitespace-pre-wrap break-words">
                {report}
            </pre>
        </section>
    );
};

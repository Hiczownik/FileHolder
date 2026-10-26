import { AlertTriangle } from 'lucide-react';
import { describeUntil, type ServiceMode, type ServiceStatus } from '../services/serviceStatus';

const DEFAULT_MESSAGE: Readonly<Record<Exclude<ServiceMode, 'Normal' | 'Closed'>, string>> = {
    UploadsPaused: 'New uploads are paused for now. Shared links still work.',
    ReadOnly: "FileHolder is read-only for now: bundles can be viewed, but new uploads and downloads can't start.",
};

/** Across the top of every page while uploads are paused or the site is read-only. Closed has its own page. */
export const ServiceStatusBanner: React.FC<{ status: ServiceStatus | null }> = ({ status }) => {
    if (!status || (status.mode !== 'UploadsPaused' && status.mode !== 'ReadOnly')) return null;

    const until = describeUntil(status.until);
    return (
        <div role="status" data-mode={status.mode} className="border-b border-warning/30 bg-warning-tint text-warning">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-start gap-2.5 text-sm">
                <AlertTriangle aria-hidden="true" className="w-[18px] h-[18px] shrink-0 mt-0.5" />
                <p>
                    {status.message ?? DEFAULT_MESSAGE[status.mode]}
                    {until && <> {until}</>}
                </p>
            </div>
        </div>
    );
};

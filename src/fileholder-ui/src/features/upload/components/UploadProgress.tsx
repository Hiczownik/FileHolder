import type { PreparingPhase } from "../types";

interface Props {
    progress: number;
    /** Set while nothing has been uploaded yet: photo metadata is being removed, or the passkey stretched. */
    preparing?: PreparingPhase;
}

const PREPARING_LABELS: Record<PreparingPhase, string> = {
    photos: 'Preparing files (removing photo metadata)...',
    passkey: 'Securing your passkey...',
};

export const UploadProgress: React.FC<Props> = ({ progress, preparing }) => {
    const label = preparing ? PREPARING_LABELS[preparing] : 'Uploading directly to storage...';
    return (
        <div className="space-y-2">
            <div className="flex justify-between gap-3 text-sm">
                <span id="upload-progress-label" className="font-medium">{label}</span>
                <span className="text-muted tabular-nums">{progress}%</span>
            </div>
            <div
                role="progressbar"
                aria-labelledby="upload-progress-label"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
                className="w-full h-2 rounded-full bg-surface-raised overflow-hidden"
            >
                <div
                    className="bg-accent-solid h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none"
                    style={{ width: `${progress}%`}}
                />
            </div>
        </div>
    )
}

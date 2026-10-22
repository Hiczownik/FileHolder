interface Props {
    progress: number;
    /** Photo metadata is being removed; nothing has been uploaded yet. */
    preparing?: boolean;
}

export const UploadProgress: React.FC<Props> = ({ progress, preparing = false }) => {
    const label = preparing ? 'Preparing files (removing photo metadata)...' : 'Uploading directly to storage...';
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

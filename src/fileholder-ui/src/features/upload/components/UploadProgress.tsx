interface Props {
    progress: number;
    /** Photo metadata is being removed; nothing has been uploaded yet. */
    preparing?: boolean;
}

export const UploadProgress: React.FC<Props> = ({ progress, preparing = false }) => {
    return (
        <div className="space-y-2">
            <div className="flex justify-between text-xs text-slate-400">
                <span>{preparing ? 'Preparing files (removing photo metadata)...' : 'Uploading directly to storage...'}</span>
                <span>{progress}%</span>
            </div>
            <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
                <div
                    className="bg-indigo-500 h-full transition-all duration-200"
                    style={{ width: `${progress}%`}}
                />
            </div>
        </div>
    )
}

import { Sparkles } from "lucide-react";
import { useFileUpload } from "./hooks/useFileUpload"
import { StatusAlert } from "../../shared/components/StatusAlert";
import { UploadSuccessCard } from "./components/UploadSuccessCard";
import { UploadForm } from "./components/UploadForm";

export const UploadPage: React.FC = () => {
    const { upload, uploadState, reset } = useFileUpload();

    return (
        <div className="max-w-2xl mx-auto py-12 px-4">
            <div className="text-center mb-8">
                <h1 className="text-4xl font-extrabold text-white tracking-tight flex items-center justify-center gap-2">
                    Secure File Sharing <Sparkles className="w-6 h-6 text-indigo-400" />
                </h1>
                <p className="text-slate-400 text-sm mt-2">
                    Upload single files or multi-file bundles directly to storage with custom expiration rules and password protection.
                </p>
            </div>

            {uploadState.status === 'error' && (
                <StatusAlert variant="error" message={uploadState.message} className="mb-6" />
            )}

            {uploadState.status === 'success' ? (
                <UploadSuccessCard
                    shareLink={uploadState.shareLink}
                    keyMode={uploadState.keyMode}
                    metadataSummary={uploadState.metadataSummary}
                    onReset={reset}
                />
            ) : (
                <UploadForm uploadState={uploadState} onUpload={upload} />
            )}
        </div>
    );
};
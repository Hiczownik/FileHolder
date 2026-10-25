import { Clock, ShieldCheck, Upload } from "lucide-react";
import { useFileUpload } from "./hooks/useFileUpload"
import { StatusAlert } from "../../shared/components/StatusAlert";
import { UploadSuccessCard } from "./components/UploadSuccessCard";
import { UploadForm } from "./components/UploadForm";
import { EncryptionModes, HowItWorks } from "./components/HomeSections";
import { useUploadLimits } from "./hooks/useUploadLimits";
import { describeHours } from "./services/uploadLimits";

export const UploadPage: React.FC = () => {
    const { upload, uploadState, reset } = useFileUpload();
    const limits = useUploadLimits();
    const facts = [
        { icon: Clock, text: `Expires after ${describeHours(limits.minExpiryHours)} to ${describeHours(limits.maxExpiryHours)}, or after 1 to 100 downloads` },
        { icon: ShieldCheck, text: 'End-to-end encryption in your browser, optional' },
        { icon: Upload, text: 'Files go straight to storage, never through our server' },
    ];

    if (uploadState.status === 'success') {
        return (
            <div className="max-w-[600px] mx-auto px-4 py-10 sm:py-14">
                <UploadSuccessCard result={uploadState} onReset={reset} />
            </div>
        );
    }

    return (
        <>
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-14 flex flex-col lg:flex-row gap-8 lg:gap-14 lg:items-start">
                <div className="lg:flex-1 lg:pt-6 space-y-4 sm:space-y-5 min-w-0">
                    <p className="hidden sm:block text-[13px] font-semibold text-accent uppercase tracking-wider">
                        Self-destructing file sharing
                    </p>
                    <h1 className="text-[28px] sm:text-[44px] leading-[1.1] font-semibold tracking-tight">
                        Send files that clean up after themselves.
                    </h1>
                    <p className="text-fg-soft sm:text-[17px] max-w-[460px]">
                        Share up to {limits.maxFilesPerBundle} files as one link. The bundle disappears after the time or number of downloads you
                        choose. Turn on encryption and the server never sees what&apos;s inside.
                    </p>
                    <ul className="hidden sm:block pt-2 space-y-3 text-sm text-fg-soft">
                        {facts.map(({ icon: Icon, text }) => (
                            <li key={text} className="flex items-center gap-2.5">
                                <Icon aria-hidden="true" className="w-[18px] h-[18px] text-accent shrink-0" />
                                <span>{text}</span>
                            </li>
                        ))}
                    </ul>
                </div>

                <div className="lg:flex-[1.15] min-w-0 space-y-4">
                    {uploadState.status === 'error' && (
                        <StatusAlert variant="error" message={uploadState.message} />
                    )}
                    <UploadForm uploadState={uploadState} onUpload={upload} limits={limits} />
                </div>
            </div>

            <HowItWorks />
            <EncryptionModes />
        </>
    );
};

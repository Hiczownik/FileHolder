import { useState } from "react";
import type { UploadFormValues, UploadState } from "../types";
import { useForm, useWatch } from "react-hook-form";
import { Clock, Download, Folder, KeyRound, Lock, MapPinOff, ShieldCheck } from "lucide-react";
import { FileDropzone } from "./FileDropzone";
import { UploadProgress } from "./UploadProgress";
import { Button } from "../../../shared/components/Button";
import { StatusAlert } from "../../../shared/components/StatusAlert";
import { mergeSelectedFiles } from "../services/selectedFiles";
import { generateReadablePasskey } from "../services/passkey";

interface Props {
    uploadState: UploadState;
    onUpload: (formValues: UploadFormValues, files: File[]) => void;
}

const DEFAULT_EXPIRE_IN_HOURS = 24;
const DEFAULT_MAX_DOWNLOADS = 10;

export const UploadForm: React.FC<Props> = ({ uploadState, onUpload }) => {
    const [files, setFiles] = useState<File[]>([]);
    // Shown until the next pick, so a file left out is never dropped without a word.
    const [skippedNames, setSkippedNames] = useState<string[]>([]);
    const isUploading = uploadState.status === "uploading";

    const { register, handleSubmit, control, setValue } = useForm<UploadFormValues>({
        defaultValues: {
            title: '',
            expireInHours: DEFAULT_EXPIRE_IN_HOURS,
            maxDownloads: DEFAULT_MAX_DOWNLOADS,
            password: '',
            isEncrypted: false,
            requirePasskey: false,
            // On by default: few senders know their photos carry where and when they were taken.
            stripImageMetadata: true,
        },
    });

    const isEncrypted = useWatch({ control, name: 'isEncrypted' }) ?? false;
    const requirePasskey = useWatch({ control, name: 'requirePasskey' }) ?? false;
    const passwordValue = useWatch({ control, name: 'password' }) ?? '';
    const stripImageMetadata = useWatch({ control, name: 'stripImageMetadata' }) ?? true;

    // An encrypted bundle's link carries its key, so it needs a passkey only when the uploader asks for one.
    const isPasskeyRequired = isEncrypted && requirePasskey;
    const showPasswordField = !isEncrypted || requirePasskey;
    const isPasswordMissingForE2EE = isPasskeyRequired && (!passwordValue || passwordValue.trim().length === 0);
    const isSubmitDisabled = files.length === 0 || isPasswordMissingForE2EE;

    const handleFilesSelect = (newFiles: File[]) => {
        const merged = mergeSelectedFiles(files, newFiles);
        setFiles(merged.files);
        setSkippedNames(merged.skipped.map((file) => file.name));
    };

    const handleRemoveFile = (index: number) => {
        setFiles((prev) => prev.filter((_, i) => i !== index));
    };

    const handleGeneratePasskey = () => {
        const passkey = generateReadablePasskey();
        setValue('password', passkey);
    };

    const onSubmit = (data: UploadFormValues) => {
        onUpload(data, files);
    };

    return (
        <form onSubmit={handleSubmit(onSubmit)} className="bg-surface border border-line rounded-2xl p-6 space-y-6">
            <div>
                <label htmlFor="bundle-title" className="text-xs font-semibold text-muted flex items-center gap-1.5 mb-2">
                    <Folder className="w-4 h-4 text-accent" />
                    <span>Bundle Title (Optional)</span>
                </label>
                <input
                    type="text"
                    placeholder="e.g. Project Deliverables v1"
                    id="bundle-title"
                    {...register('title')}
                    className="w-full bg-canvas border border-line rounded-xl px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                />
                {isEncrypted && (
                    <p className="text-[11px] text-muted mt-1.5">
                        Encrypted with your files; recipients see it after unlocking.
                    </p>
                )}
            </div>

            <FileDropzone
                selectedFiles={files}
                onFilesSelect={handleFilesSelect}
                onRemoveFile={handleRemoveFile}
                stripMetadata={stripImageMetadata}
            />

            {skippedNames.length > 0 && (
                <StatusAlert
                    variant="info"
                    message={`Skipped ${skippedNames.length === 1 ? '1 file' : `${skippedNames.length} files`} already in the list: ${skippedNames.join(', ')}.`}
                />
            )}

            <label className="bg-canvas p-4 rounded-xl border border-line flex items-center justify-between gap-3 cursor-pointer">
                <span className="flex items-center gap-3">
                    <MapPinOff className="w-5 h-5 text-accent shrink-0" />
                    <span>
                        <span className="block text-xs font-semibold text-fg">Remove photo metadata (location, camera details)</span>
                        <span className="block text-[11px] text-muted">
                            Done in your browser before upload, without changing the photos. HEIC photos and videos aren&apos;t cleaned.
                        </span>
                    </span>
                </span>
                <input
                    type="checkbox"
                    aria-label="Remove photo metadata"
                    {...register('stripImageMetadata')}
                    className="w-4 h-4 accent-accent-solid rounded cursor-pointer shrink-0"
                />
            </label>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                <div>
                    <label htmlFor="expire-in-hours" className="text-xs font-semibold text-muted flex items-center gap-1.5 mb-2">
                        <Clock className="w-4 h-4 text-accent" />
                        <span>Expiration Time</span>
                    </label>
                    <select
                        id="expire-in-hours"
                        {...register('expireInHours')}
                        className="w-full bg-canvas border border-line rounded-xl px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                    >
                        <option value={1}>1 Hour</option>
                        <option value={12}>12 Hours</option>
                        <option value={24}>24 Hours (1 Day)</option>
                        <option value={72}>72 Hours (3 Days)</option>
                        <option value={168}>7 Days</option>
                    </select>
                </div>

                <div>
                    <label htmlFor="max-downloads" className="text-xs font-semibold text-muted flex items-center gap-1.5 mb-2">
                        <Download className="w-4 h-4 text-accent" />
                        <span>Max Downloads</span>
                    </label>
                    <select
                        id="max-downloads"
                        {...register('maxDownloads')}
                        className="w-full bg-canvas border border-line rounded-xl px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                    >
                        <option value={1}>1 Download (Self-Destruct)</option>
                        <option value={5}>5 Downloads</option>
                        <option value={10}>10 Downloads</option>
                        <option value={50}>50 Downloads</option>
                        <option value={100}>100 Downloads</option>
                    </select>
                </div>
            </div>

            <div className="bg-canvas p-4 rounded-xl border border-line space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <ShieldCheck className="w-5 h-5 text-accent shrink-0" />
                        <div>
                            <p className="text-xs font-semibold text-fg">Zero-Knowledge Envelope Encryption</p>
                            <p className="text-[11px] text-muted">
                                Files are encrypted in your browser. The key goes in the share link, which the server never sees.
                            </p>
                        </div>
                    </div>
                    <input
                        type="checkbox"
                        aria-label="End-to-end encryption"
                        {...register('isEncrypted')}
                        className="w-4 h-4 accent-accent-solid rounded cursor-pointer"
                    />
                </div>

                {isEncrypted && (
                    <div className="flex items-center justify-between border-t border-line pt-3 pl-8">
                        <div>
                            <p className="text-xs font-semibold text-fg">Also require a passkey</p>
                            <p className="text-[11px] text-muted">
                                {requirePasskey
                                    ? "The link alone won't open the files. Send the passkey separately."
                                    : 'The link is the secret: anyone who gets it can open the files. For sensitive files, also require a passkey.'}
                            </p>
                        </div>
                        <input
                            type="checkbox"
                            aria-label="Also require a passkey"
                            {...register('requirePasskey')}
                            className="w-4 h-4 accent-accent-solid rounded cursor-pointer"
                        />
                    </div>
                )}
            </div>

            {showPasswordField && <div>
                <div className="flex items-center justify-between mb-2">
                    <label htmlFor="bundle-password" className="text-xs font-semibold text-muted flex items-center gap-1.5">
                        <Lock className="w-4 h-4 text-accent" />
                        <span>
                            {isEncrypted ? 'Passkey (Required)' : 'Password Protection (Optional)'}
                        </span>
                    </label>
                    {isEncrypted && (
                        <button
                            type="button"
                            onClick={handleGeneratePasskey}
                            className="text-xs text-accent hover:text-fg flex items-center gap-1 font-medium transition cursor-pointer"
                        >
                            <KeyRound className="w-3.5 h-3.5" />
                            <span>Generate Secure Passkey</span>
                        </button>
                    )}
                </div>
                <input
                    type="password"
                    placeholder={isEncrypted ? 'Enter or generate a secure passkey' : 'Leave empty for public link'}
                    id="bundle-password"
                    {...register('password', { required: isPasskeyRequired })}
                    className="w-full bg-canvas border border-line rounded-xl px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                />
            </div>}

            {isUploading && <UploadProgress progress={uploadState.progress} preparing={uploadState.preparing} />}

            <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={isSubmitDisabled}
                isLoading={isUploading}
                loadingText="Processing Upload..."
            >
                Generate Shareable Link
            </Button>
        </form>
    );
};
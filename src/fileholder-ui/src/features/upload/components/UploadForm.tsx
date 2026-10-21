import { useState } from "react";
import type { UploadFormValues, UploadState } from "../types";
import { useForm, useWatch } from "react-hook-form";
import { Clock, Download, Folder, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { FileDropzone } from "./FileDropzone";
import { UploadProgress } from "./UploadProgress";
import { Button } from "../../../shared/components/Button";
import { StatusAlert } from "../../../shared/components/StatusAlert";
import { mergeSelectedFiles } from "../services/selectedFiles";

interface Props {
    uploadState: UploadState;
    onUpload: (formValues: UploadFormValues, files: File[]) => void;
}

const PASSKEY_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";
const PASSKEY_SEGMENT_LENGTH = 4;
const PASSKEY_SEGMENT_COUNT = 3;
const DEFAULT_EXPIRE_IN_HOURS = 24;
const DEFAULT_MAX_DOWNLOADS = 10;

function generateReadablePasskey(): string {
    const getRandomSegment = (): string =>
        Array.from(window.crypto.getRandomValues(new Uint8Array(PASSKEY_SEGMENT_LENGTH)))
            .map((byte) => PASSKEY_CHARSET[byte % PASSKEY_CHARSET.length])
            .join('');
    return Array.from({ length: PASSKEY_SEGMENT_COUNT }, getRandomSegment).join('-');
}

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
        },
    });

    const isEncrypted = useWatch({ control, name: 'isEncrypted' }) ?? false;
    const passwordValue = useWatch({ control, name: 'password' }) ?? '';

    const isPasswordMissingForE2EE = isEncrypted && (!passwordValue || passwordValue.trim().length === 0);
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
        <form onSubmit={handleSubmit(onSubmit)} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
            <div>
                <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5 mb-2">
                    <Folder className="w-4 h-4 text-indigo-400" />
                    <span>Bundle Title (Optional)</span>
                </label>
                <input
                    type="text"
                    placeholder="e.g. Project Deliverables v1"
                    {...register('title')}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
                />
                {isEncrypted && (
                    <p className="text-[11px] text-slate-500 mt-1.5">
                        Encrypted with your files; recipients see it after unlocking.
                    </p>
                )}
            </div>

            <FileDropzone
                selectedFiles={files}
                onFilesSelect={handleFilesSelect}
                onRemoveFile={handleRemoveFile}
            />

            {skippedNames.length > 0 && (
                <StatusAlert
                    variant="info"
                    message={`Skipped ${skippedNames.length === 1 ? '1 file' : `${skippedNames.length} files`} already in the list: ${skippedNames.join(', ')}.`}
                />
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                <div>
                    <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5 mb-2">
                        <Clock className="w-4 h-4 text-indigo-400" />
                        <span>Expiration Time</span>
                    </label>
                    <select
                        {...register('expireInHours')}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
                    >
                        <option value={1}>1 Hour</option>
                        <option value={12}>12 Hours</option>
                        <option value={24}>24 Hours (1 Day)</option>
                        <option value={72}>72 Hours (3 Days)</option>
                        <option value={168}>7 Days</option>
                    </select>
                </div>

                <div>
                    <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5 mb-2">
                        <Download className="w-4 h-4 text-indigo-400" />
                        <span>Max Downloads</span>
                    </label>
                    <select
                        {...register('maxDownloads')}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
                    >
                        <option value={1}>1 Download (Self-Destruct)</option>
                        <option value={5}>5 Downloads</option>
                        <option value={10}>10 Downloads</option>
                        <option value={50}>50 Downloads</option>
                        <option value={100}>100 Downloads</option>
                    </select>
                </div>
            </div>

            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <ShieldCheck className="w-5 h-5 text-indigo-400 shrink-0" />
                    <div>
                        <p className="text-xs font-semibold text-slate-200">Zero-Knowledge Envelope Encryption</p>
                        <p className="text-[11px] text-slate-500">
                            Files are encrypted with a private key wrapped by your password. Decryption requires your passkey.
                        </p>
                    </div>
                </div>
                <input
                    type="checkbox"
                    {...register('isEncrypted')}
                    className="w-4 h-4 accent-indigo-600 rounded cursor-pointer"
                />
            </div>

            <div>
                <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
                        <Lock className="w-4 h-4 text-indigo-400" />
                        <span>
                            {isEncrypted ? 'Vault Passkey (Required for E2EE)' : 'Password Protection (Optional)'}
                        </span>
                    </label>
                    {isEncrypted && (
                        <button
                            type="button"
                            onClick={handleGeneratePasskey}
                            className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-medium transition cursor-pointer"
                        >
                            <KeyRound className="w-3.5 h-3.5" />
                            <span>Generate Secure Passkey</span>
                        </button>
                    )}
                </div>
                <input
                    type="password"
                    placeholder={isEncrypted ? 'Enter or generate a secure passkey' : 'Leave empty for public link'}
                    {...register('password', { required: isEncrypted })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
                />
            </div>

            {isUploading && <UploadProgress progress={uploadState.progress} />}

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
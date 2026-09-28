import { useState } from "react";
import type { UploadFormValues, UploadState } from "../types";
import { useForm } from "react-hook-form";
import { Clock, Download, Folder, Lock } from "lucide-react";
import { FileDropzone } from "./FileDropzone";
import { UploadProgress } from "./UploadProgress";
import { Button } from "../../../shared/components/Button";

interface Props {
    uploadState: UploadState;
    onUpload: (formValues: UploadFormValues, files: File[]) => void;
}

export const UploadForm: React.FC<Props> = ({ uploadState, onUpload }) => {
    const [files, setFiles] = useState<File[]>([]);
    const isUploading = uploadState.status === "uploading";

    const { register, handleSubmit } = useForm<UploadFormValues>({
        defaultValues: {
            title: '',
            expireInHours: 24,
            maxDownloads: 10,
            password: '',
        },
    });

    const handleFilesSelect = (newFiles: File[]) => {
        setFiles((prev) => {
            const existingKeys = new Set(prev.map((f) => `${f.name}_${f.size}`));
            const uniqueNewFiles = newFiles.filter(
                (f) => !existingKeys.has(`${f.name}_${f.size}`)
            );
            return [...prev, ...uniqueNewFiles];
        });
    }

    const handleRemoveFile = (index: number) => {
        setFiles((prev) => prev.filter((_, i) => i !== index));
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
            </div>

            <FileDropzone
                selectedFiles={files}
                onFilesSelect={handleFilesSelect}
                onRemoveFile={handleRemoveFile}
            />

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

            <div>
                <label className="text-xs font-semibold text-slate-400 flex items-center gap-1.5 mb-2">
                    <Lock className="w-4 h-4 text-indigo-400" />
                    <span>Password Protection (Optional)</span>
                </label>
                <input
                    type="password"
                    placeholder="Leave empty for public link"
                    {...register('password')}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
                />
            </div>

            {isUploading && <UploadProgress progress={uploadState.progress} /> }

            <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={files.length === 0}
                isLoading={isUploading}
                loadingText="Processing Upload..."
            >
                Generate Shareable Link
            </Button>
        </form>
    );
};
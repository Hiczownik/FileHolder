import { FileText, Upload, X } from 'lucide-react';
import React, { useRef } from 'react';

interface Props {
    selectedFiles: File[];
    onFilesSelect: (file: File[]) => void;
    onRemoveFile: (index: number) => void;
}

export const FileDropzone: React.FC<Props> = ({ selectedFiles, onFilesSelect, onRemoveFile }) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            onFilesSelect(Array.from(e.dataTransfer.files));
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            onFilesSelect(Array.from(e.target.files));
            e.target.value = '';
        }
    };

    const formatSize = (bytes: number) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);

    return (
        <div className="space-y-4">
            <div
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-indigo-500/30 hover:border-indigo-500/60 bg-slate-900/40 hover:bg-slate-900:80 rounded-2xl p-8 text-cneter cursor-pointer transition-all group"
            >
                <input
                    type="file"
                    multiple
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    className="hidden"
                />

                <div className="flex flex-col items-center gap-3">
                    <div className="p-4 bg-slate-800 rounded-full text-indigo-400 group-hover:scale-110 transition-transform">
                        <Upload className="w-8 h-8" />
                    </div>
                    <div>
                        <p className="font-medium text-slate-200 text-base">
                            Drag & Drop your files here, or <span className="text-indigo-400 underline">browse</span>
                        </p>
                        <p className="text-xs text-slate-500 mt-1">Supports up to 50 files (5GB total limit)</p>
                    </div>
                </div>
            </div>

            {selectedFiles.length > 0 && (
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3"> 
                    <div className="flex justify-between items-center text-xs text-slate-400 border-b border-slate-800 pb-2">
                        <span className="font-semibold text-slate-200">Selected Files ({selectedFiles.length})</span>
                        <span>Total: {formatSize(totalBytes)}</span>
                    </div>

                    <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
                        {selectedFiles.map((file, index) => (
                            <div
                                key={`${file.name}-${index}`}
                                className="flex items-center justify-between bg-slate-900 p-2.5 rounded-lg border border-slate-800/80 text-xs"
                            >
                                <div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
                                    <FileText className="w-4 h-4 text-indigo-400 shrink-0" />
                                    <span className="text-slate-200 truncate">{file.name}</span>
                                    <span className="text-slate-500 shrink-0">({formatSize(file.size)})</span>
                                </div>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onRemoveFile(index);
                                    }}
                                    className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-rose-400 transition"
                                    title="Remove file"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
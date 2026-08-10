import { FileText, Upload } from 'lucide-react';
import React, { useRef } from 'react';

interface Props {
    selectedFile: File | null;
    onFileSelect: (file: File | null) => void;
}

export const FileDropzone: React.FC<Props> = ({ selectedFile, onFileSelect}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            onFileSelect(e.dataTransfer.files[0]);
        }
    };

    const formatSize = (bytes: number) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    return (
        <div
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-indigo-500/30 hover:border-indigo-500/60 bg-slate-900/40 hover:bg-slate-900/80 rounded-2xl p-8 text-center cursor-pointer transition-all group"
            >
                <input
                    type="file"
                    ref={fileInputRef}
                    onChange={(e) => e.target.files && onFileSelect(e.target.files[0])}
                    className="hidden"
                />

                {selectedFile ? (
                    <div className="flex flex-col items-center gap-3">
                        <div className="p-4 bg-indigo-500/10 rounded-full text-indigo-400 border border-indigo-500/20">
                            <FileText className="w-10 h-10"/>
                        </div>
                        <div>
                            <p className="font-semibold text-slate-200 text-lg">{selectedFile.name}</p>
                            <p className="text-sm text-slate-400">{formatSize(selectedFile.size)}</p>
                        </div>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onFileSelect(null);
                            }}
                            className="text-xs text-rose-400 hover:text-rose-300 underline mt-2"
                        >
                            Remove File
                        </button>
                    </div>
                ) : (
                    <div className="flex flex-col items-center gap-3">
                        <div className="p-4 bg-slate-800 rounded-full text-indigo-400 group-hover:scale-110 transition-transform">
                            <Upload className="w-8 h-8" />
                        </div>
                        <div>
                            <p className="font-medium text-slate-200 text-base">
                                Drag & Drop your file here, or <span className="text-indigo-400 underline">browse</span>
                            </p>
                            <p className="text-xs text-slate-500 mt-1">Supports files up to 5 GB</p>
                        </div>
                    </div>
                )}
        </div>
    );
};
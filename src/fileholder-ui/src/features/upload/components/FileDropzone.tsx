import { FileText, Upload, X } from "lucide-react";
import { useRef } from "react";
import { formatSize } from "../../../shared/utils/formatSize";
import { usePhotoMetadataReports } from "../hooks/usePhotoMetadataReports";
import { MetadataLabels } from "./MetadataLabels";

interface Props {
    selectedFiles: File[];
    onFilesSelect: (files: File[]) => void;
    onRemoveFile: (index: number) => void;
    /** Whether "Remove photo metadata" is on, for the files' labels. */
    stripMetadata: boolean;
}

export const FileDropzone: React.FC<Props> = ({ selectedFiles, onFilesSelect, onRemoveFile, stripMetadata }) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const metadataReports = usePhotoMetadataReports(selectedFiles);

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent) => {
        // Otherwise the browser also opens the dropped file itself, navigating away and losing the form.
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            onFilesSelect(Array.from(e.dataTransfer.files));
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0){
            onFilesSelect(Array.from(e.target.files));
            // Cleared so picking the same file again still fires a change.
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);

    return (
        <div className="space-y-4">
            <div
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-accent/40 hover:border-accent/70 bg-canvas hover:bg-surface-raised rounded-2xl p-8 text-center cursor-pointer transition-all group"
            >
                <input
                    type="file"
                    multiple
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    className="hidden"
                />

                <div className="flex flex-col items-center gap-3">
                    <div className="p-4 bg-surface-raised rounded-full text-accent group-hover:scale-110 transition-transform">
                        <Upload className="w-8 h-8" />
                    </div>
                    <div>
                        <p className="font-medium text-fg text-base">
                            Drag & Drop your files here, or <span className="text-accent underline">browse</span>
                        </p>
                        <p className="text-xs text-muted mt-1">Supports up to 50 files (5 GB total limit)</p>
                    </div>
                </div>
            </div>

            {selectedFiles.length > 0 && (
                <div className="bg-canvas border border-line rounded-xl p-4 space-y-3">
                    <div className="flex justify-between items-center text-xs text-muted border-b border-line pb-2">
                        <span className="font-semibold text-fg">Selected Files ({selectedFiles.length})</span>
                        <span>Total: {formatSize(totalBytes)}</span>
                    </div>

                    <ul className="max-h-48 overflow-y-auto space-y-2 pr-1">
                        {selectedFiles.map((file, index) => (
                            <li
                                key={`${file.name}-${file.size}-${index}`}
                                className="flex items-center justify-between bg-surface p-2.5 rounded-lg border border-line text-xs"
                            >
                                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2.5 min-w-0 flex-1 pr-2">
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <FileText className="w-4 h-4 text-accent shrink-0"/>
                                        <span className="text-fg truncate">{file.name}</span>
                                        <span className="text-muted shrink-0">({formatSize(file.size)})</span>
                                    </div>
                                    <MetadataLabels report={metadataReports.get(file)} stripMetadata={stripMetadata} />
                                </div>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onRemoveFile(index);
                                    }}
                                    className="p-1 hover:bg-surface-raised rounded text-muted hover:text-danger transition"
                                    title="Remove file"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}
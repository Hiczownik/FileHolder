import { FileText, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { formatSize } from "../../../shared/utils/formatSize";
import { cn } from "../../../shared/utils/cn";
import { usePhotoMetadataReports } from "../hooks/usePhotoMetadataReports";
import { MetadataLabels } from "./MetadataLabels";

interface Props {
    selectedFiles: File[];
    onFilesSelect: (files: File[]) => void;
    onRemoveFile: (index: number) => void;
    /** Whether "Remove photo metadata" is on, for the files' labels. */
    stripMetadata: boolean;
}

const fileCountLabel =(count: number): string => `${count} ${count === 1 ? 'file' : 'files'}`;

export const FileDropzone: React.FC<Props> = ({ selectedFiles, onFilesSelect, onRemoveFile, stripMetadata }) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const metadataReports = usePhotoMetadataReports(selectedFiles);

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDraggingOver(true);
    };

    const handleDrop = (e: React.DragEvent) => {
        // Otherwise the browser also opens the dropped file itself, navigating away and losing the form.
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingOver(false);
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
        <div className="space-y-2.5">
            {/* A label around the input, so a click anywhere opens the file picker and the keyboard reaches it too. */}
            <label
                onDragOver={handleDragOver}
                onDragLeave={() => setIsDraggingOver(false)}
                onDrop={handleDrop}
                className={cn(
                    'flex flex-col items-center gap-2 text-center rounded-xl border-[1.5px] border-dashed px-5 py-6 sm:py-7 cursor-pointer transition-colors',
                    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface',
                    isDraggingOver ? 'border-accent bg-accent-tint' : 'border-line-strong bg-canvas hover:bg-surface-raised',
                )}
            >
                <input
                    type="file"
                    multiple
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    className="sr-only"
                />
                <Upload aria-hidden="true" className="w-6 h-6 text-accent" />
                <span className="font-medium">
                    Drop files here or <span className="text-accent underline underline-offset-[3px]">choose files</span>
                </span>
                <span className="text-sm text-muted">Up to 50 files, 5 GB in total</span>
            </label>

            {selectedFiles.length > 0 && (
                <div className="border border-line rounded-xl overflow-hidden">
                    <div className="flex justify-between gap-3 px-3.5 py-2.5 text-sm text-muted bg-surface-raised">
                        <span className="font-semibold text-fg-soft">{fileCountLabel(selectedFiles.length)}</span>
                        <span>{formatSize(totalBytes)}</span>
                    </div>

                    <ul aria-label="Selected files" className="max-h-60 overflow-y-auto">
                        {selectedFiles.map((file, index) => (
                            <li
                                key={`${file.name}-${file.size}-${index}`}
                                className="flex items-center gap-2 border-t border-line py-1 pl-3.5 pr-1 text-sm"
                            >
                                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2.5 min-w-0 flex-1">
                                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                        <FileText aria-hidden="true" className="w-4 h-4 text-muted shrink-0" />
                                        <span className="truncate">{file.name}</span>
                                        <span className="text-[13px] text-muted shrink-0 tabular-nums">{formatSize(file.size)}</span>
                                    </div>
                                    <MetadataLabels report={metadataReports.get(file)} stripMetadata={stripMetadata} />
                                </div>
                                <button
                                    type="button"
                                    onClick={() => onRemoveFile(index)}
                                    aria-label={`Remove ${file.name}`}
                                    title={`Remove ${file.name}`}
                                    className="w-10 h-10 shrink-0 flex items-center justify-center rounded-lg text-muted hover:text-danger hover:bg-surface-raised outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                >
                                    <X aria-hidden="true" className="w-4 h-4" />
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}

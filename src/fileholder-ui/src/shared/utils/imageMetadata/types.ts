/**
 * What a file's first bytes say it is. Only JPEG, PNG and WebP can have their metadata removed; the other image and
 * video formats are recognised so the page can say their metadata stays.
 */
export type FileFormat = 'jpeg' | 'png' | 'webp' | 'heic' | 'avif' | 'tiff' | 'video' | 'other';

/** What detectPhotoMetadata finds, from the file's headers alone. */
export interface MetadataReport {
    readonly format: FileFormat;
    /** What removing metadata would take out, e.g. "EXIF" or "XMP"; empty when there is nothing (or it can't be removed). */
    readonly removable: readonly string[];
    /** GPS coordinates were found (not merely an empty GPS section). Only known for JPEG, PNG and WebP. */
    readonly hasLocation: boolean;
    /** The file may carry metadata that can't be removed: HEIC, AVIF, TIFF/RAW, video, or a photo too damaged to read. */
    readonly unremovable: boolean;
    /** An Android Motion Photo: removing its metadata also removes its short video, leaving a still photo. */
    readonly isMotionPhoto: boolean;
}

/**
 * - `stripped`: metadata was removed; `file` is the cleaned copy.
 * - `unchanged`: there was nothing to remove (or the file isn't a photo); `file` is the original.
 * - `unsupported`: a format whose metadata can't be removed (HEIC, AVIF, TIFF/RAW, video); `file` is the original.
 * - `failed`: the photo couldn't be read (damaged or unusual); `file` is the original, metadata and all.
 */
export type StripStatus = 'stripped' | 'unchanged' | 'unsupported' | 'failed';

export interface StripResult {
    readonly file: File;
    readonly status: StripStatus;
    readonly removed: readonly string[];
}

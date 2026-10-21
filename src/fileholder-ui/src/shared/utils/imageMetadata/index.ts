import type { FormatScan } from './formatScan';
import { scanJpeg } from './jpeg';
import { scanPng } from './png';
import { sniffFormat } from './sniff';
import type { FileFormat, MetadataReport, StripResult } from './types';
import { scanWebp } from './webp';

export type { FileFormat, MetadataReport, StripResult, StripStatus } from './types';

/**
 * Removes privacy-sensitive metadata (location, camera details, times, thumbnails) from photos in the browser, by
 * cutting metadata sections out of JPEG, PNG and WebP files. Nothing is re-encoded: the image data stays
 * byte-for-byte the same, colour profiles and animation are kept, and a rotated photo keeps its orientation.
 */

const SCANNERS: Partial<Record<FileFormat, (file: Blob) => Promise<FormatScan>>> = {
    jpeg: scanJpeg,
    png: scanPng,
    webp: scanWebp,
};

/** Formats that commonly carry metadata (often a location) that this module can't remove. */
const UNREMOVABLE_FORMATS: ReadonlySet<FileFormat> = new Set<FileFormat>(['heic', 'avif', 'tiff', 'video']);

const nothingFound = (format: FileFormat, unremovable: boolean): MetadataReport =>
    ({ format, removable: [], hasLocation: false, unremovable, isMotionPhoto: false });

/** What metadata a file has, reading only its headers. Never throws. */
export async function detectPhotoMetadata(file: Blob): Promise<MetadataReport> {
    const format = await sniffFormat(file).catch((): FileFormat => 'other');
    const scanner = SCANNERS[format];
    if (!scanner) return nothingFound(format, UNREMOVABLE_FORMATS.has(format));
    try {
        const scan = await scanner(file);
        return { format, removable: scan.removed, hasLocation: scan.hasLocation, unremovable: false, isMotionPhoto: scan.isMotionPhoto };
    } catch {
        // A photo that can't be read is uploaded as it is, so its metadata may well stay.
        return nothingFound(format, true);
    }
}

/**
 * A copy of the photo without its metadata, with the original's name, type and modified date. Anything that can't be
 * cleaned (another format, or a damaged photo) comes back as the original file, with a status saying why. Never throws.
 */
export async function removePhotoMetadata(file: File): Promise<StripResult> {
    const unchanged = (status: StripResult['status']): StripResult => ({ file, status, removed: [] });
    try {
        const format = await sniffFormat(file);
        const scanner = SCANNERS[format];
        if (!scanner) return unchanged(UNREMOVABLE_FORMATS.has(format) ? 'unsupported' : 'unchanged');

        const scan = await scanner(file);
        if (scan.removed.length === 0) return unchanged('unchanged');
        const cleaned = new File([...scan.parts], file.name, { type: file.type, lastModified: file.lastModified });
        return { file: cleaned, status: 'stripped', removed: scan.removed };
    } catch {
        return unchanged('failed');
    }
}

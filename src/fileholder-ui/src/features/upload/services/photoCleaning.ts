import { removePhotoMetadata, type StripResult } from "../../../shared/utils/imageMetadata";
import type { MetadataSummary } from "../types";
import { abortError } from "./rateLimitRetry";

export interface CleanedFiles {
    /** The files to upload, in the same order: cleaned copies where possible, otherwise the originals. */
    readonly files: File[];
    readonly summary: MetadataSummary;
}

const MOTION_PHOTO_VIDEO = 'Motion Photo video';

const summarise = (results: readonly StripResult[]): MetadataSummary => ({
    cleaned: results.filter((result) => result.status === 'stripped').length,
    notCleaned: results
        .filter((result) => result.status === 'unsupported' || result.status === 'failed')
        .map((result) => result.file.name),
    motionPhotos: results.filter((result) => result.removed.includes(MOTION_PHOTO_VIDEO)).length,
});

/**
 * Removes photo metadata from every file before upload. Done here, at submit, rather than when files are picked:
 * the cleaned sizes are what get presigned, and the list of picked files stays the user's originals. Only the
 * photos' headers are read, so this takes a moment even for large files.
 */
export async function cleanPhotos(files: readonly File[], signal?: AbortSignal): Promise<CleanedFiles> {
    const results = await Promise.all(files.map((file) => removePhotoMetadata(file)));
    if (signal?.aborted) {
        throw abortError();
    }
    return { files: results.map((result) => result.file), summary: summarise(results) };
}

// Names listed in full; any more are counted.
const MAX_NAMED_FILES = 3;

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "a.heic, b.mov and 2 more" */
const nameList = (names: readonly string[]): string => {
    const named = names.slice(0, MAX_NAMED_FILES).join(', ');
    return names.length > MAX_NAMED_FILES ? `${named} and ${names.length - MAX_NAMED_FILES} more` : named;
};

/** What removing photo metadata did, in a sentence or two; null when it touched nothing worth mentioning. */
export function describeMetadataSummary(summary: MetadataSummary): string | null {
    const sentences = [
        summary.cleaned > 0 ? `Removed metadata from ${count(summary.cleaned, 'photo', 'photos')}.` : '',
        summary.motionPhotos > 0 ? `${count(summary.motionPhotos, 'Motion Photo is', 'Motion Photos are')} now a still photo.` : '',
        summary.notCleaned.length > 0
            ? `${count(summary.notCleaned.length, "file couldn't be cleaned and keeps its", "files couldn't be cleaned and keep their")} metadata: ${nameList(summary.notCleaned)}.`
            : '',
    ].filter(Boolean);
    return sentences.length > 0 ? sentences.join(' ') : null;
}

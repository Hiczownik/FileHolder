export interface MergedFiles {
    readonly files: File[];
    /** Files left out because the list already had them, so the form can say so instead of dropping them silently. */
    readonly skipped: File[];
}

/**
 * What makes two picks the same file. Name and size alone aren't enough: "photos/2023/img.jpg" and
 * "photos/2024/img.jpg" can share both, so the modification time (and the folder path, when the browser gives
 * one) tell them apart. Picking the very same file twice still matches on all four.
 */
const identityOf = (file: File): string => JSON.stringify([file.name, file.size, file.lastModified, file.webkitRelativePath ?? '']);

/** Adds newly picked files to the list, skipping any already in it (or picked twice in the same go). */
export function mergeSelectedFiles(existing: readonly File[], picked: readonly File[]): MergedFiles {
    const taken = new Set(existing.map(identityOf));
    const files = [...existing];
    const skipped: File[] = [];

    picked.forEach((file) => {
        const identity = identityOf(file);
        if (taken.has(identity)) {
            skipped.push(file);
            return;
        }
        taken.add(identity);
        files.push(file);
    });

    return { files, skipped };
}

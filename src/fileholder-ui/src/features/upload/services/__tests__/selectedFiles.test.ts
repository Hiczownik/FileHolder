import { describe, it, expect } from 'vitest';
import { mergeSelectedFiles } from '../selectedFiles';

const TWO_MB = 2_097_152;
const TAKEN_2023 = Date.parse('2023-06-01T10:00:00Z');
const TAKEN_2024 = Date.parse('2024-06-01T10:00:00Z');

const fileOf = (name: string, size: number, lastModified: number): File => {
    const file = new File(['x'], name, { lastModified });
    Object.defineProperty(file, 'size', { value: size });
    return file;
};

describe('mergeSelectedFiles', () => {
    it('keeps different files that share a name and size', () => {
        const from2023 = fileOf('img.jpg', TWO_MB, TAKEN_2023);
        const from2024 = fileOf('img.jpg', TWO_MB, TAKEN_2024);

        const merged = mergeSelectedFiles([from2023], [from2024]);

        expect(merged.files).toEqual([from2023, from2024]);
        expect(merged.skipped).toEqual([]);
    });

    it('skips a file that is already in the list, and says which', () => {
        const picked = fileOf('report.pdf', TWO_MB, TAKEN_2024);
        const pickedAgain = fileOf('report.pdf', TWO_MB, TAKEN_2024);

        const merged = mergeSelectedFiles([picked], [pickedAgain]);

        expect(merged.files).toEqual([picked]);
        expect(merged.skipped).toEqual([pickedAgain]);
    });

    it('skips a file picked twice in the same go', () => {
        const first = fileOf('notes.txt', TWO_MB, TAKEN_2024);
        const second = fileOf('notes.txt', TWO_MB, TAKEN_2024);

        const merged = mergeSelectedFiles([], [first, second]);

        expect(merged.files).toEqual([first]);
        expect(merged.skipped).toEqual([second]);
    });
});

import { describe, it, expect } from 'vitest';
import { useFileUpload } from '../useFileUpload';
import { act, renderHook } from '@testing-library/react';

describe('useFileUpload Hook', () => {
    const createFile = (name: string, size: number): File => {
        const file = new File(['a'.repeat(size)], name, { type: 'text/plain' });
        Object.defineProperty(file, 'size', { value: size });
        return file;
    };

    it('starts with an empty file list and default settings', () => {
        const { result } = renderHook(() => useFileUpload());

        expect(result.current.files).toEqual([]);
        expect(result.current.expireInHours).toBe(24);
        expect(result.current.maxDownloads).toBe(10);
        expect(result.current.isUploading).toBe(false);
        expect(result.current.uploadProgress).toBe(0);
        expect(result.current.error).toBeNull();
    });

    it('adds files sequentially without multiplying or duplicating (Regression Guard)', () => {
        const { result } = renderHook(() => useFileUpload());

        const fileA = createFile('docA.txt', 100);
        const fileB = createFile('docB.txt', 200);
        const fileC = createFile('docC.txt', 300);

        // Batch 1: Add 2 files
        act(() => {
            result.current.addFiles([fileA, fileB]);
        });
        expect(result.current.files).toHaveLength(2);
        expect(result.current.files.map((f) => f.name)).toEqual(['docA.txt', 'docB.txt']);

        // Batch 2: Add 1 more file
        act(() => {
            result.current.addFiles([fileC]);
        });
        expect(result.current.files).toHaveLength(3);
        expect(result.current.files.map((f) => f.name)).toEqual(['docA.txt', 'docB.txt', 'docC.txt']);

    });

    it('ignores duplicate files with identical name and size', () => {
        const { result } = renderHook(() => useFileUpload());

        const fileA = createFile('docA.txt', 100);
        const dupeFileA = createFile('docA.txt', 100);

        act(() => {
            result.current.addFiles([fileA]);
        });
        expect(result.current.files).toHaveLength(1);

        act(() => {
            result.current.addFiles([dupeFileA]);
        });
        expect(result.current.files).toHaveLength(1);
    })

    it('removes a file at specific index', () => {
        const { result } = renderHook(() => useFileUpload());

        const fileA = createFile('docA.txt', 100);
        const fileB = createFile('docB.txt', 200);

        act(() => {
            result.current.addFiles([fileA, fileB]);
        });
        expect(result.current.files).toHaveLength(2);

        act(() => {
            result.current.removeFile(0);
        });
        expect(result.current.files).toHaveLength(1);
        expect(result.current.files[0].name).toBe('docB.txt');
    });

    it('resets the state correctly', () => {
        const { result } = renderHook(() => useFileUpload());

        const fileA = createFile('docA.txt', 100);
        act(() => {
            result.current.addFiles([fileA]);
            result.current.setTitle('Test Title');
            result.current.setPassword('Pass123!');
        });

        expect(result.current.files).toHaveLength(1);
        expect(result.current.title).toBe('Test Title');

        act(() => {
            result.current.reset();
        });

        expect(result.current.files).toEqual([]);
        expect(result.current.title).toBe('');
        expect(result.current.password).toBe('');
    });
})
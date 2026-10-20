import { describe, it, expect } from 'vitest';
import { countingStream, describeDownloadProgress } from '../progress';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
const RECEIVED_MB = 640;
const TOTAL_MB = 1536;
const FIRST_CHUNK_LENGTH = 3;
const SECOND_CHUNK_LENGTH = 2;

const readAll = async (reader: ReadableStreamDefaultReader<Uint8Array>, parts: number[]): Promise<number[]> => {
    const { done, value } = await reader.read();
    return done ? parts : readAll(reader, [...parts, ...value]);
};

describe('countingStream', () => {
    it('passes every byte through unchanged and reports each chunk\'s size', async () => {
        const first = Uint8Array.from({ length: FIRST_CHUNK_LENGTH }, (_, i) => i);
        const second = Uint8Array.from({ length: SECOND_CHUNK_LENGTH }, (_, i) => FIRST_CHUNK_LENGTH + i);
        const reported: number[] = [];
        const source = new ReadableStream<Uint8Array>({
            start: (controller) => {
                controller.enqueue(first);
                controller.enqueue(second);
                controller.close();
            },
        });

        const passedThrough = await readAll(source.pipeThrough(countingStream((n) => reported.push(n))).getReader(), []);

        expect(passedThrough).toEqual([...first, ...second]);
        expect(reported).toEqual([FIRST_CHUNK_LENGTH, SECOND_CHUNK_LENGTH]);
    });
});

describe('describeDownloadProgress', () => {
    it('shows how much of the total has been decrypted', () => {
        expect(describeDownloadProgress({ receivedBytes: RECEIVED_MB * BYTES_PER_MB, totalBytes: TOTAL_MB * BYTES_PER_MB }))
            .toBe('Decrypting… 640 MB of 1.5 GB');
    });

    it.each([
        ['unknown', null],
        ['zero', 0],
        ['smaller than what already arrived (the manifest is the uploader\'s word)', BYTES_PER_MB],
    ])('leaves the total out when it is %s', (_, totalBytes) => {
        expect(describeDownloadProgress({ receivedBytes: RECEIVED_MB * BYTES_PER_MB, totalBytes })).toBe('Decrypting… 640 MB');
    });
});

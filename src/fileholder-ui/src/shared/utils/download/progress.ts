import { formatSize } from '../formatSize';

/**
 * How far an encrypted download has got, in decrypted bytes. Some saving methods (OPFS) only hand the file to the
 * browser once it is complete, so without this a long download looks as if it has stopped.
 */
export interface DownloadProgress {
    readonly receivedBytes: number;
    /** From the bundle's manifest, which the uploader wrote; only ever used for display. */
    readonly totalBytes: number | null;
}

/** Passes chunks through unchanged, reporting the size of each one as it goes by. */
export function countingStream(onChunk: (byteLength: number) => void): TransformStream<Uint8Array, Uint8Array> {
    return new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
            onChunk(chunk.byteLength);
            controller.enqueue(chunk);
        },
    });
}

/** "Decrypting… 640 MB of 1.5 GB", or without the total when it is unknown or already passed. */
export function describeDownloadProgress(progress: DownloadProgress): string {
    const received = formatSize(progress.receivedBytes);
    const hasTotal = progress.totalBytes !== null && progress.totalBytes > 0 && progress.receivedBytes <= progress.totalBytes;
    return hasTotal ? `Decrypting… ${received} of ${formatSize(progress.totalBytes!)}` : `Decrypting… ${received}`;
}

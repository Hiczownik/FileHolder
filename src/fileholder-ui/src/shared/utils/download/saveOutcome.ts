/** What every saving method shares (see streamSaving.ts), kept apart so the methods can import it freely. */

export type SaveMethodName = 'service-worker' | 'file-system-access' | 'opfs' | 'memory';

export interface StreamedFile {
    readonly fileName: string;
    /** When known, lets a method refuse up front instead of failing part way (storage quota, memory cap). */
    readonly sizeBytes?: number;
}

/** A method stepped aside without reading from the stream, so the next one can still use it. */
export interface Unavailable {
    readonly unavailable: string;
}

export type SaveOutcome = 'saved' | Unavailable;

export const unavailable = (reason: string): Unavailable => ({ unavailable: reason });

/** For reasons built from a caught error: its name and message, e.g. "SecurityError: The operation is insecure." */
export const describeError = (err: unknown): string =>
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);

export interface SkippedMethod {
    readonly method: SaveMethodName;
    readonly reason: string;
}

export interface SaveResult {
    readonly method: SaveMethodName;
    /** Methods passed over before this one, and why; shows which browser feature was missing. */
    readonly skipped: readonly SkippedMethod[];
}

/** "via memory. Skipped: service-worker (held back on WebKit), opfs (no createWritable)" */
export function describeSaveResult(result: SaveResult): string {
    const via = `via ${result.method}`;
    return result.skipped.length === 0
        ? via
        : `${via}. Skipped: ${result.skipped.map((s) => `${s.method} (${s.reason})`).join(', ')}`;
}

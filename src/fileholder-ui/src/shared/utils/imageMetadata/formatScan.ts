/** What a format's scanner found, and how to build the cleaned file. */
export interface FormatScan {
    /** What would be (or was) removed, e.g. "EXIF"; empty when the photo has nothing to remove. */
    readonly removed: readonly string[];
    readonly hasLocation: boolean;
    readonly isMotionPhoto: boolean;
    /** The cleaned file's pieces, in order: unread slices of the original and a few new bytes. */
    readonly parts: readonly BlobPart[];
}

// No real photo has anywhere near this many segments or chunks (an animated image might have a few thousand); a file
// claiming more is damaged or built to make the parser spin.
export const MAX_SECTIONS = 100_000;

// EXIF, XMP and text sections are read to look for a location. One larger than this is still removed, just not read.
const BYTES_PER_KB = 1024;
export const MAX_INSPECTED_BYTES = BYTES_PER_KB * BYTES_PER_KB;

const utf8 = new TextDecoder('utf-8', { fatal: false });
export const decodeText = (bytes: Uint8Array): string => utf8.decode(bytes);

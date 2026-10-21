/** Letters and digits without "0", which reads like "O". */
export const PASSKEY_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";
const PASSKEY_SEGMENT_LENGTH = 4;
const PASSKEY_SEGMENT_COUNT = 3;

/**
 * A passkey that is easy to read out and type: three groups of four, like "K7QF-2MXA-9RTB". About 61.5 bits.
 * Known flaw (#48): "byte % 35" favours the first 11 characters slightly, as 256 isn't a multiple of 35.
 */
export function generateReadablePasskey(): string {
    const getRandomSegment = (): string =>
        Array.from(window.crypto.getRandomValues(new Uint8Array(PASSKEY_SEGMENT_LENGTH)))
            .map((byte) => PASSKEY_CHARSET[byte % PASSKEY_CHARSET.length])
            .join('');
    return Array.from({ length: PASSKEY_SEGMENT_COUNT }, getRandomSegment).join('-');
}

/** Letters and digits without "0", which reads like "O". */
export const PASSKEY_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";
const PASSKEY_SEGMENT_LENGTH = 4;
const PASSKEY_SEGMENT_COUNT = 3;
const BYTE_VALUES = 256;
// The largest multiple of 35 that fits in a byte (35 × 7). Bytes from here up are skipped: keeping them would
// make "byte % 35" favour the first 11 characters (#48).
const UNBIASED_BYTE_LIMIT = Math.floor(BYTE_VALUES / PASSKEY_CHARSET.length) * PASSKEY_CHARSET.length;

/** One passkey character per random byte below the limit; about 4% of bytes are skipped, so more are drawn. */
const randomPasskeyChars = (count: number, chars: string = ''): string => {
    if (chars.length >= count) return chars.slice(0, count);
    const drawn = Array.from(window.crypto.getRandomValues(new Uint8Array(count)))
        .filter((byte) => byte < UNBIASED_BYTE_LIMIT)
        .map((byte) => PASSKEY_CHARSET[byte % PASSKEY_CHARSET.length])
        .join('');
    return randomPasskeyChars(count, chars + drawn);
};

/**
 * The fewest characters a typed passkey may have. Argon2id makes each guess costly, but a short passkey still falls
 * to a few million guesses (#78). The server never sees the passkey, so only the browser can check this.
 */
export const MIN_PASSKEY_LENGTH = 10;

export const PASSKEY_REQUIRED_MESSAGE = 'Enter a passkey, or turn off "Also require a passkey".';
export const PASSKEY_TOO_SHORT_MESSAGE = `Use a passkey of at least ${MIN_PASSKEY_LENGTH} characters, or generate one.`;

/**
 * Why `passkey` can't protect a bundle, or null when it can. Characters are counted as the recipient types them:
 * after NFC normalisation (as Argon2id gets it), so "é" counts once however it was entered, and without spaces at
 * either end.
 */
export function passkeyProblem(passkey: string | undefined): string | null {
    const typed = (passkey ?? '').normalize('NFC').trim();
    if (typed.length === 0) return PASSKEY_REQUIRED_MESSAGE;
    return Array.from(typed).length < MIN_PASSKEY_LENGTH ? PASSKEY_TOO_SHORT_MESSAGE : null;
}

/** A passkey that is easy to read out and type: three groups of four, like "K7QF-2MXA-9RTB". About 61.5 bits. */
export function generateReadablePasskey(): string {
    return Array.from({ length: PASSKEY_SEGMENT_COUNT }, () => randomPasskeyChars(PASSKEY_SEGMENT_LENGTH)).join('-');
}

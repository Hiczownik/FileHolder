import { cryptoEngine, base64Url } from "../../../shared/utils/crypto/cryptoUtils";
import {
    createStreamParams,
    encryptChunkRange,
    encryptedSize,
    serializeStreamParams,
    STREAM_TAG_BYTES,
    type StreamParams,
} from "../../../shared/utils/crypto/streamCipher";
import type { FileItemMetadata, KeyMode } from "../../download/types";

/**
 * One file of an encrypted bundle, ready to upload. Nothing is encrypted up front: the plaintext stays in
 * the File, and each upload part is encrypted from its slice just before it is sent, so memory use doesn't
 * grow with the file size.
 */
export interface EncryptedFileItem {
    readonly id: string;
    readonly file: File;
    readonly fileKey: CryptoKey;
    readonly stream: StreamParams;
    /** The name the server stores, "{id}.enc"; the real name is only in the encrypted manifest. */
    readonly storageName: string;
    readonly encryptedSize: number;
}

export interface PreparedEncryptedPayload {
    readonly files: readonly EncryptedFileItem[];
    readonly encryptedManifest: string;
    readonly keyEnvelope: string;
    readonly keySalt: string;
    readonly kAuth: string;
    /** The title, encrypted with the master key like the manifest; absent when the bundle has none. */
    readonly encryptedTitle?: string;
    /** Goes only in the share link's fragment; never sent to the server. */
    readonly linkKey: string;
    readonly keyMode: KeyMode;
}

/**
 * Encrypts the bundle's manifest and title, and sets up the keys its files are encrypted with. With a passkey,
 * recipients need it as well as the link; without one, the link alone opens the files.
 */
export async function prepareEncryptedBundle(
    files: readonly File[],
    passkey: string | undefined,
    title?: string
): Promise<PreparedEncryptedPayload> {
    const masterKey = await cryptoEngine.generateKey();
    const salt = cryptoEngine.generateSalt();
    // Separate from the master key, so the master key only ever exists wrapped.
    const linkKey = cryptoEngine.generateLinkKey();
    const { kAuth, kWrap } = await cryptoEngine.deriveLinkKeys(linkKey, salt, passkey);
    const keyEnvelope = await cryptoEngine.wrapMasterKey(masterKey, kWrap);

    const encryptedFiles = await Promise.all(files.map(async (file): Promise<EncryptedFileItem> => {
        const id = crypto.randomUUID();
        const stream = createStreamParams();
        return {
            id,
            file,
            fileKey: await cryptoEngine.deriveFileKey(masterKey, id),
            stream,
            storageName: `${id}.enc`,
            encryptedSize: encryptedSize(file.size, stream.chunkSize),
        };
    }));

    const manifestItems: FileItemMetadata[] = encryptedFiles.map((item) => ({
        id: item.id,
        fileName: item.file.name,
        sizeBytes: item.file.size,
        contentType: item.file.type || 'application/octet-stream',
        stream: serializeStreamParams(item.stream),
    }));

    // Trimmed as the server trims plain titles. Kept out of the manifest, so the manifest's format stays as it is.
    const trimmedTitle = title?.trim() ?? '';

    return {
        files: encryptedFiles,
        encryptedManifest: await cryptoEngine.encryptJson(masterKey, manifestItems),
        keyEnvelope,
        keySalt: base64Url.encode(salt),
        kAuth,
        encryptedTitle: trimmedTitle === '' ? undefined : await cryptoEngine.encryptJson(masterKey, trimmedTitle),
        linkKey,
        keyMode: passkey === undefined ? 'LinkKey' : 'LinkKeyAndPasskey',
    };
}

const encryptedChunkSize = (item: EncryptedFileItem): number => item.stream.chunkSize + STREAM_TAG_BYTES;

/**
 * Throws unless parts of `partSizeBytes` hold whole encrypted chunks. The server sizes parts that way for
 * encrypted uploads; a mismatch would mean it was built for a different chunk size.
 */
export function assertPartsAlignWithChunks(item: EncryptedFileItem, partSizeBytes: number): void {
    if (partSizeBytes <= 0 || partSizeBytes % encryptedChunkSize(item) !== 0) {
        throw new Error('The server sized the upload parts for a different encryption chunk size. Please reload the page and try again.');
    }
}

/**
 * Encrypts the ciphertext bytes start..end (end exclusive) of the file, reading only the plaintext they
 * cover. Both ends must fall on chunk boundaries (or `end` at the end of the file), as multipart parts do.
 */
export async function encryptCiphertextRange(item: EncryptedFileItem, start: number, end: number): Promise<Blob> {
    const chunkBytes = encryptedChunkSize(item);
    if (start % chunkBytes !== 0 || (end % chunkBytes !== 0 && end !== item.encryptedSize) || end <= start || end > item.encryptedSize) {
        throw new Error(`Ciphertext range ${start}-${end} does not fall on encryption chunk boundaries.`);
    }

    const firstChunk = start / chunkBytes;
    const count = Math.ceil((end - start) / chunkBytes);
    const ciphertext = await encryptChunkRange(item.fileKey, item.stream, item.file, firstChunk, count);
    return new Blob([ciphertext as BlobPart], { type: 'application/octet-stream' });
}

/** The whole file encrypted at once, for files small enough to go in a single PUT. */
export async function encryptWholeFile(item: EncryptedFileItem): Promise<Blob> {
    const blob = await encryptCiphertextRange(item, 0, item.encryptedSize);
    // The upload URL is signed for exactly encryptedSize bytes; anything else would be refused by storage.
    if (blob.size !== item.encryptedSize) {
        throw new Error('Encrypted size does not match what was presigned.');
    }
    return blob;
}

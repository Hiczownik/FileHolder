import { cryptoEngine, base64Url } from "../../../shared/utils/crypto/cryptoUtils";
import type { FileItemMetadata } from "../../download/types";

export interface EncryptedFileItem {
    id: string;
    originalName: string;
    originalSize: number;
    originalType: string;
    encryptedFile: File;
}

export interface PreparedEncryptedPayload {
    files: EncryptedFileItem[];
    encryptedManifest: string;
    keyEnvelope: string;
    keySalt: string;
    kAuth: string;
}

export async function prepareEncryptedBundle(
    files: File[],
    password: string
): Promise<PreparedEncryptedPayload> {
    const masterKey = await cryptoEngine.generateKey();
    const salt = cryptoEngine.generateSalt();
    const { kAuth, kWrap } = await cryptoEngine.deriveDualKeys(password, salt);
    const keyEnvelope = await cryptoEngine.wrapMasterKey(masterKey, kWrap);

    const encryptedFiles: EncryptedFileItem[] = [];
    const manifestItems: FileItemMetadata[] = [];

    for (const file of files) {
        const fileId = crypto.randomUUID();
        const fileKey = await cryptoEngine.deriveFileKey(masterKey, fileId);
        const plainBytes = new Uint8Array(await file.arrayBuffer());
        const encryptedBytes = await cryptoEngine.encryptBytes(fileKey, plainBytes);

        const encryptedFile = new File([encryptedBytes as BlobPart], `${fileId}.enc`, {
            type: 'application/octet-stream',
        });

        encryptedFiles.push({
            id: fileId,
            originalName: file.name,
            originalSize: file.size,
            originalType: file.type || 'application/octet-stream',
            encryptedFile,
        });

        manifestItems.push({
            id: fileId,
            fileName: file.name,
            sizeBytes: file.size,
            contentType: file.type || 'application/octet-stream',
        });
    }

    const encryptedManifest = await cryptoEngine.encryptJson(masterKey, manifestItems);

    return {
        files: encryptedFiles,
        encryptedManifest,
        keyEnvelope,
        keySalt: base64Url.encode(salt),
        kAuth,
    };
}
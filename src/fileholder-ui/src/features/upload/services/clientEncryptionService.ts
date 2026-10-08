import { cryptoEngine } from "../../../shared/utils/crypto/cryptoUtils";
import { zipUtils } from "../../../shared/utils/crypto/zipUtils";
import type { FileItemMetadata } from "../../download/types";

export interface PreparedEncryptedPayload {
    encryptedFileBlob: File;
    encryptedManifest: string;
    keyString: string;
    targetFileName: string;
    totalSizeBytes: number;
}

export async function prepareEncryptedBundle(
    files: File[]
): Promise<PreparedEncryptedPayload> {
    const key = await cryptoEngine.generateKey();
    const keyString = await cryptoEngine.exportKeyToBase64Url(key);

    let rawPayloadBytes: Uint8Array;
    if (files.length === 1) {
        rawPayloadBytes = new Uint8Array(await files[0].arrayBuffer());
    } else {
        rawPayloadBytes = await zipUtils.createZipFromFiles(files);
    }

    const encryptedPayload = await cryptoEngine.encryptBytes(key, rawPayloadBytes);

    const manifestData: FileItemMetadata[] = files.map((f) => ({ 
        id: crypto.randomUUID(),
        fileName: f.name,
        sizeBytes: f.size,
        contentType: f.type || 'application/octet-stream',
    }));

    const encryptedManifest = await cryptoEngine.encryptJson(key, manifestData);
    const targetFileName = files.length === 1 ? `${files[0].name}.enc` : 'fileGroup.zip.enc';

    const encryptedFileBlob = new File([encryptedPayload as BlobPart], targetFileName, {
        type: 'application/octet-stream',
    });

    return {
        encryptedFileBlob,
        encryptedManifest,
        keyString,
        targetFileName,
        totalSizeBytes: encryptedPayload.byteLength,
    };
}
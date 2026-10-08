import { cryptoEngine } from "../../../shared/utils/crypto/cryptoUtils";
import type { FileGroupMetadataResponse, FileItemMetadata } from "../types";

interface ManifestItemInput {
    id?: string;
    fileName?: string;
    sizeBytes: number;
    contentType?: string;
}

export class BundleDecryptionService {
    private keyCache = new Map<string, CryptoKey>();

    public extractKeyFromHash(): string | null {
        const hash = window.location.hash;
        const match = hash.match(/(?:^|[#&])key=([A-Za-z0-9_-]+)/);
        return match ? match[1] : null;
    }

    public async importKey(keyString: string): Promise<CryptoKey> {
        const cached = this.keyCache.get(keyString);
        if (cached) return cached;

        try {
            const key = await cryptoEngine.importKeyFromBase64Url(keyString);
            this.keyCache.set(keyString, key);
            return key;
        } catch (err: unknown) {
            throw new Error('Invalid cryptographic key format in share link.', { cause: err });
        }
    }

    public async hydrateEncryptedMetadata(
        rawMetadata: FileGroupMetadataResponse,
        keyString: string | null
    ): Promise<FileGroupMetadataResponse> {
        if (!rawMetadata.isEncrypted) {
            return rawMetadata;
        }

        if (!keyString) {
            throw new Error('This transfer is end-to-end encrypted, but no decryption key was found in the link fragment (#key=...).');
        }

        const key = await this.importKey(keyString);

        if (rawMetadata.requiresPassword && !rawMetadata.isUnlocked) {
            return rawMetadata;
        }

        if (rawMetadata.encryptedManifest) {
            let items: ManifestItemInput[];
            try {
                items = await cryptoEngine.decryptJson<ManifestItemInput[]>(key, rawMetadata.encryptedManifest);
            } catch (err: unknown) {
                if (err instanceof SyntaxError) {
                    throw new Error('Failed to parse decrypted metadata manifest.', { cause: err });
                }
                throw new Error('Decryption failed. Cryptographic authentication mismatch. The link key may be invalid or the data is corrupted.', { cause: err });
            }

            const decryptedFiles: FileItemMetadata[] = items.map((item) => ({
                id: item.id || crypto.randomUUID(),
                fileName: item.fileName || 'unnamed_file',
                sizeBytes: Number(item.sizeBytes) || 0,
                contentType: item.contentType || 'application/octet-stream',
            }));

            return {
                ...rawMetadata,
                files: decryptedFiles,
                fileCount: decryptedFiles.length,
                totalSizeBytes: decryptedFiles.reduce((acc, f) => acc + f.sizeBytes, 0),
            };
        }

        return rawMetadata;
    }

    public async decryptPayload(
        ciphertextBuffer: ArrayBuffer,
        key: CryptoKey
    ): Promise<Uint8Array> {
        if (ciphertextBuffer.byteLength < 28) {
            throw new Error('Encrypted payload is corrupted or truncated.');
        }

        try {
            return await cryptoEngine.decryptBytes(key, new Uint8Array(ciphertextBuffer));
        } catch (err: unknown) {
            throw new Error('Decryption failed: Cryptographic authentication mismatch. The link key may be invalid or the data is corrupted.', { cause: err });
        }
    }
}

export const bundleDecryptionService = new BundleDecryptionService();
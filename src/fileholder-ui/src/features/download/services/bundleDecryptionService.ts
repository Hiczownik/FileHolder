import { cryptoEngine, base64Url } from "../../../shared/utils/crypto/cryptoUtils";
import type { FileItemMetadata } from "../types";

export class BundleDecryptionService {
    private cachedMasterKey: CryptoKey | null = null;
    private cachedKAuth: string | null = null;
    private serverFileToManifestIdMap = new Map<string, string>();

    public setKAuth(shareToken: string, kAuth: string): void {
        this.cachedKAuth = kAuth;
        try {
            sessionStorage.setItem(`kauth_${shareToken}`, kAuth);
        } catch {
            // Ignore storage quota or disabled storage in private browsing
        }
    }

    public getKAuth(shareToken?: string): string | null {
        if (this.cachedKAuth) return this.cachedKAuth;
        if (shareToken) {
            try {
                const stored = sessionStorage.getItem(`kauth_${shareToken}`);
                if (stored) {
                    this.cachedKAuth = stored;
                    return stored;
                }
            } catch {
                // Ignore
            }
        }
        return null;
    }

    public registerFileMapping(serverFileId: string, manifestId: string): void {
        this.serverFileToManifestIdMap.set(serverFileId, manifestId);
    }

    public getManifestIdForServerFile(serverFileId: string): string {
        return this.serverFileToManifestIdMap.get(serverFileId) || serverFileId;
    }

    public async deriveKAuth(password: string, saltBase64Url: string, shareToken?: string): Promise<{ kAuth: string; kWrap: CryptoKey }> {
        const salt = base64Url.decode(saltBase64Url);
        const { kAuth, kWrap } = await cryptoEngine.deriveDualKeys(password, salt);
        if (shareToken) {
            this.setKAuth(shareToken, kAuth);
        } else {
            this.cachedKAuth = kAuth;
        }
        return { kAuth, kWrap };
    }

    public async unwrapMasterKey(envelopeBase64Url: string, kWrap: CryptoKey): Promise<CryptoKey> {
        const masterKey = await cryptoEngine.unwrapMasterKey(envelopeBase64Url, kWrap);
        this.cachedMasterKey = masterKey;
        return masterKey;
    }

    public async decryptManifest(encryptedManifest: string, masterKey?: CryptoKey): Promise<FileItemMetadata[]> {
        const key = masterKey || this.cachedMasterKey;
        if (!key) {
            throw new Error('Vault is locked. No master key available.');
        }

        try {
            return await cryptoEngine.decryptJson<FileItemMetadata[]>(key, encryptedManifest);
        } catch (err: unknown) {
            throw new Error('Decryption failed. Cryptographic authentication mismatch. The passkey may be incorrect or the data is corrupted.', { cause: err });
        }
    }

    public async decryptFile(ciphertextBuffer: ArrayBuffer, fileId: string): Promise<Uint8Array> {
        if (!this.cachedMasterKey) {
            throw new Error('Vault is locked.');
        }

        const fileKey = await cryptoEngine.deriveFileKey(this.cachedMasterKey, fileId);
        return cryptoEngine.decryptBytes(fileKey, new Uint8Array(ciphertextBuffer));
    }
}

export const bundleDecryptionService = new BundleDecryptionService();
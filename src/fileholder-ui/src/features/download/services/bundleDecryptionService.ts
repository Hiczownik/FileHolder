import { cryptoEngine, base64Url } from "../../../shared/utils/crypto/cryptoUtils";
import type { FileItemMetadata } from "../types";
import { isExtensionForbidden, makeFileNamesUnique, sanitizeFileName } from "../../../shared/utils/fileNameSafety";

const ENCRYPTED_FILE_SUFFIX = '.enc';
const MANIFEST_MISMATCH_MESSAGE = 'This encrypted bundle is inconsistent: its stored files do not match the encrypted manifest.';
const BLOCKED_FILES_MESSAGE = 'This encrypted bundle contains executable files or scripts, which FileHolder does not allow, so it cannot be opened.';

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

    /**
     * Pairs each decrypted manifest entry with its server file and registers the mapping used to
     * derive per-file keys. Encrypted files are uploaded as "{manifestId}.enc", so the pairing is by
     * that name. The server's file order is unrelated to upload order and must never be relied on.
     * Returns the files in manifest (upload) order, with server IDs, safe unique names and the real types.
     * Refuses the whole bundle if any name has a blocked extension, as the server does for plain bundles.
     */
    public mapManifestToServerFiles(manifestItems: FileItemMetadata[], serverFiles: FileItemMetadata[]): FileItemMetadata[] {
        const expectedServerName = (manifestId: string): string => `${manifestId}${ENCRYPTED_FILE_SUFFIX}`;
        const serverFilesByName = new Map(serverFiles.map((file) => [file.fileName, file]));
        const expectedNames = new Set(manifestItems.map((item) => expectedServerName(item.id)));

        if (expectedNames.size !== manifestItems.length) {
            throw new Error(`${MANIFEST_MISMATCH_MESSAGE} The manifest lists the same file more than once.`);
        }

        const missing = manifestItems.filter((item) => !serverFilesByName.has(expectedServerName(item.id)));
        if (missing.length > 0) {
            throw new Error(`${MANIFEST_MISMATCH_MESSAGE} Missing from storage: ${missing.map((item) => item.fileName).join(', ')}.`);
        }

        if (serverFilesByName.size !== serverFiles.length || serverFiles.some((file) => !expectedNames.has(file.fileName))) {
            throw new Error(`${MANIFEST_MISMATCH_MESSAGE} Storage holds files that are not in the manifest.`);
        }

        // The server never sees these names, so its file name rules are enforced here instead.
        const blocked = manifestItems.filter((item) => isExtensionForbidden(item.fileName));
        if (blocked.length > 0) {
            throw new Error(`${BLOCKED_FILES_MESSAGE} Blocked: ${blocked.map((item) => sanitizeFileName(item.fileName)).join(', ')}.`);
        }

        const safeNames = makeFileNamesUnique(manifestItems.map((item) => sanitizeFileName(item.fileName)));

        const mappedFiles = manifestItems.map((item, index) => {
            const serverFile = serverFilesByName.get(expectedServerName(item.id))!;
            return {
                id: serverFile.id,
                fileName: safeNames[index],
                sizeBytes: item.sizeBytes,
                contentType: item.contentType,
            };
        });

        mappedFiles.forEach((file, index) => this.registerFileMapping(file.id, manifestItems[index].id));
        return mappedFiles;
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
        try {
            return await cryptoEngine.decryptBytes(fileKey, new Uint8Array(ciphertextBuffer));
        } catch (err: unknown) {
            // WebCrypto reports an authentication failure as an OperationError with an empty message.
            throw new Error('Decryption failed. The file is corrupted or does not belong to this bundle.', { cause: err });
        }
    }
}

export const bundleDecryptionService = new BundleDecryptionService();
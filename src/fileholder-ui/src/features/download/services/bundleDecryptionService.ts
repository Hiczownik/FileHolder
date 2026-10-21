import { cryptoEngine, base64Url } from "../../../shared/utils/crypto/cryptoUtils";
import type { FileItemMetadata } from "../types";
import { createDecryptionStream, parseStreamParams, type StreamParams } from "../../../shared/utils/crypto/streamCipher";
import { isExtensionForbidden, makeFileNamesUnique, sanitizeFileName } from "../../../shared/utils/fileNameSafety";

const ENCRYPTED_FILE_SUFFIX = '.enc';
const MANIFEST_MISMATCH_MESSAGE = 'This encrypted bundle is inconsistent: its stored files do not match the encrypted manifest.';
const OLD_FORMAT_MESSAGE = 'This bundle was created with an older version of FileHolder and can no longer be opened. Ask the sender to share it again.';
const INVALID_STREAM_MESSAGE = 'This encrypted bundle has invalid encryption settings, so it cannot be opened.';
const BLOCKED_FILES_MESSAGE = 'This encrypted bundle contains executable files or scripts, which FileHolder does not allow, so it cannot be opened.';

export class BundleDecryptionService {
    private cachedMasterKey: CryptoKey | null = null;
    // Per share token: a kAuth sent to the wrong bundle is just a wrong guess that counts toward its lockout.
    private readonly kAuthByShareToken = new Map<string, string>();
    private serverFileToManifestIdMap = new Map<string, string>();
    // Chunked-encryption settings per manifest ID.
    private readonly streamParamsByManifestId = new Map<string, StreamParams>();

    public setKAuth(shareToken: string, kAuth: string): void {
        this.kAuthByShareToken.set(shareToken, kAuth);
        try {
            sessionStorage.setItem(`kauth_${shareToken}`, kAuth);
        } catch {
            // Ignore storage quota or disabled storage in private browsing
        }
    }

    public getKAuth(shareToken: string): string | null {
        const cached = this.kAuthByShareToken.get(shareToken);
        if (cached) return cached;

        try {
            const stored = sessionStorage.getItem(`kauth_${shareToken}`);
            if (stored) {
                this.kAuthByShareToken.set(shareToken, stored);
                return stored;
            }
        } catch {
            // Ignore
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

        // The uploader wrote these settings, so they are validated (e.g. chunk size bounds) before any download.
        // Entries without them come from bundles encrypted whole, a format no longer supported.
        if (manifestItems.some((item) => !item.stream)) {
            throw new Error(OLD_FORMAT_MESSAGE);
        }
        const streamParams = manifestItems.map((item) => {
            try {
                return parseStreamParams(item.stream!);
            } catch (err: unknown) {
                throw new Error(INVALID_STREAM_MESSAGE, { cause: err });
            }
        });

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
        streamParams.forEach((params, index) => this.streamParamsByManifestId.set(manifestItems[index].id, params));
        return mappedFiles;
    }

    public async deriveKAuth(password: string, saltBase64Url: string, shareToken: string): Promise<{ kAuth: string; kWrap: CryptoKey }> {
        const salt = base64Url.decode(saltBase64Url);
        const { kAuth, kWrap } = await cryptoEngine.deriveDualKeys(password, salt);
        this.setKAuth(shareToken, kAuth);
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

    /** Decrypts an encrypted bundle's title. It is authenticated with the same key as the manifest, so a failure means the same. */
    public async decryptTitle(encryptedTitle: string, masterKey?: CryptoKey): Promise<string> {
        const key = masterKey || this.cachedMasterKey;
        if (!key) {
            throw new Error('Vault is locked. No master key available.');
        }

        try {
            return await cryptoEngine.decryptJson<string>(key, encryptedTitle);
        } catch (err: unknown) {
            throw new Error('Decryption failed. Cryptographic authentication mismatch. The passkey may be incorrect or the data is corrupted.', { cause: err });
        }
    }

    /**
     * A transform that decrypts a file's downloaded ciphertext as it arrives, so the file never has to fit in
     * memory. `manifestId` must belong to a bundle mapped with mapManifestToServerFiles.
     */
    public async createDecryptionTransform(manifestId: string): Promise<TransformStream<Uint8Array, Uint8Array>> {
        if (!this.cachedMasterKey) {
            throw new Error('Vault is locked.');
        }

        const streamParams = this.streamParamsByManifestId.get(manifestId);
        if (!streamParams) {
            throw new Error(`No encryption settings for file ${manifestId}; unlock the bundle first.`);
        }
        return createDecryptionStream(await cryptoEngine.deriveFileKey(this.cachedMasterKey, manifestId), streamParams);
    }
}

export const bundleDecryptionService = new BundleDecryptionService();
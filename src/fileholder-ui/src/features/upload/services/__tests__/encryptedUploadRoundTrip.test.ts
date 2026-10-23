import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeEncryptedUploadWorkflow } from '../uploadWorkflow';
import { uploadApi } from '../../api/uploadApi';
import { BundleDecryptionService } from '../../../download/services/bundleDecryptionService';
import { STREAM_CHUNK_SIZE, STREAM_TAG_BYTES } from '../../../../shared/utils/crypto/streamCipher';
import { base64Url, cryptoEngine, type KeyDerivationResult } from '../../../../shared/utils/crypto/cryptoUtils';
import { LINK_KEY_PARAM } from '../../../../shared/utils/shareLink';
import type { ConfirmUploadRequest, PresignedItem } from '../../../download/types';

const PASSWORD = 'VaultPassword123!';
const SHARE_TOKEN = 'round_trip_token';
const ENCRYPTED_CHUNK = STREAM_CHUNK_SIZE + STREAM_TAG_BYTES;
// The real server switches to multipart at 50 MB and parts of at least 16 MiB; here anything over one chunk
// goes multipart in one-chunk parts, which keeps the test fast while still producing several parts. All the
// client relies on is that parts hold whole encrypted chunks.
const MULTIPART_THRESHOLD = STREAM_CHUNK_SIZE;
const PART_SIZE = ENCRYPTED_CHUNK;
const SMALL_FILE_BYTES = 1000;
const PARTIAL_TAIL = 123;
const FULL_CHUNKS_IN_LARGE_FILE = 2;
const LARGE_FILE_BYTES = FULL_CHUNKS_IN_LARGE_FILE * STREAM_CHUNK_SIZE + PARTIAL_TAIL; // 3 encrypted chunks, so 3 parts
const EXPECTED_PARTS = 3;
const PATTERN_MODULUS = 251;
const HEX_RADIX = 16;
const HEX_DIGITS = 2;
const EXPIRE_IN_HOURS = 24;
const MAX_DOWNLOADS = 5;
const SMALL_SEED = 1;
const LARGE_SEED = 2;
const FORM_VALUES = { title: 'Round Trip', expireInHours: EXPIRE_IN_HOURS, maxDownloads: MAX_DOWNLOADS, isEncrypted: true, requirePasskey: true, password: PASSWORD } as const;
// A share link ending in its link key: matches "/f/token#k=" plus 43 base64url characters; rejects "/f/token".
// https://regex101.com/?regex=%23k%3D%5BA-Za-z0-9_-%5D%7B43%7D%24&testString=%2Ff%2Ftoken%23k%3Dq3-_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
const LINK_KEY_FRAGMENT = new RegExp(`#${LINK_KEY_PARAM}=[A-Za-z0-9_-]{43}$`);

/** The link key, read from the share link's fragment as the recipient's browser does. */
const linkKeyOf = (shareLink: string): string =>
    new URLSearchParams(new URL(shareLink).hash.slice(1)).get(LINK_KEY_PARAM) ?? '';

/** The keys a recipient derives from the share link (and the passkey), plus what the server holds. */
const recipientKeys = (shareLink: string, confirm: ConfirmUploadRequest, passkey?: string): Promise<KeyDerivationResult> =>
    cryptoEngine.deriveLinkKeys(
        linkKeyOf(shareLink),
        base64Url.decode(confirm.keySalt ?? ''),
        // Stretched with the settings the uploader stored, as the recipient's browser does.
        passkey === undefined ? undefined : { passkey, kdfParams: confirm.kdfParams ?? '' }
    );

const patternFile = (name: string, size: number, seed: number): File =>
    new File([new Uint8Array(size).map((_, i) => (i + seed) % PATTERN_MODULUS)], name, { type: 'application/pdf' });

const sha256Hex = async (bytes: ArrayBuffer | Uint8Array): Promise<string> =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) => b.toString(HEX_RADIX).padStart(HEX_DIGITS, '0')).join('');

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    parts.reduce((offset, part) => {
        output.set(part, offset);
        return offset + part.byteLength;
    }, 0);
    return output;
};

// jsdom's Blob has no .stream(), so streams are built by hand.
const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start: (controller) => {
            controller.enqueue(bytes);
            controller.close();
        },
    });

const readAll = async (reader: ReadableStreamDefaultReader<Uint8Array>, parts: Uint8Array[]): Promise<Uint8Array> => {
    const { done, value } = await reader.read();
    if (!done) {
        parts.push(value);
        return readAll(reader, parts);
    }
    return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
};

/** Stands in for the API and storage, keeping every byte the client sends, by storage key. */
const createFakeBackend = (partSize: number) => {
    const presignedSizes = new Map<string, number>();
    const stored = new Map<string, Uint8Array>();
    const partsByUpload = new Map<string, Map<number, Uint8Array>>();
    const confirmed: ConfirmUploadRequest[] = [];

    vi.spyOn(uploadApi, 'getPresignedUrl').mockImplementation(async (request) => ({
        uploadToken: 'upload_token',
        items: request.files.map((file, i): PresignedItem => {
            const storageKey = `uploads/${i}.enc`;
            presignedSizes.set(storageKey, file.sizeBytes);
            return file.sizeBytes > MULTIPART_THRESHOLD
                ? { fileName: file.fileName, storageKey, uploadMode: 'Multipart', uploadId: storageKey, partSizeBytes: partSize, totalParts: Math.ceil(file.sizeBytes / partSize) }
                : { fileName: file.fileName, storageKey, uploadMode: 'Single', uploadUrl: `single://${storageKey}` };
        }),
    }));
    vi.spyOn(uploadApi, 'uploadDirectToS3').mockImplementation(async (url, blob) => {
        stored.set(url.replace('single://', ''), new Uint8Array(await blob.arrayBuffer()));
    });
    vi.spyOn(uploadApi, 'presignPartBatch').mockImplementation(async (request) => ({
        parts: Array.from({ length: request.count }, (_, i) => ({
            partNumber: request.startPartNumber + i,
            uploadUrl: `part://${request.uploadId}#${request.startPartNumber + i}`,
        })),
    }));
    vi.spyOn(uploadApi, 'uploadMultipartChunkDirectToS3').mockImplementation(async (url, blob) => {
        const [uploadId, partNumber] = url.replace('part://', '').split('#');
        const parts = partsByUpload.get(uploadId) ?? new Map<number, Uint8Array>();
        parts.set(Number(partNumber), new Uint8Array(await blob.arrayBuffer()));
        partsByUpload.set(uploadId, parts);
        return `etag-${partNumber}`;
    });
    vi.spyOn(uploadApi, 'completeMultipartUpload').mockImplementation(async (request) => {
        const parts = partsByUpload.get(request.uploadId)!;
        stored.set(request.storageKey, concat(request.parts.map((part) => parts.get(part.partNumber)!)));
        return true;
    });
    vi.spyOn(uploadApi, 'confirmUpload').mockImplementation(async (request) => {
        confirmed.push(request);
        return SHARE_TOKEN;
    });

    return { presignedSizes, stored, partsByUpload, confirmed };
};

describe('encrypted upload round trip', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('uploads chunk-encrypted files, single and multipart, that the download path decrypts back exactly', async () => {
        const backend = createFakeBackend(PART_SIZE);
        const originals = [patternFile('small.pdf', SMALL_FILE_BYTES, SMALL_SEED), patternFile('large.pdf', LARGE_FILE_BYTES, LARGE_SEED)];

        const shareLink = await executeEncryptedUploadWorkflow(FORM_VALUES, originals, vi.fn());

        // What was sent must be exactly what was presigned: the upload URLs are signed for those sizes.
        const confirm = backend.confirmed[0];
        confirm.files.forEach((file) => {
            expect(backend.stored.get(file.storageKey)!.byteLength).toBe(backend.presignedSizes.get(file.storageKey));
            expect(file.sizeBytes).toBe(backend.presignedSizes.get(file.storageKey));
        });
        expect(backend.partsByUpload.get('uploads/1.enc')!.size).toBe(EXPECTED_PARTS);

        // Now open the bundle the way a recipient does, from only what the server would hold.
        expect(confirm.keyMode).toBe('LinkKeyAndPasskey');
        expect(shareLink).toMatch(LINK_KEY_FRAGMENT);
        const recipient = new BundleDecryptionService();
        const { kAuth, kWrap } = await recipientKeys(shareLink, confirm, PASSWORD);
        expect(kAuth).toBe(confirm.password);
        const masterKey = await recipient.unwrapMasterKey(confirm.keyEnvelope!, kWrap);
        const manifest = await recipient.decryptManifest(confirm.encryptedManifest!, masterKey);
        const serverFiles = confirm.files.map((file) => ({ id: file.storageKey, fileName: file.fileName, sizeBytes: file.sizeBytes, contentType: file.contentType }));
        const mapped = recipient.mapManifestToServerFiles(manifest, serverFiles);

        expect(mapped.map((file) => file.fileName)).toEqual(['small.pdf', 'large.pdf']);
        const decrypted = await Promise.all(mapped.map(async (file) => {
            const decryption = await recipient.createDecryptionTransform(recipient.getManifestIdForServerFile(file.id));
            return readAll(streamOf(backend.stored.get(file.id)!).pipeThrough(decryption).getReader(), []);
        }));
        const expectedDigests = await Promise.all(originals.map(async (file) => sha256Hex(await file.arrayBuffer())));
        expect(await Promise.all(decrypted.map((bytes) => sha256Hex(bytes)))).toEqual(expectedDigests);
    });

    // Issue #65: an encrypted bundle's title is as private as its files, so the server only ever gets it encrypted.
    it('never sends the title in plain text, and the recipient decrypts it back after unlocking', async () => {
        const backend = createFakeBackend(PART_SIZE);

        const shareLink = await executeEncryptedUploadWorkflow({ ...FORM_VALUES, title: '  Tax return 2026  ' }, [patternFile('small.pdf', SMALL_FILE_BYTES, SMALL_SEED)], vi.fn());

        const presignRequest = vi.mocked(uploadApi.getPresignedUrl).mock.calls[0][0];
        const confirm = backend.confirmed[0];
        expect(presignRequest.title).toBeUndefined();
        expect(confirm.title).toBeUndefined();
        expect(JSON.stringify([presignRequest, confirm])).not.toContain('Tax return');

        const recipient = new BundleDecryptionService();
        const { kWrap } = await recipientKeys(shareLink, confirm, PASSWORD);
        const masterKey = await recipient.unwrapMasterKey(confirm.keyEnvelope!, kWrap);
        expect(await recipient.decryptTitle(confirm.encryptedTitle!, masterKey)).toBe('Tax return 2026');
    });

    // Issue #61: by default the link alone opens the bundle, and its key never reaches the server.
    it('opens a link-only bundle with just the share link, which carries a key the server never receives', async () => {
        const backend = createFakeBackend(PART_SIZE);
        const original = patternFile('small.pdf', SMALL_FILE_BYTES, SMALL_SEED);

        // A password typed before the passkey was turned off must not end up protecting the bundle.
        const shareLink = await executeEncryptedUploadWorkflow({ ...FORM_VALUES, requirePasskey: false }, [original], vi.fn());

        const confirm = backend.confirmed[0];
        expect(confirm.keyMode).toBe('LinkKey');
        expect(shareLink).toContain(`/f/${SHARE_TOKEN}#`);
        expect(shareLink).toMatch(LINK_KEY_FRAGMENT);
        const presignRequest = vi.mocked(uploadApi.getPresignedUrl).mock.calls[0][0];
        expect(JSON.stringify([presignRequest, confirm])).not.toContain(linkKeyOf(shareLink));

        const recipient = new BundleDecryptionService();
        const { kAuth, kWrap } = await recipientKeys(shareLink, confirm);
        expect(kAuth).toBe(confirm.password);
        const masterKey = await recipient.unwrapMasterKey(confirm.keyEnvelope!, kWrap);
        const serverFiles = confirm.files.map((file) => ({ id: file.storageKey, fileName: file.fileName, sizeBytes: file.sizeBytes, contentType: file.contentType }));
        const [file] = recipient.mapManifestToServerFiles(await recipient.decryptManifest(confirm.encryptedManifest!, masterKey), serverFiles);
        const decryption = await recipient.createDecryptionTransform(recipient.getManifestIdForServerFile(file.id));
        const decrypted = await readAll(streamOf(backend.stored.get(file.id)!).pipeThrough(decryption).getReader(), []);
        expect(await sha256Hex(decrypted)).toBe(await sha256Hex(await original.arrayBuffer()));
    });

    it('needs the passkey as well as the link when the bundle requires one', async () => {
        const backend = createFakeBackend(PART_SIZE);

        const shareLink = await executeEncryptedUploadWorkflow(FORM_VALUES, [patternFile('small.pdf', SMALL_FILE_BYTES, SMALL_SEED)], vi.fn());

        const confirm = backend.confirmed[0];
        const withoutPasskey = await recipientKeys(shareLink, confirm);
        const wrongPasskey = await recipientKeys(shareLink, confirm, `${PASSWORD}x`);
        expect([withoutPasskey.kAuth, wrongPasskey.kAuth]).not.toContain(confirm.password);
        await expect(cryptoEngine.unwrapMasterKey(confirm.keyEnvelope!, withoutPasskey.kWrap)).rejects.toThrow();
        await expect(cryptoEngine.unwrapMasterKey(confirm.keyEnvelope!, wrongPasskey.kWrap)).rejects.toThrow();
    });

    it('refuses to start when a passkey is required but missing', async () => {
        const backend = createFakeBackend(PART_SIZE);

        await expect(executeEncryptedUploadWorkflow({ ...FORM_VALUES, password: '' }, [patternFile('small.pdf', SMALL_FILE_BYTES, SMALL_SEED)], vi.fn()))
            .rejects.toThrow('Enter a passkey');
        expect(uploadApi.getPresignedUrl).not.toHaveBeenCalled();
        expect(backend.confirmed).toHaveLength(0);
    });

    it('sends no encrypted title when the bundle has none', async () => {
        const backend = createFakeBackend(PART_SIZE);

        await executeEncryptedUploadWorkflow({ ...FORM_VALUES, title: '   ' }, [patternFile('small.pdf', SMALL_FILE_BYTES, SMALL_SEED)], vi.fn());

        expect(backend.confirmed[0].encryptedTitle).toBeUndefined();
    });

    it('refuses to upload anything when the server sizes parts for a different chunk size', async () => {
        const backend = createFakeBackend(PART_SIZE + 1);

        await expect(executeEncryptedUploadWorkflow(FORM_VALUES, [patternFile('large.pdf', LARGE_FILE_BYTES, LARGE_SEED)], vi.fn()))
            .rejects.toThrow('different encryption chunk size');

        expect(uploadApi.uploadMultipartChunkDirectToS3).not.toHaveBeenCalled();
        expect(uploadApi.uploadDirectToS3).not.toHaveBeenCalled();
        expect(backend.confirmed).toHaveLength(0);
    });
});

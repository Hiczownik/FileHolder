import { describe, it, expect } from 'vitest';
import { BundleDecryptionService } from '../bundleDecryptionService';
import type { FileItemMetadata } from '../../types';

const FILE_SIZE_BYTES = 1024;
const ENCRYPTED_SIZE_BYTES = 1052;

const manifestItem = (id: string, fileName: string): FileItemMetadata => ({
    id,
    fileName,
    sizeBytes: FILE_SIZE_BYTES,
    contentType: 'text/plain',
});

const serverFile = (serverId: string, manifestId: string): FileItemMetadata => ({
    id: serverId,
    fileName: `${manifestId}.enc`,
    sizeBytes: ENCRYPTED_SIZE_BYTES,
    contentType: 'application/octet-stream',
});

const manifest = [manifestItem('uuid-a', 'a.txt'), manifestItem('uuid-b', 'b.txt')];

describe('BundleDecryptionService.mapManifestToServerFiles', () => {
    it('pairs files by their "{manifestId}.enc" name and keeps manifest order', () => {
        const service = new BundleDecryptionService();

        const mapped = service.mapManifestToServerFiles(manifest, [serverFile('srv-a', 'uuid-a'), serverFile('srv-b', 'uuid-b')]);

        expect(mapped).toEqual([
            { id: 'srv-a', fileName: 'a.txt', sizeBytes: FILE_SIZE_BYTES, contentType: 'text/plain' },
            { id: 'srv-b', fileName: 'b.txt', sizeBytes: FILE_SIZE_BYTES, contentType: 'text/plain' },
        ]);
    });

    it('pairs correctly when the server returns files in a different order', () => {
        const service = new BundleDecryptionService();

        const mapped = service.mapManifestToServerFiles(manifest, [serverFile('srv-b', 'uuid-b'), serverFile('srv-a', 'uuid-a')]);

        expect(mapped.map((file) => [file.id, file.fileName])).toEqual([['srv-a', 'a.txt'], ['srv-b', 'b.txt']]);
        expect(service.getManifestIdForServerFile('srv-a')).toBe('uuid-a');
        expect(service.getManifestIdForServerFile('srv-b')).toBe('uuid-b');
    });

    it('rejects a manifest entry whose file is missing from storage', () => {
        const service = new BundleDecryptionService();

        expect(() => service.mapManifestToServerFiles(manifest, [serverFile('srv-a', 'uuid-a')]))
            .toThrow('Missing from storage: b.txt.');
    });

    it('rejects a stored file that is not in the manifest', () => {
        const service = new BundleDecryptionService();
        const storedFiles = [serverFile('srv-a', 'uuid-a'), serverFile('srv-b', 'uuid-b'), serverFile('srv-x', 'uuid-x')];

        expect(() => service.mapManifestToServerFiles(manifest, storedFiles))
            .toThrow('Storage holds files that are not in the manifest.');
    });

    it('rejects a manifest that lists the same file twice', () => {
        const service = new BundleDecryptionService();
        const duplicated = [manifestItem('uuid-a', 'a.txt'), manifestItem('uuid-a', 'copy.txt')];

        expect(() => service.mapManifestToServerFiles(duplicated, [serverFile('srv-a', 'uuid-a')]))
            .toThrow('The manifest lists the same file more than once.');
    });

    it('reduces a manifest name that climbs out of the folder to its last segment', () => {
        const service = new BundleDecryptionService();
        const climbing = [manifestItem('uuid-a', '../../AppData/Roaming/Startup/notes.txt')];

        const mapped = service.mapManifestToServerFiles(climbing, [serverFile('srv-a', 'uuid-a')]);

        expect(mapped[0].fileName).toBe('notes.txt');
    });

    it('gives files whose names collide distinct names, so none overwrites another in the ZIP', () => {
        const service = new BundleDecryptionService();
        const colliding = [manifestItem('uuid-a', 'one/report.pdf'), manifestItem('uuid-b', 'two/Report.pdf')];

        const mapped = service.mapManifestToServerFiles(colliding, [serverFile('srv-a', 'uuid-a'), serverFile('srv-b', 'uuid-b')]);

        expect(mapped.map((file) => file.fileName)).toEqual(['report.pdf', 'Report (2).pdf']);
    });

    it('refuses a bundle whose manifest holds a blocked extension, and registers no mappings', () => {
        const service = new BundleDecryptionService();
        const withExecutable = [manifestItem('uuid-a', 'a.txt'), manifestItem('uuid-b', 'invoice.pdf.exe')];

        expect(() => service.mapManifestToServerFiles(withExecutable, [serverFile('srv-a', 'uuid-a'), serverFile('srv-b', 'uuid-b')]))
            .toThrow('Blocked: invoice.pdf.exe.');
        expect(service.getManifestIdForServerFile('srv-a')).toBe('srv-a');
    });

    it('registers no mappings when the bundle is inconsistent', () => {
        const service = new BundleDecryptionService();

        expect(() => service.mapManifestToServerFiles(manifest, [serverFile('srv-a', 'uuid-a')])).toThrow();
        expect(service.getManifestIdForServerFile('srv-a')).toBe('srv-a');
    });
});

describe('BundleDecryptionService kAuth', () => {
    it('keeps the kAuth of each bundle to itself', () => {
        const service = new BundleDecryptionService();
        sessionStorage.removeItem('kauth_bundle_b');

        service.setKAuth('bundle_a', 'kauth-for-a');

        expect(service.getKAuth('bundle_a')).toBe('kauth-for-a');
        expect(service.getKAuth('bundle_b')).toBeNull();
    });
});

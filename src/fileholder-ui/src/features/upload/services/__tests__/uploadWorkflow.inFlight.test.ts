import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeEncryptedUploadWorkflow } from '../uploadWorkflow';
import { uploadApi } from '../../api/uploadApi';
import type { PresignedItem } from '../../../download/types';

const FILE_COUNT = 10;
const FILE_BYTES = 2048;
const UPLOAD_DELAY_MS = 5;
// MAX_PARTS_IN_FLIGHT in uploadWorkflow.ts.
const MAX_PARTS_IN_FLIGHT = 4;
const EXPIRE_IN_HOURS = 24;
const MAX_DOWNLOADS = 5;
const FORM_VALUES = { title: 'Many Files', expireInHours: EXPIRE_IN_HOURS, maxDownloads: MAX_DOWNLOADS, isEncrypted: true, password: 'VaultPassword123!' } as const;

describe('encrypted upload of many files', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('encrypts and sends only a few files at a time, however many the bundle has', async () => {
        vi.spyOn(uploadApi, 'getPresignedUrl').mockImplementation(async (request) => ({
            uploadToken: 'upload_token',
            items: request.files.map((file, i): PresignedItem => ({
                fileName: file.fileName, storageKey: `uploads/${i}.enc`, uploadMode: 'Single', uploadUrl: `single://${i}`,
            })),
        }));
        let inFlight = 0;
        let maxInFlight = 0;
        vi.spyOn(uploadApi, 'uploadDirectToS3').mockImplementation(async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, UPLOAD_DELAY_MS));
            inFlight--;
        });
        vi.spyOn(uploadApi, 'confirmUpload').mockResolvedValue('share_token');
        const files = Array.from({ length: FILE_COUNT }, (_, i) => new File([new Uint8Array(FILE_BYTES)], `file${i}.bin`));

        await executeEncryptedUploadWorkflow(FORM_VALUES, files, vi.fn());

        expect(uploadApi.uploadDirectToS3).toHaveBeenCalledTimes(FILE_COUNT);
        expect(maxInFlight).toBe(MAX_PARTS_IN_FLIGHT);
    });
});

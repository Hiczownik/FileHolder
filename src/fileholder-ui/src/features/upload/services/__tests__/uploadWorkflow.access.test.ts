import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stubUploadLimits } from '../../../../test/uploadLimits';
import { executeEncryptedUploadWorkflow, executeStandardUploadWorkflow } from '../uploadWorkflow';
import { uploadApi } from '../../api/uploadApi';
import { DEFAULT_UPLOAD_LIMITS } from '../uploadLimits';
import type { CreatePresignedUrlRequest, PresignedItem } from '../../../download/types';

const CODE = 'a03-7F3K-9Q2M-X8PD';
const WITHOUT_CODE_BYTES = 10;
const WITH_CODE_BYTES = 100;
const FILE_BYTES = 20;
const MAX_DOWNLOADS = 5;
const FORM_VALUES = { title: 'Access', expireInHours: 1, maxDownloads: MAX_DOWNLOADS, isEncrypted: false, password: '' } as const;

const fileOf = (bytes: number): File => new File(['x'.repeat(bytes)], 'file.txt', { type: 'text/plain' });

describe('an upload with an access code (#169)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        stubUploadLimits({ ...DEFAULT_UPLOAD_LIMITS, maxBundleSizeBytes: WITHOUT_CODE_BYTES, accessCodesEnabled: true });
        vi.spyOn(uploadApi, 'getPresignedUrl').mockImplementation(async (request: CreatePresignedUrlRequest) => ({
            uploadToken: 'upload_token',
            items: request.files.map((file, i): PresignedItem =>
                ({ fileName: file.fileName, storageKey: `uploads/${i}`, uploadMode: 'Single', uploadUrl: `single://${i}` })),
        }));
        vi.spyOn(uploadApi, 'uploadDirectToS3').mockResolvedValue(undefined);
        vi.spyOn(uploadApi, 'confirmUpload').mockResolvedValue('share_token');
    });

    it("refuses a bundle over the limits without a code before anything is sent", async () => {
        await expect(executeStandardUploadWorkflow(FORM_VALUES, [fileOf(FILE_BYTES)], vi.fn())).rejects
            .toThrow('The bundle cannot be larger than 10 Bytes in total; these files add up to 20 Bytes. An access code allows more.');

        expect(uploadApi.getPresignedUrl).not.toHaveBeenCalled();
    });

    it("sends the code with presign, and allows the code's larger bundle", async () => {
        await executeStandardUploadWorkflow(FORM_VALUES, [fileOf(FILE_BYTES)], vi.fn(), undefined,
            { accessCode: CODE, maxBundleSizeBytes: WITH_CODE_BYTES });

        expect(uploadApi.getPresignedUrl).toHaveBeenCalledWith(expect.objectContaining({ accessCode: CODE }));
        // Confirm needs no code: the server kept what presign allowed.
        expect(uploadApi.confirmUpload).toHaveBeenCalledWith(expect.not.objectContaining({ accessCode: expect.anything() }));
    });

    it('sends the code with an encrypted bundle too', async () => {
        await executeEncryptedUploadWorkflow({ ...FORM_VALUES, isEncrypted: true }, [fileOf(FILE_BYTES)], vi.fn(), undefined,
            { accessCode: CODE, maxBundleSizeBytes: WITH_CODE_BYTES });

        expect(uploadApi.getPresignedUrl).toHaveBeenCalledWith(expect.objectContaining({ accessCode: CODE }));
    });

    it('sends no code without one', async () => {
        await executeStandardUploadWorkflow(FORM_VALUES, [fileOf(WITHOUT_CODE_BYTES)], vi.fn());

        expect(uploadApi.getPresignedUrl).toHaveBeenCalledWith(expect.objectContaining({ accessCode: undefined }));
    });
});

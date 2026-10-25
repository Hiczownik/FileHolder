import { vi } from 'vitest';
import { uploadApi } from '../features/upload/api/uploadApi';
import { DEFAULT_UPLOAD_LIMITS, forgetUploadLimits, type UploadLimits } from '../features/upload/services/uploadLimits';

/**
 * Answers the upload workflow's limits request without a server, so a test never depends on whatever API happens
 * to run on localhost:8080. Call after vi.restoreAllMocks(), which would undo it.
 */
export function stubUploadLimits(limits: UploadLimits = DEFAULT_UPLOAD_LIMITS): void {
    forgetUploadLimits();
    vi.spyOn(uploadApi, 'getLimits').mockResolvedValue(limits);
}

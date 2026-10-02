import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFileUpload } from '../useFileUpload';
import { uploadApi } from '../../api/uploadApi';

describe('useFileUpload Hook (Vertical Slice)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const createDummyFile = (name: string, size: number): File => {
    const file = new File(['x'.repeat(size)], name, { type: 'text/plain' });
    Object.defineProperty(file, 'size', { value: size });
    return file;
  };

  it('starts in idle state', () => {
    const { result } = renderHook(() => useFileUpload());

    expect(result.current.uploadState).toEqual({ status: 'idle' });
  });

  it('transitions to success state with share link upon successful upload flow', async () => {
    vi.spyOn(uploadApi, 'getPresignedUrl').mockResolvedValue({
      uploadToken: 'token_123',
      items: [{ fileName: 'doc.txt', uploadUrl: 'http://test.url', storageKey: 'uploads/key' }],
    });
    vi.spyOn(uploadApi, 'uploadDirectToS3').mockResolvedValue();
    vi.spyOn(uploadApi, 'confirmUpload').mockResolvedValue('share_abc');

    const { result } = renderHook(() => useFileUpload());
    const file = createDummyFile('doc.txt', 100);

    await act(async () => {
      await result.current.upload(
        { title: 'Test Bundle', expireInHours: 24, maxDownloads: 5 },
        [file]
      );
    });

    expect(result.current.uploadState.status).toBe('success');
    if (result.current.uploadState.status === 'success') {
      expect(result.current.uploadState.shareLink).toContain('/f/share_abc');
    }
  });

  it('encrypts payload and manifest without leaking raw key to confirmUpload when isEncrypted is true', async () => {
    vi.spyOn(uploadApi, 'getPresignedUrl').mockResolvedValue({
      uploadToken: 'token_enc_123',
      items: [{ fileName: 'fileGroup.enc', uploadUrl: 'http://test.url/enc', storageKey: 'uploads/enc_key' }],
    });
    vi.spyOn(uploadApi, 'uploadDirectToS3').mockResolvedValue();
    const confirmUploadSpy = vi.spyOn(uploadApi, 'confirmUpload').mockResolvedValue('share_enc_abc');

    const { result } = renderHook(() => useFileUpload());
    const file1 = createDummyFile('doc1.txt', 50);
    const file2 = createDummyFile('doc2.txt', 50);

    await act(async () => {
      await result.current.upload(
        { title: 'Encrypted Vault', expireInHours: 24, maxDownloads: 5, isEncrypted: true },
        [file1, file2]
      );
    });

    expect(result.current.uploadState.status).toBe('success');
    if (result.current.uploadState.status === 'success') {
      expect(result.current.uploadState.shareLink).toContain('/f/share_enc_abc#key=');

      const hashKey = result.current.uploadState.shareLink.split('#key=')[1];
      expect(hashKey).toBeDefined();
      expect(hashKey.length).toBeGreaterThan(10);

      expect(confirmUploadSpy).toHaveBeenCalledTimes(1);
      const confirmArg = confirmUploadSpy.mock.calls[0][0];
      expect(confirmArg.isEncrypted).toBe(true);
      expect(confirmArg.encryptedManifest).toBeDefined();
      expect(typeof confirmArg.encryptedManifest).toBe('string');
      expect(confirmArg.encryptedManifest).not.toBe(hashKey);
    }
  });

  it('transitions to error state with sanitized message on API failure', async () => {
    vi.spyOn(uploadApi, 'getPresignedUrl').mockRejectedValue(new Error('Network failure'));

    const { result } = renderHook(() => useFileUpload());
    const file = createDummyFile('doc.txt', 100);

    await act(async () => {
      await result.current.upload(
        { title: 'Test Bundle', expireInHours: 24, maxDownloads: 5 },
        [file]
      );
    });

    expect(result.current.uploadState.status).toBe('error');
    if (result.current.uploadState.status === 'error') {
      expect(result.current.uploadState.message).toBe('Network failure');
    }
  });

  it('resets state back to idle when reset is called', () => {
    const { result } = renderHook(() => useFileUpload());

    act(() => {
      result.current.reset();
    });

    expect(result.current.uploadState).toEqual({ status: 'idle' });
  });
});
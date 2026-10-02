import { describe, it, expect } from 'vitest';
import { cryptoEngine } from '../cryptoUtils';

describe('Web Crypto Zero-Knowledge Engine', () => {
  it('generates, exports to Base64URL, and re-imports an identical AES-GCM key', async () => {
    const key = await cryptoEngine.generateKey();
    const exportedKey = await cryptoEngine.exportKeyToBase64Url(key);

    expect(typeof exportedKey).toBe('string');
    expect(exportedKey).not.toContain('+');
    expect(exportedKey).not.toContain('/');
    expect(exportedKey).not.toContain('=');

    const importedKey = await cryptoEngine.importKeyFromBase64Url(exportedKey);
    expect(importedKey).toBeDefined();
    expect(importedKey.algorithm.name).toBe('AES-GCM');
  });

  it('encrypts and decrypts binary payloads cleanly with authentication verification', async () => {
    const key = await cryptoEngine.generateKey();
    const originalText = 'Top Secret Confidential Document Payload 2026';
    const originalBytes = new TextEncoder().encode(originalText);

    const encrypted = await cryptoEngine.encryptBytes(key, originalBytes);
    expect(encrypted.byteLength).toBe(12 + originalBytes.byteLength + 16); 

    const decrypted = await cryptoEngine.decryptBytes(key, encrypted);
    const decryptedText = new TextDecoder().decode(decrypted);

    expect(decryptedText).toBe(originalText);
  });

  it('rejects tampered ciphertext with an authentication error', async () => {
    const key = await cryptoEngine.generateKey();
    const originalBytes = new TextEncoder().encode('Unadulterated Data');
    const encrypted = await cryptoEngine.encryptBytes(key, originalBytes);

    encrypted[15] ^= 0xff;

    await expect(cryptoEngine.decryptBytes(key, encrypted)).rejects.toThrow();
  });

  it('encrypts and decrypts structured metadata JSON manifests', async () => {
    const key = await cryptoEngine.generateKey();
    const manifest = [
      { fileName: 'taxes.pdf', sizeBytes: 1048576, contentType: 'application/pdf' },
      { fileName: 'w2.png', sizeBytes: 512000, contentType: 'image/png' },
    ];

    const encryptedBase64 = await cryptoEngine.encryptJson(key, manifest);
    expect(typeof encryptedBase64).toBe('string');

    const decryptedManifest = await cryptoEngine.decryptJson<typeof manifest>(key, encryptedBase64);
    expect(decryptedManifest).toEqual(manifest);
  });
});
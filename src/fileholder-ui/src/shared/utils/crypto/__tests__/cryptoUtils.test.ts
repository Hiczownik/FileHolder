import { describe, it, expect } from 'vitest';
import { cryptoEngine } from '../cryptoUtils';

describe('Zero-Knowledge Password Envelope Encryption Engine', () => {
  it('1. Generates salt, derives dual keys (kAuth, kWrap), and executes key wrapping/unwrapping', async () => {
    const password = 'SuperSecretVaultPassphrase123!';
    const salt = cryptoEngine.generateSalt();

    expect(salt).toHaveLength(16);

    const { kAuth, kWrap } = await cryptoEngine.deriveDualKeys(password, salt);
    expect(typeof kAuth).toBe('string');
    expect(kAuth.length).toBeGreaterThan(16);
    expect(kWrap.algorithm.name).toBe('AES-GCM');

    const masterKey = await cryptoEngine.generateKey();
    const keyEnvelope = await cryptoEngine.wrapMasterKey(masterKey, kWrap);
    expect(typeof keyEnvelope).toBe('string');

    const unwrappedMasterKey = await cryptoEngine.unwrapMasterKey(keyEnvelope, kWrap);
    expect(unwrappedMasterKey).toBeDefined();

    // Verify unwrapped key can encrypt and decrypt data
    const plain = new TextEncoder().encode('Test Secret');
    const encrypted = await cryptoEngine.encryptBytes(unwrappedMasterKey, plain);
    const decrypted = await cryptoEngine.decryptBytes(masterKey, encrypted);
    expect(new TextDecoder().decode(decrypted)).toBe('Test Secret');
  });

  it('2. Rejects master key unwrapping when wrong wrap key is used', async () => {
    const salt = cryptoEngine.generateSalt();
    const { kWrap: kWrap1 } = await cryptoEngine.deriveDualKeys('PasswordA', salt);
    const { kWrap: kWrap2 } = await cryptoEngine.deriveDualKeys('PasswordB', salt);

    const masterKey = await cryptoEngine.generateKey();
    const keyEnvelope = await cryptoEngine.wrapMasterKey(masterKey, kWrap1);

    await expect(cryptoEngine.unwrapMasterKey(keyEnvelope, kWrap2)).rejects.toThrow();
  });

  it('3. Derives unique per-file keys from master key via HKDF', async () => {
    const masterKey = await cryptoEngine.generateKey();
    const fileIdA = 'file-id-aaa';
    const fileIdB = 'file-id-bbb';

    const fileKeyA = await cryptoEngine.deriveFileKey(masterKey, fileIdA);
    const fileKeyB = await cryptoEngine.deriveFileKey(masterKey, fileIdB);

    const payload = new TextEncoder().encode('Confidential Document');
    const encryptedWithA = await cryptoEngine.encryptBytes(fileKeyA, payload);

    // Cross-decryption with key B must fail
    await expect(cryptoEngine.decryptBytes(fileKeyB, encryptedWithA)).rejects.toThrow();

    // Decryption with key A must succeed
    const decryptedWithA = await cryptoEngine.decryptBytes(fileKeyA, encryptedWithA);
    expect(new TextDecoder().decode(decryptedWithA)).toBe('Confidential Document');
  });
});
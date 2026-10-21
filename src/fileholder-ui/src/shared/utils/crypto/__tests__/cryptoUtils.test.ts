import { describe, it, expect } from 'vitest';
import { cryptoEngine, isWellFormedLinkKey } from '../cryptoUtils';

// Any 32-byte key (link key or kAuth) as unpadded base64url.
const KEY_BASE64URL_LENGTH = 43;
const LINK_KEY_BYTES = 32;
const SALT_BYTES = 16;

/** Whether `kWrap` unwraps an envelope made with `wrappedWith`, i.e. whether the two are the same key. */
const unwraps = async (wrappedWith: CryptoKey, kWrap: CryptoKey): Promise<boolean> => {
  const envelope = await cryptoEngine.wrapMasterKey(await cryptoEngine.generateKey(), wrappedWith);
  try {
    await cryptoEngine.unwrapMasterKey(envelope, kWrap);
    return true;
  } catch {
    return false;
  }
};

describe('link keys (#61)', () => {
  it('generates 32 random bytes as 43 base64url characters', () => {
    const linkKey = cryptoEngine.generateLinkKey();

    expect(linkKey).toHaveLength(KEY_BASE64URL_LENGTH);
    expect(isWellFormedLinkKey(linkKey)).toBe(true);
    expect(cryptoEngine.base64Url.decode(linkKey)).toHaveLength(LINK_KEY_BYTES);
    expect(cryptoEngine.generateLinkKey()).not.toBe(linkKey);
  });

  it('tells well-formed link keys from truncated or altered ones', () => {
    const linkKey = cryptoEngine.generateLinkKey();

    expect(isWellFormedLinkKey(linkKey.slice(0, -1))).toBe(false);
    expect(isWellFormedLinkKey(`${linkKey}A`)).toBe(false);
    expect(isWellFormedLinkKey(`${linkKey.slice(0, -1)}+`)).toBe(false);
    expect(isWellFormedLinkKey('')).toBe(false);
  });

  it('derives the same keys every time for the same inputs, in both modes', async () => {
    const linkKey = cryptoEngine.generateLinkKey();
    const salt = cryptoEngine.generateSalt();

    const linkOnly = [await cryptoEngine.deriveLinkKeys(linkKey, salt), await cryptoEngine.deriveLinkKeys(linkKey, salt)];
    const withPasskey = [await cryptoEngine.deriveLinkKeys(linkKey, salt, 'pass'), await cryptoEngine.deriveLinkKeys(linkKey, salt, 'pass')];

    expect(linkOnly[1].kAuth).toBe(linkOnly[0].kAuth);
    expect(await unwraps(linkOnly[0].kWrap, linkOnly[1].kWrap)).toBe(true);
    expect(withPasskey[1].kAuth).toBe(withPasskey[0].kAuth);
    expect(await unwraps(withPasskey[0].kWrap, withPasskey[1].kWrap)).toBe(true);
  });

  it('derives different keys per mode, link key, salt and passkey, and none matching the v1 format', async () => {
    const linkKey = cryptoEngine.generateLinkKey();
    const salt = cryptoEngine.generateSalt();
    const base = await cryptoEngine.deriveLinkKeys(linkKey, salt, 'pass');

    const others = [
      await cryptoEngine.deriveLinkKeys(linkKey, salt),
      await cryptoEngine.deriveLinkKeys(linkKey, salt, 'Pass'),
      await cryptoEngine.deriveLinkKeys(cryptoEngine.generateLinkKey(), salt, 'pass'),
      await cryptoEngine.deriveLinkKeys(linkKey, cryptoEngine.generateSalt(), 'pass'),
      // The v1 labels and HKDF salt differ, so even the same passkey and salt give other keys.
      await cryptoEngine.deriveDualKeys('pass', salt),
    ];

    const kAuths = new Set([base.kAuth, ...others.map((keys) => keys.kAuth)]);
    expect(kAuths.size).toBe(others.length + 1);
    const unwrapped = await Promise.all(others.map((keys) => unwraps(base.kWrap, keys.kWrap)));
    expect(unwrapped.every((ok) => !ok)).toBe(true);
  });

  it('gives a kAuth that fits within bcrypt\'s 72-byte limit', async () => {
    const { kAuth } = await cryptoEngine.deriveLinkKeys(cryptoEngine.generateLinkKey(), cryptoEngine.generateSalt());

    expect(kAuth).toHaveLength(KEY_BASE64URL_LENGTH);
  });

  it('refuses a malformed link key instead of deriving keys from it', async () => {
    await expect(cryptoEngine.deriveLinkKeys('truncated', cryptoEngine.generateSalt())).rejects.toThrow('Malformed link key.');
  });
});

describe('Zero-Knowledge Password Envelope Encryption Engine', () => {
  it('1. Generates salt, derives dual keys (kAuth, kWrap), and executes key wrapping/unwrapping', async () => {
    const password = 'SuperSecretVaultPassphrase123!';
    const salt = cryptoEngine.generateSalt();

    expect(salt).toHaveLength(SALT_BYTES);

    const { kAuth, kWrap } = await cryptoEngine.deriveDualKeys(password, salt);
    expect(typeof kAuth).toBe('string');
    expect(kAuth).toHaveLength(KEY_BASE64URL_LENGTH);
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
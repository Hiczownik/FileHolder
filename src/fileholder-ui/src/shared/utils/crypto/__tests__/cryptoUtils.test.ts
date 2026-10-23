import { describe, it, expect } from 'vitest';
import { cryptoEngine, isWellFormedLinkKey } from '../cryptoUtils';
import { formatKdfParams, KDF_LIMITS, UnsupportedKdfParamsError } from '../kdfParams';
import { FAST_KDF_PARAMS, withPasskey } from '../../../../test/kdf';

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
    const passkeyMode = [await cryptoEngine.deriveLinkKeys(linkKey, salt, withPasskey('pass')), await cryptoEngine.deriveLinkKeys(linkKey, salt, withPasskey('pass'))];

    expect(linkOnly[1].kAuth).toBe(linkOnly[0].kAuth);
    expect(await unwraps(linkOnly[0].kWrap, linkOnly[1].kWrap)).toBe(true);
    expect(passkeyMode[1].kAuth).toBe(passkeyMode[0].kAuth);
    expect(await unwraps(passkeyMode[0].kWrap, passkeyMode[1].kWrap)).toBe(true);
  });

  it('derives different keys per mode, link key, salt and passkey', async () => {
    const linkKey = cryptoEngine.generateLinkKey();
    const salt = cryptoEngine.generateSalt();
    const base = await cryptoEngine.deriveLinkKeys(linkKey, salt, withPasskey('pass'));

    const others = [
      await cryptoEngine.deriveLinkKeys(linkKey, salt),
      await cryptoEngine.deriveLinkKeys(linkKey, salt, withPasskey('Pass')),
      await cryptoEngine.deriveLinkKeys(cryptoEngine.generateLinkKey(), salt, withPasskey('pass')),
      await cryptoEngine.deriveLinkKeys(linkKey, cryptoEngine.generateSalt(), withPasskey('pass')),
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

describe('passkeys stretched with Argon2id (#78)', () => {
  // Fixed inputs: 32 bytes 0x01..0x20 as the link key, 16 bytes 0xA0..0xAF as the salt.
  const FIXED_LINK_KEY = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA';
  const FIXED_SALT_FIRST_BYTE = 0xa0;
  const FIXED_SALT = Uint8Array.from({ length: SALT_BYTES }, (_, i) => FIXED_SALT_FIRST_BYTE + i);

  it('derives the keys it always has for fixed inputs, so the format can\'t change unnoticed', async () => {
    const { kAuth } = await cryptoEngine.deriveLinkKeys(FIXED_LINK_KEY, FIXED_SALT, withPasskey('correct horse'));

    // Also recomputed outside the app (hash-wasm's Argon2id, then Node's own HKDF) when this was written.
    expect(kAuth).toBe('CMNyoKtpDuU0sdjZKiIPlQrMIIMbCCFbaehXtzIsgjw');
  });

  it('refuses unsupported settings before stretching anything', async () => {
    const tooCostly = { passkey: 'pass', kdfParams: '{"alg":"argon2id","v":19,"m":4194304,"t":3,"p":1}' };

    await expect(cryptoEngine.deriveLinkKeys(cryptoEngine.generateLinkKey(), cryptoEngine.generateSalt(), tooCostly))
      .rejects.toThrow(UnsupportedKdfParamsError);
  });

  it('derives different keys with different settings', async () => {
    const linkKey = cryptoEngine.generateLinkKey();
    const salt = cryptoEngine.generateSalt();
    const morePasses = formatKdfParams({ m: KDF_LIMITS.m.min, t: KDF_LIMITS.t.min + 1, p: KDF_LIMITS.p.min });

    const fast = await cryptoEngine.deriveLinkKeys(linkKey, salt, { passkey: 'pass', kdfParams: FAST_KDF_PARAMS });
    const slower = await cryptoEngine.deriveLinkKeys(linkKey, salt, { passkey: 'pass', kdfParams: morePasses });

    expect(slower.kAuth).not.toBe(fast.kAuth);
  });
});

describe('Zero-Knowledge Password Envelope Encryption Engine', () => {
  it('1. Generates salt, derives dual keys (kAuth, kWrap), and executes key wrapping/unwrapping', async () => {
    const password = 'SuperSecretVaultPassphrase123!';
    const salt = cryptoEngine.generateSalt();

    expect(salt).toHaveLength(SALT_BYTES);

    const { kAuth, kWrap } = await cryptoEngine.deriveLinkKeys(cryptoEngine.generateLinkKey(), salt, withPasskey(password));
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
    const linkKey = cryptoEngine.generateLinkKey();
    const { kWrap: kWrap1 } = await cryptoEngine.deriveLinkKeys(linkKey, salt, withPasskey('PasswordA'));
    const { kWrap: kWrap2 } = await cryptoEngine.deriveLinkKeys(linkKey, salt, withPasskey('PasswordB'));

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
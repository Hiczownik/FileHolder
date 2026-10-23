import { stretchPasskey } from './argon2';
import { parseKdfParams } from './kdfParams';

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH_BYTES = 12;
const GCM_TAG_BYTES = 16;
const SALT_BYTES = 16;
const BASE64_BLOCK_CHARS = 4;
const LINK_KEY_BYTES = 32;

export interface KeyDerivationResult {
  kAuth: string;
  kWrap: CryptoKey;
}

/** A bundle's passkey, with the stored Argon2id settings (kdfParams.ts) it is stretched with. */
export interface PasskeyInput {
  readonly passkey: string;
  readonly kdfParams: string;
}

// Base64 padding at the end of a string: matches the "==" in "QQ==", nothing in "QUJD".
// https://regex101.com/?regex=%3D%2B%24&testString=QQ%3D%3D%0AQUJD
const TRAILING_PADDING = /=+$/;

export const base64Url = {
  encode: (bytes: Uint8Array): string => {
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    return window.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(TRAILING_PADDING, '');
  },

  decode: (str: string): Uint8Array => {
    const base64 = str.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(Math.ceil(base64.length / BASE64_BLOCK_CHARS) * BASE64_BLOCK_CHARS, '=');
    return Uint8Array.from(window.atob(padded), (char) => char.charCodeAt(0));
  },
};

// A link key: 32 bytes as unpadded base64url, always 43 characters. Matches "q3-_" followed by 39 more such
// characters; rejects anything shorter (a truncated link), padded with "=", or containing "+" or "/".
// https://regex101.com/?regex=%5E%5BA-Za-z0-9_-%5D%7B43%7D%24&testString=q3-_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%0Aq3-_AAAA
const LINK_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Whether `value` has the shape of a link key. Says nothing about whether it is the right key. */
export function isWellFormedLinkKey(value: string): boolean {
  return LINK_KEY_PATTERN.test(value);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a, 0);
  joined.set(b, a.byteLength);
  return joined;
}

/**
 * HKDF from the key material into kAuth (sent to the server as the bundle's password) and kWrap (wraps the master
 * key). The "-v2" labels keep these keys apart from those of the old passkey-only format ("-v1").
 */
async function splitKeys(ikm: Uint8Array, salt: Uint8Array): Promise<KeyDerivationResult> {
  const prk = await window.crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const hkdf = (label: string): HkdfParams => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: salt as BufferSource,
    info: new TextEncoder().encode(`fileholder-${label}-v2`),
  });

  const kAuthBits = await window.crypto.subtle.deriveBits(hkdf('auth'), prk, KEY_LENGTH);
  const kWrap = await window.crypto.subtle.deriveKey(
    hkdf('wrap'),
    prk,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
  return { kAuth: base64Url.encode(new Uint8Array(kAuthBits)), kWrap };
}

export const cryptoEngine = {
  base64Url,

  generateSalt(): Uint8Array {
    return window.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  },

  generateKey: async (): Promise<CryptoKey> => {
    return window.crypto.subtle.generateKey(
      { name: ALGORITHM, length: KEY_LENGTH },
      true,
      ['encrypt', 'decrypt']
    );
  },

  exportKeyToBase64Url: async (key: CryptoKey): Promise<string> => {
    const rawKey = await window.crypto.subtle.exportKey('raw', key);
    return base64Url.encode(new Uint8Array(rawKey));
  },

  importKeyFromBase64Url: async (base64UrlKey: string): Promise<CryptoKey> => {
    const bytes = base64Url.decode(base64UrlKey);
    return window.crypto.subtle.importKey(
      'raw',
      bytes as BufferSource,
      { name: ALGORITHM, length: KEY_LENGTH },
      false,
      ['decrypt']
    );
  },

  /** A new random link key, as it goes in the share link's fragment. */
  generateLinkKey(): string {
    return base64Url.encode(window.crypto.getRandomValues(new Uint8Array(LINK_KEY_BYTES)));
  },

  /**
   * The bundle's keys from the link key, and the passkey when the bundle needs one. The link key is random, so it
   * isn't stretched; the passkey is, with Argon2id, since it is what someone holding the link would have to guess.
   * The settings are checked before anything runs (an UnsupportedKdfParamsError otherwise): the uploader chose them.
   */
  async deriveLinkKeys(linkKey: string, salt: Uint8Array, withPasskey?: PasskeyInput): Promise<KeyDerivationResult> {
    if (!isWellFormedLinkKey(linkKey)) throw new Error('Malformed link key.');
    const linkKeyBytes = base64Url.decode(linkKey);
    if (withPasskey === undefined) return splitKeys(linkKeyBytes, salt);

    const params = parseKdfParams(withPasskey.kdfParams);
    const stretched = await stretchPasskey({ passkey: withPasskey.passkey, salt, params });
    return splitKeys(concatBytes(linkKeyBytes, stretched), salt);
  },

  async wrapMasterKey(masterKey: CryptoKey, kWrap: CryptoKey): Promise<string> {
    const rawMaster = await window.crypto.subtle.exportKey('raw', masterKey);
    const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
    const encrypted = await window.crypto.subtle.encrypt(
      { name: ALGORITHM, iv: iv as BufferSource },
      kWrap,
      rawMaster
    );

    const envelope = new Uint8Array(IV_LENGTH_BYTES + encrypted.byteLength);
    envelope.set(iv, 0);
    envelope.set(new Uint8Array(encrypted), IV_LENGTH_BYTES);
    return base64Url.encode(envelope);
  },

  async unwrapMasterKey(envelopeBase64Url: string, kWrap: CryptoKey): Promise<CryptoKey> {
    const envelope = base64Url.decode(envelopeBase64Url);
    if (envelope.byteLength < IV_LENGTH_BYTES + GCM_TAG_BYTES) throw new Error('Malformed key envelope.');
    const iv = envelope.slice(0, IV_LENGTH_BYTES);
    const ciphertext = envelope.slice(IV_LENGTH_BYTES);

    const rawMaster = await window.crypto.subtle.decrypt(
      { name: ALGORITHM, iv: iv as BufferSource },
      kWrap,
      ciphertext as BufferSource
    );

    return window.crypto.subtle.importKey(
      'raw',
      rawMaster,
      { name: ALGORITHM, length: KEY_LENGTH },
      true,
      ['encrypt', 'decrypt']
    );
  },

  async deriveFileKey(masterKey: CryptoKey, fileId: string): Promise<CryptoKey> {
    const rawMaster = await window.crypto.subtle.exportKey('raw', masterKey);
    const prk = await window.crypto.subtle.importKey('raw', rawMaster, 'HKDF', false, ['deriveKey']);
    return window.crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(`fileholder-file-${fileId}`),
      },
      prk,
      { name: ALGORITHM, length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
  },

  encryptBytes: async (key: CryptoKey, plainBytes: Uint8Array): Promise<Uint8Array> => {
    const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
    const cipherBuffer = await window.crypto.subtle.encrypt(
      { name: ALGORITHM, iv: iv as BufferSource },
      key,
      plainBytes as BufferSource
    );

    const packed = new Uint8Array(IV_LENGTH_BYTES + cipherBuffer.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(cipherBuffer), IV_LENGTH_BYTES);
    return packed;
  },

  decryptBytes: async (key: CryptoKey, packedBytes: Uint8Array): Promise<Uint8Array> => {
    if (packedBytes.byteLength < IV_LENGTH_BYTES + GCM_TAG_BYTES) {
      throw new Error('Encrypted payload is corrupted or truncated.');
    }
    const iv = packedBytes.slice(0, IV_LENGTH_BYTES);
    const ciphertext = packedBytes.slice(IV_LENGTH_BYTES);

    const plainBuffer = await window.crypto.subtle.decrypt(
      { name: ALGORITHM, iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    );
    return new Uint8Array(plainBuffer);
  },

  encryptJson: async <T>(key: CryptoKey, data: T): Promise<string> => {
    const jsonString = JSON.stringify(data);
    const encoded = new TextEncoder().encode(jsonString);
    const packed = await cryptoEngine.encryptBytes(key, encoded);
    return base64Url.encode(packed);
  },

  decryptJson: async <T>(key: CryptoKey, base64Ciphertext: string): Promise<T> => {
    const packed = base64Url.decode(base64Ciphertext);
    const plainBytes = await cryptoEngine.decryptBytes(key, packed);
    const jsonString = new TextDecoder().decode(plainBytes);
    return JSON.parse(jsonString) as T;
  },
};
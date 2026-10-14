const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH_BYTES = 12;

export interface KeyDerivationResult {
  kAuth: string;
  kWrap: CryptoKey;
}

export const base64Url = {
  encode: (bytes: Uint8Array): string => {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }

    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },

  decode: (str: string): Uint8Array => {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  },
};

export const cryptoEngine = {
  base64Url,

  generateSalt(): Uint8Array {
    return window.crypto.getRandomValues(new Uint8Array(16));
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

  async deriveDualKeys(password: string, salt: Uint8Array): Promise<KeyDerivationResult> {
    const passwordBytes = new TextEncoder().encode(password);
    const baseKey = await window.crypto.subtle.importKey(
      'raw',
      passwordBytes,
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const derivedBits = await window.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations: 300_000,
        hash: 'SHA-256',
      },
      baseKey,
      256
    );

    const prk = await window.crypto.subtle.importKey(
      'raw',
      derivedBits,
      'HKDF',
      false,
      ['deriveKey', 'deriveBits']
    );

    const kAuthBits = await window.crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode('fileholder-auth-v1'),
      },
      prk,
      256
    );
    const kAuth = base64Url.encode(new Uint8Array(kAuthBits));

    const kWrap = await window.crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode('fileholder-wrap-v1'),
      },
      prk,
      { name: ALGORITHM, length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );

    return { kAuth, kWrap };
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
    if (envelope.byteLength < 28) throw new Error('Malformed key envelope.');
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
    if (packedBytes.byteLength < IV_LENGTH_BYTES + 16) {
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
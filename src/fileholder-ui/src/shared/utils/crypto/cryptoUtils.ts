const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH_BYTES = 12;

const base64Url = {
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
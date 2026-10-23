import type { Argon2Params } from './kdfParams';

const HASH_BYTES = 32;

export interface Argon2Request {
  readonly passkey: string;
  readonly salt: Uint8Array;
  readonly params: Argon2Params;
}

export type Argon2Response =
  | { readonly ok: true; readonly hash: Uint8Array }
  | { readonly ok: false; readonly error: string };

/**
 * Argon2id over the passkey, on the current thread. The passkey is NFC-normalised first, so "é" typed as one
 * character (most keyboards) or as "e" plus an accent (some phones, pasted text) stretches to the same key.
 */
export async function computeArgon2id({ passkey, salt, params }: Argon2Request): Promise<Uint8Array> {
  // Loaded on first use, so pages that never stretch a passkey don't download it.
  const { argon2id } = await import('hash-wasm');
  return argon2id({
    password: passkey.normalize('NFC'),
    salt,
    memorySize: params.m,
    iterations: params.t,
    parallelism: params.p,
    hashLength: HASH_BYTES,
    outputType: 'binary',
  });
}

/**
 * Argon2id in a worker, so the page stays responsive for the second or so it takes. Where a worker can't run
 * (no Worker, as in tests, or one that fails to load), it runs here instead: slower to look at, same result.
 */
export async function stretchPasskey(request: Argon2Request): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return computeArgon2id(request);

  const response = await runInWorker(request);
  if (response === null) return computeArgon2id(request);
  if (!response.ok) throw new Error(response.error);
  return response.hash;
}

/** The worker's answer, or null when the worker itself couldn't run. */
function runInWorker(request: Argon2Request): Promise<Argon2Response | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./argon2.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<Argon2Response>): void => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event: ErrorEvent): void => {
      event.preventDefault();
      worker.terminate();
      resolve(null);
    };
    worker.postMessage(request);
  });
}

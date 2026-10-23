import { computeArgon2id, type Argon2Request, type Argon2Response } from './argon2';

// The project's types are the page's (DOM), not a worker's; this is the part of the worker scope used here.
interface WorkerScope {
  onmessage: ((event: MessageEvent<Argon2Request>) => void) | null;
  postMessage(message: Argon2Response, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

/** Stretches one passkey (see stretchPasskey in argon2.ts) and hands back the hash, or why it failed. */
async function handle(request: Argon2Request): Promise<void> {
  try {
    const hash = await computeArgon2id(request);
    scope.postMessage({ ok: true, hash }, [hash.buffer]);
  } catch (err: unknown) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

scope.onmessage = (event: MessageEvent<Argon2Request>): void => {
  void handle(event.data);
};

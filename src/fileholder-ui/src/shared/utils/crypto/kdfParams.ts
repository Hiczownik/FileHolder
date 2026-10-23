/**
 * The Argon2id settings a passkey is stretched with, stored with each bundle as canonical JSON:
 * {"alg":"argon2id","v":19,"m":65536,"t":3,"p":1} (`m` in KiB). The uploader chooses them and the recipient's browser
 * runs them, so they are checked here before anything is derived, against the same limits as the server's
 * KeyDerivationParams and the same cases (tests/vectors/kdf-params.json). Never trust the server's check alone.
 */
export interface Argon2Params {
  /** Memory in KiB. */
  readonly m: number;
  /** Passes over the memory. */
  readonly t: number;
  /** Lanes. */
  readonly p: number;
}

export const KDF_PARAMS_MAX_LENGTH = 256;
const ARGON2ID = 'argon2id';
/** Argon2 version 1.3 (0x13), the only one RFC 9106 specifies. */
const ARGON2_VERSION = 19;
const KEYS = ['alg', 'v', 'm', 't', 'p'];

const KIB_PER_MIB = 1024;
const MIN_MEMORY_MIB = 16;
const MAX_MEMORY_MIB = 256;
const MIN_PASSES = 1;
const MAX_PASSES = 10;
const MIN_LANES = 1;
const MAX_LANES = 4;

export const KDF_LIMITS = {
  m: { min: MIN_MEMORY_MIB * KIB_PER_MIB, max: MAX_MEMORY_MIB * KIB_PER_MIB },
  t: { min: MIN_PASSES, max: MAX_PASSES },
  p: { min: MIN_LANES, max: MAX_LANES },
} as const;

const DEFAULT_MEMORY_MIB = 64;
const DEFAULT_PASSES = 3;

/** What new uploads use. Chosen from device timings (see the Argon2 benchmark page, /diagnostics/argon2). */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = { m: DEFAULT_MEMORY_MIB * KIB_PER_MIB, t: DEFAULT_PASSES, p: MIN_LANES };

export const UNSUPPORTED_KDF_PARAMS_MESSAGE = 'This bundle uses unsupported encryption settings, so it can\'t be opened.';

export class UnsupportedKdfParamsError extends Error {
  constructor() {
    super(UNSUPPORTED_KDF_PARAMS_MESSAGE);
    this.name = 'UnsupportedKdfParamsError';
  }
}

/** The one accepted spelling of these settings. */
export function formatKdfParams({ m, t, p }: Argon2Params): string {
  return `{"alg":"${ARGON2ID}","v":${ARGON2_VERSION},"m":${m},"t":${t},"p":${p}}`;
}

const withinLimit = (value: unknown, { min, max }: { readonly min: number; readonly max: number }): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * The settings in `value`, or an UnsupportedKdfParamsError. Only the spelling formatKdfParams writes is accepted
 * (no spaces, other key orders, duplicate keys or "3.0"), so the browser and the server can't read the same text
 * differently.
 */
export function parseKdfParams(value: string): Argon2Params {
  if (value.length === 0 || value.length > KDF_PARAMS_MAX_LENGTH) throw new UnsupportedKdfParamsError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UnsupportedKdfParamsError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new UnsupportedKdfParamsError();

  const fields = parsed as Record<string, unknown>;
  if (!KEYS.every((key) => Object.hasOwn(fields, key))) throw new UnsupportedKdfParamsError();
  const { alg, v, m, t, p } = fields;
  if (alg !== ARGON2ID || v !== ARGON2_VERSION) throw new UnsupportedKdfParamsError();
  if (!withinLimit(m, KDF_LIMITS.m) || !withinLimit(t, KDF_LIMITS.t) || !withinLimit(p, KDF_LIMITS.p)) {
    throw new UnsupportedKdfParamsError();
  }

  const params = { m, t, p };
  if (formatKdfParams(params) !== value) throw new UnsupportedKdfParamsError();
  return params;
}

/** Whether `value` is supported settings; see parseKdfParams. */
export function isSupportedKdfParams(value: string): boolean {
  try {
    parseKdfParams(value);
    return true;
  } catch {
    return false;
  }
}

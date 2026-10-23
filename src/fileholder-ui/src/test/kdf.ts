import type { PasskeyInput } from '../shared/utils/crypto/cryptoUtils';
import { formatKdfParams, KDF_LIMITS } from '../shared/utils/crypto/kdfParams';

/** The cheapest settings a bundle may have, so tests that stretch many passkeys stay fast. */
export const FAST_KDF_PARAMS = formatKdfParams({ m: KDF_LIMITS.m.min, t: KDF_LIMITS.t.min, p: KDF_LIMITS.p.min });

/** `passkey` with FAST_KDF_PARAMS, as deriveLinkKeys takes it. */
export const withPasskey = (passkey: string): PasskeyInput => ({ passkey, kdfParams: FAST_KDF_PARAMS });

import { cryptoEngine, type KeyDerivationResult } from '../../../../shared/utils/crypto/cryptoUtils';
import { LINK_KEY_PARAM } from '../../../../shared/utils/shareLink';
import { FAST_KDF_PARAMS, withPasskey } from '../../../../test/kdf';

/** Puts a link key in the address bar, as opening a share link does; the hook reads it from there on mount. */
export const putLinkKeyInAddressBar = (linkKey: string): void => {
    window.history.replaceState(null, '', `${window.location.pathname}#${LINK_KEY_PARAM}=${linkKey}`);
};

/**
 * A new link key, placed in the address bar, and the keys a bundle encrypted with it (and `passkey`) uses, the
 * same way the upload flow derives them. With a passkey, `kdfParams` are the settings to serve with the bundle.
 */
export const openShareLinkWithNewKey = async (
    salt: Uint8Array,
    passkey?: string
): Promise<KeyDerivationResult & { linkKey: string; kdfParams?: string }> => {
    const linkKey = cryptoEngine.generateLinkKey();
    putLinkKeyInAddressBar(linkKey);
    const keys = await cryptoEngine.deriveLinkKeys(linkKey, salt, passkey === undefined ? undefined : withPasskey(passkey));
    return { linkKey, ...keys, kdfParams: passkey === undefined ? undefined : FAST_KDF_PARAMS };
};

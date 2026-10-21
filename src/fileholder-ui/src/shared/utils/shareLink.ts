/** The fragment parameter that carries an encrypted bundle's link key: `/f/{shareToken}#k={linkKey}`. */
export const LINK_KEY_PARAM = 'k';

/**
 * The link a bundle is shared by. An encrypted bundle's link key goes in the fragment, which browsers never send to
 * the server (nor in the Referer header), so the server can't read the files.
 */
export function buildShareLink(shareToken: string, linkKey?: string): string {
    const link = `${window.location.origin}/f/${shareToken}`;
    return linkKey === undefined ? link : `${link}#${new URLSearchParams({ [LINK_KEY_PARAM]: linkKey })}`;
}

/**
 * The link key in a URL fragment such as "#k=…", exactly as written (it may be truncated or altered), or undefined
 * when the fragment has none.
 */
export function readLinkKey(hash: string): string | undefined {
    const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
    return new URLSearchParams(fragment).get(LINK_KEY_PARAM) ?? undefined;
}

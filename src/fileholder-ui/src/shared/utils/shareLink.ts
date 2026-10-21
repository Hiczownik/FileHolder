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

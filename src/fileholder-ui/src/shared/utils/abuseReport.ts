/**
 * Where abuse reports go (VITE_ABUSE_EMAIL at build time; .env.production sets FileHolder's). Without one, the UI
 * shows no report links.
 */
export const ABUSE_EMAIL: string | undefined = import.meta.env.VITE_ABUSE_EMAIL?.trim() || undefined;

/**
 * A mailto link for reporting abuse, optionally about the bundle at `pageUrl`. Only the address without its
 * fragment goes into the email: an encrypted bundle's fragment is its key, and the report needs only the share token.
 */
export function abuseReportHref(pageUrl?: string): string | undefined {
    if (!ABUSE_EMAIL) return undefined;
    if (!pageUrl) return `mailto:${ABUSE_EMAIL}?subject=${encodeURIComponent('Abuse report')}`;

    const withoutKey = pageUrl.split('#')[0];
    const subject = encodeURIComponent('Abuse report: a shared bundle');
    const body = encodeURIComponent(`Link: ${withoutKey}\n\nWhat's wrong with it:\n`);
    return `mailto:${ABUSE_EMAIL}?subject=${subject}&body=${body}`;
}

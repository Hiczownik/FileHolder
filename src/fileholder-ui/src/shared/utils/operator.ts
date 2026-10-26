/**
 * Who runs this deployment and where to write about it (VITE_OPERATOR_NAME, VITE_CONTACT_EMAIL at build time;
 * .env.production sets FileHolder's). The terms and privacy pages name them; without them they fall back to a
 * neutral wording.
 */
export const OPERATOR_NAME: string = import.meta.env.VITE_OPERATOR_NAME?.trim() || 'the operator of this site';

export const CONTACT_EMAIL: string | undefined = import.meta.env.VITE_CONTACT_EMAIL?.trim() || undefined;

/** When the terms and privacy pages last changed in substance; shown on both. */
export const LEGAL_PAGES_UPDATED = '26 October 2026';

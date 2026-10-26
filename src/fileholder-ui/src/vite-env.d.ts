/// <reference types="vite/client" />
/// <reference types="@testing-library/jest-dom/vitest" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  /** Where "Report abuse" links send email (abuseReport.ts). Unset: no such links. */
  readonly VITE_ABUSE_EMAIL?: string;
}

/** The UI's version and commit, fixed at build time (vite.config.ts, shared/utils/buildInfo.ts). */
declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
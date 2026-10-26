/// <reference types="vite/client" />
/// <reference types="@testing-library/jest-dom/vitest" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  /** Where "Report abuse" links send email (abuseReport.ts). Unset: no such links. */
  readonly VITE_ABUSE_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
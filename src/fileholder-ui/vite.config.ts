/// <reference types="vitest/config" />

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { execSync } from 'node:child_process'
import packageJson from './package.json' with { type: 'json' }

// The port Playwright and the README expect the UI on, in dev and preview alike.
const UI_PORT = 3000
const SHORT_COMMIT_LENGTH = 7

/**
 * The commit this build is from: GIT_SHA when the builder passes it (Docker builds have no .git), else asked of git,
 * else "unknown". Shown in the footer and the diagnostics report (shared/utils/buildInfo.ts).
 */
function buildCommit(): string {
  const fromEnv = process.env.GIT_SHA?.trim()
  if (fromEnv) return fromEnv.slice(0, SHORT_COMMIT_LENGTH)
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The UI's version (package.json, bumped by release-please) and commit, fixed into the bundle at build time.
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __GIT_SHA__: JSON.stringify(buildCommit()),
  },
  // Workers are started as modules (new Worker(..., { type: 'module' })), so they are built as ES modules too, which
  // keeps only the Argon2id part of hash-wasm in the passkey worker instead of every algorithm it has.
  worker: {
    format: 'es'
  },
  server: {
    port: UI_PORT
  },
  // Production builds call the API same-origin (/api/v1/files), as nginx does in compose; forward it the same way.
  preview: {
    port: UI_PORT,
    proxy: {
      '/api': 'http://localhost:8080'
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})

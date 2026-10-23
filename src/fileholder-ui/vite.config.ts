/// <reference types="vitest/config" />

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The port Playwright and the README expect the UI on, in dev and preview alike.
const UI_PORT = 3000

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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

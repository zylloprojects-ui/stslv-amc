import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Tests only: the help test checks the in-app help against docs/user-guide/USER_GUIDE.md, outside this
// project. The development server keeps Vite's default file access.
const testFileAccess = process.env.VITEST
  ? { fs: { allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../docs/user-guide', import.meta.url))] } }
  : {}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    ...testFileAccess,
    // Development only: the browser must never keep an old copy of a page's code.
    headers: { 'Cache-Control': 'no-store' },
    // The browser calls /api on the web origin; Vite forwards it to the API.
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Form tests type character by character; allow slower machines to finish.
    testTimeout: 15000,
    // The dashboard's detail panels are hidden by default; the tests still cover them.
    env: { VITE_SHOW_DASHBOARD_DETAIL_PANELS: 'true' },
  },
})

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// End-to-end and visual tests in a real browser (e2e/*.e2e.ts; Vitest keeps src/test).
//
//   npm run e2e                      starts the local API (:3001) and web (:5173) and tests them
//   E2E_BASE_URL=https://… npm run e2e   tests an already running site (nothing is started)
//
// Sign-in: E2E_EMAIL and E2E_PASSWORD, from the environment or the git-ignored e2e/.env.e2e.
// The tests only read and download: they never create, change or delete a record.

const envFile = path.join(import.meta.dirname, 'e2e', '.env.e2e')

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())

    if (match && process.env[match[1] as string] === undefined) process.env[match[1] as string] = match[2]
  }
}

const external = Boolean(process.env.E2E_BASE_URL)
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  outputDir: './test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: external ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' } },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'Asia/Muscat',
    locale: 'en-GB',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.e2e\.ts$/ },
    {
      name: 'desktop',
      dependencies: ['setup'],
      testIgnore: [/auth\.setup\.e2e\.ts$/, /responsive\.e2e\.ts$/],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: 'e2e/.auth/user.json' },
    },
    {
      name: 'mobile',
      dependencies: ['setup'],
      testMatch: /responsive\.e2e\.ts$/,
      use: { ...devices['Pixel 7'], storageState: 'e2e/.auth/user.json' },
    },
  ],
  webServer: external
    ? undefined
    : [
        { command: 'npm run dev', cwd: '../stslv-api', url: 'http://localhost:3001/api/health', reuseExistingServer: true, timeout: 120_000 },
        { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 120_000 },
      ],
})

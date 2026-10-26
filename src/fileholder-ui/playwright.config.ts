import { defineConfig, devices } from '@playwright/test';

const TEST_TIMEOUT_MS = 60_000;
const CI_RETRIES = 2;
// Matches the tag in titles of tests that also run in Firefox and WebKit: "4. E2EE journey @cross-browser" matches,
// "2. Rejects executable files" doesn't.
// https://regex101.com/?regex=%40cross-browser&flags=&testString=4.%20E2EE%20journey%20%40cross-browser%0A2.%20Rejects%20executable%20files
const CROSS_BROWSER = /@cross-browser/;
// Tests for other stacks: the fault tests (their own projects) and the production setup (scripts/prod-local.ps1).
const NOT_THE_DEV_STACK = ['**/faults/**', '**/production.spec.ts'];

export default defineConfig({
  testDir: './e2e',
  timeout: TEST_TIMEOUT_MS,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? CI_RETRIES : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      testIgnore: NOT_THE_DEV_STACK,
      use: { ...devices['Desktop Chrome'] },
    },
    // Saving decrypted downloads works differently per browser engine (see streamSaving.ts), so the tests
    // tagged @cross-browser also run in Firefox and WebKit (Safari's engine).
    {
      name: 'firefox',
      grep: CROSS_BROWSER,
      testIgnore: NOT_THE_DEV_STACK,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      grep: CROSS_BROWSER,
      testIgnore: NOT_THE_DEV_STACK,
      use: { ...devices['Desktop Safari'] },
    },
    // Network-fault tests (#71, see e2e/faults/README.md). One at a time: their checks read the stack's shared
    // database, storage and API log. Run them alone with: npx playwright test --project="faults*"
    {
      name: 'faults',
      testDir: './e2e/faults',
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'faults-firefox',
      testDir: './e2e/faults',
      grep: CROSS_BROWSER,
      workers: 1,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'faults-webkit',
      testDir: './e2e/faults',
      grep: CROSS_BROWSER,
      workers: 1,
      use: { ...devices['Desktop Safari'] },
    },
    // The production setup (docker-compose.prod.yml) behind Caddy, run by scripts/prod-local.ps1 test. Caddy's local
    // certificate authority isn't trusted by the browser: ignoreHTTPSErrors covers pages and requests, and the flag
    // covers the download service worker, which Chromium otherwise refuses to register from such a site.
    {
      name: 'production',
      testMatch: 'production.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.PROD_LOCAL_URL ?? 'https://localhost:18443',
        ignoreHTTPSErrors: true,
        launchOptions: { args: ['--ignore-certificate-errors'] },
      },
    },
  ],
});
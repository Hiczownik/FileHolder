import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';

// The production setup (docker-compose.prod.yml) on this machine: Caddy with HTTPS in front of nginx and the API,
// every container hardened. Run with scripts/prod-local.ps1 test, which starts nothing itself: run `up` first.
const UPLOAD_TIMEOUT_MS = 30_000;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const ADMIN_URL = process.env.ADMIN_URL ?? 'http://localhost:19465';
const HSTS = 'max-age=63072000; includeSubDomains; preload';

const report = { name: 'report.txt', mimeType: 'text/plain', buffer: Buffer.from('Quarterly figures, behind Caddy') };

/** Uploads through the form and returns the share link. */
async function upload(page: Page, encrypted: boolean): Promise<string> {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(report);
  if (encrypted) await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
  await page.getByRole('button', { name: 'Create share link' }).click();
  const link = page.getByLabel('Share link');
  await expect(link).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS });
  return link.inputValue();
}

test('the page comes over HTTPS with HSTS from Caddy and its own security headers from nginx', async ({ page }) => {
  const response = await page.goto('/');

  expect(response?.url().startsWith('https://')).toBe(true);
  const headers = response!.headers();
  expect(headers['strict-transport-security']).toBe(HSTS);
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['server']).toBeUndefined();
});

test('the API answers through Caddy and nginx, with its own headers and HSTS', async ({ request }) => {
  const response = await request.get('/api/v1/status');

  expect(response.status()).toBe(HTTP_OK);
  expect(response.headers()['strict-transport-security']).toBe(HSTS);
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect((await response.json()).mode).toBe('Normal');
});

[false, true].forEach((encrypted) => {
  test(`a${encrypted ? 'n encrypted' : ' plain'} bundle goes up and comes back down unchanged`, async ({ page, browser }) => {
    const link = await upload(page, encrypted);
    expect(link.startsWith('https://')).toBe(true);

    const recipient = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const recipientPage = await recipient.newPage();
      await recipientPage.goto(link);
      const download = recipientPage.waitForEvent('download');
      await recipientPage.getByRole('button', { name: 'Download file' }).click();
      const saved = await (await download).path();
      expect(fs.readFileSync(saved, 'utf8')).toBe(report.buffer.toString());
    } finally {
      await recipient.close();
    }
  });
});

test('the admin port answers on the loopback, with the token only', async ({ request }) => {
  const token = process.env.ADMIN_TOKEN;
  test.skip(!token, 'scripts/prod-local.ps1 test passes the admin token');

  expect((await request.get(`${ADMIN_URL}/admin/mode`)).status()).toBe(HTTP_UNAUTHORIZED);
  const response = await request.get(`${ADMIN_URL}/admin/mode`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(HTTP_OK);
});

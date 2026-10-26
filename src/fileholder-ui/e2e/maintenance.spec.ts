import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectNoAccessibilityViolations } from './accessibility';

// Maintenance modes and takedown (#82). The mode is per deployment, so switching it for real would reach every other
// test running alongside; these stub GET /api/v1/status for their own page instead (the API's side is covered by
// ServiceModeTests). The takedown is real: it removes a bundle this test uploaded, through the admin port.
const UPLOAD_TIMEOUT_MS = 30_000;
const ADMIN_URL = process.env.ADMIN_URL ?? 'http://localhost:9465';
const HTTP_OK = 200;
const LINK_KEY_PARAM = '#k=';

/** The admin token: ADMIN_TOKEN in the environment, else from the .env compose reads. */
function adminToken(): string | undefined {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (!fs.existsSync(envFile)) return undefined;
  const line = fs.readFileSync(envFile, 'utf8').split('\n').map((l) => l.trim()).find((l) => l.startsWith('ADMIN_TOKEN='));
  return line?.slice('ADMIN_TOKEN='.length).trim() || undefined;
}

async function stubStatus(page: Page, status: { mode: string; message?: string | null; until?: string | null }): Promise<void> {
  await page.route('**/api/v1/status', (route) => route.fulfill({ json: { message: null, until: null, ...status } }));
}

test.describe('maintenance modes', () => {
  test('while uploads are paused, a banner explains and the form can\'t be sent', async ({ page }) => {
    await stubStatus(page, { mode: 'UploadsPaused', message: 'Uploads are paused while we look into abuse reports.' });
    await page.goto('/');

    await expect(page.getByRole('status').filter({ hasText: 'Uploads are paused while we look into abuse reports.' })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') });
    await expect(page.getByRole('button', { name: 'Uploads are paused' })).toBeDisabled();
    await expectNoAccessibilityViolations(page);
  });

  test('read-only shows the banner on a bundle page too', async ({ page }) => {
    await stubStatus(page, { mode: 'ReadOnly' });
    await page.goto('/f/zz9Unkwn');

    await expect(page.getByRole('status').filter({ hasText: 'FileHolder is read-only for now' })).toBeVisible();
  });

  ['/', '/f/zz9Unkwn'].forEach((address) => {
    test(`closed replaces the page at ${address}`, async ({ page }) => {
      await stubStatus(page, { mode: 'Closed', message: 'Down for an upgrade.' });
      await page.goto(address);

      await expect(page.getByRole('heading', { name: 'FileHolder is closed for now' })).toBeVisible();
      await expect(page.getByText('Down for an upgrade.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create share link' })).toHaveCount(0);
      await expectNoAccessibilityViolations(page);
    });
  });

  test('normal shows no banner, and the footer offers an abuse report', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('[data-mode]')).toHaveCount(0);
    const href = await page.getByRole('link', { name: 'Report abuse' }).getAttribute('href');
    expect(href?.startsWith('mailto:abuse@fileholder.app?')).toBe(true);
  });
});

test.describe('takedown', () => {
  test('a removed link says so, and a report link never carries the key', async ({ page, request }) => {
    const token = adminToken();
    test.skip(!token, 'needs the admin token (ADMIN_TOKEN, or .env next to docker-compose.yml)');

    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles({ name: 'invoice.txt', mimeType: 'text/plain', buffer: Buffer.from('totally an invoice') });
    await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
    await page.getByRole('button', { name: 'Create share link' }).click();
    const linkField = page.getByLabel('Share link');
    await expect(linkField).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS });
    const link = await linkField.inputValue();
    expect(link).toContain(LINK_KEY_PARAM);

    // Before: the bundle opens, with a report link that names it without its key.
    await page.goto(link);
    const report = page.getByRole('link', { name: 'Report it' });
    await expect(report).toBeVisible();
    const href = decodeURIComponent((await report.getAttribute('href')) ?? '');
    expect(href).toContain(link.split('#')[0]);
    expect(href).not.toContain(LINK_KEY_PARAM);

    const shareToken = new URL(link).pathname.split('/').pop()!;
    const takedown = await request.post(`${ADMIN_URL}/admin/takedown`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { shareToken, reason: 'e2e: maintenance.spec.ts', changedBy: 'playwright' },
    });
    expect(takedown.status()).toBe(HTTP_OK);

    // A reload, not goto(link): that differs from the open page only by its fragment, so the browser wouldn't reload.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'This bundle was removed by FileHolder' })).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });
});

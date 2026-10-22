import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { expectNoAccessibilityViolations } from './accessibility';

// The redesigned download screens (#126): per-file downloads, the prompts and the "no longer available" page.
const SCHEMES = ['light', 'dark'] as const;
const PHONE_WIDTH = 390;
const PHONE_HEIGHT = 844;
const UPLOAD_TIMEOUT_MS = 30_000;
const PASSKEY = 'K7QM-2HXP-9RTA';
// A token no bundle has: the right shape (8 letters and digits), so the API answers 404, not 400.
const UNKNOWN_TOKEN = 'zz9Unkwn';

const plan = { name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Ground floor plan') };
const survey = { name: 'survey.txt', mimeType: 'text/plain', buffer: Buffer.from('Survey notes, March') };

interface UploadOptions {
  readonly passkey?: string;
  readonly maxDownloads?: string;
}

/** Uploads the files through the form and returns the share link. */
async function upload(page: Page, files: (typeof plan)[], options: UploadOptions = {}): Promise<string> {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(files);
  if (options.maxDownloads) await page.getByLabel('Download limit').selectOption(options.maxDownloads);
  if (options.passkey) {
    await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
    await page.getByRole('switch', { name: 'Also require a passkey' }).click();
    await page.getByLabel('Passkey', { exact: true }).fill(options.passkey);
  }
  await page.getByRole('button', { name: 'Create share link' }).click();
  const link = page.getByLabel('Share link');
  await expect(link).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS });
  return link.inputValue();
}

/** Clicks a download button and returns what the browser saved. */
async function downloadVia(page: Page, buttonName: string): Promise<string> {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: buttonName }).click();
  return fs.readFileSync(await (await download).path(), 'utf8');
}

test('each file downloads on its own, all within the one counted download, and then the bundle is gone', async ({ page, browser }) => {
  const shareLink = await upload(page, [plan, survey], { maxDownloads: '1' });

  const recipient = await browser.newContext();
  try {
    const recipientPage = await recipient.newPage();
    await recipientPage.goto(shareLink);
    await expect(recipientPage.getByRole('button', { name: 'Download all as ZIP' })).toBeVisible();

    expect(await downloadVia(recipientPage, `Download ${survey.name}`)).toBe(survey.buffer.toString());
    // The bundle allowed one download, and this one has used it; the session it opened covers the other file.
    expect(await downloadVia(recipientPage, `Download ${plan.name}`)).toBe(plan.buffer.toString());
  } finally {
    await recipient.close();
  }

  const latecomer = await browser.newContext();
  try {
    const latecomerPage = await latecomer.newPage();
    await latecomerPage.goto(shareLink);
    await expect(latecomerPage.getByRole('heading', { name: 'This bundle is no longer available' })).toBeVisible();
    await expect(latecomerPage.getByRole('alert')).toHaveCount(0);
  } finally {
    await latecomer.close();
  }
});

SCHEMES.forEach((colorScheme) => {
  test.describe(`download screens (${colorScheme})`, () => {
    test.use({ colorScheme });

    test(`the unlocked bundle passes the accessibility checks (${colorScheme})`, async ({ page }) => {
      const shareLink = await upload(page, [plan, survey]);
      await page.goto(shareLink);
      await expect(page.getByRole('button', { name: `Download ${plan.name}` })).toBeVisible();

      await expectNoAccessibilityViolations(page);
    });

    test(`the passkey prompt fits a phone and passes the accessibility checks (${colorScheme})`, async ({ page }) => {
      const shareLink = await upload(page, [plan], { passkey: PASSKEY });
      await page.setViewportSize({ width: PHONE_WIDTH, height: PHONE_HEIGHT });
      await page.goto(shareLink);
      await expect(page.getByRole('heading', { name: 'Enter the passkey' })).toBeVisible();

      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
      await expectNoAccessibilityViolations(page);
    });

    test(`a link that opens no bundle says so calmly (${colorScheme})`, async ({ page }) => {
      await page.goto(`/f/${UNKNOWN_TOKEN}`);
      await expect(page.getByRole('heading', { name: "This link doesn't open a bundle" })).toBeVisible();

      await expectNoAccessibilityViolations(page);
    });
  });
});

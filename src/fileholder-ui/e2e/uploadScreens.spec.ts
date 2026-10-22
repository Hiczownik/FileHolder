import { test, expect, type Page } from '@playwright/test';
import { expectNoAccessibilityViolations } from './accessibility';

// The redesigned upload screens (#126): the home page on a phone, and the link-ready card, in both themes.
const SCHEMES = ['light', 'dark'] as const;
// An iPhone 14/15's CSS viewport.
const PHONE_WIDTH = 390;
const PHONE_HEIGHT = 844;
const PHONE = { width: PHONE_WIDTH, height: PHONE_HEIGHT };
// An encrypted share link: the 8-character token, then the key in the fragment. Matches
// "http://localhost:3100/f/q8Zt3LrW#k=Hn4c0y"; rejects "http://localhost:3100/f/q8Zt3LrW" (no key).
// https://regex101.com/?regex=%5C%2Ff%5C%2F%5BA-Za-z0-9%5D%7B8%7D%23k%3D&testString=http%3A%2F%2Flocalhost%3A3100%2Ff%2Fq8Zt3LrW%23k%3DHn4c0y%0Ahttp%3A%2F%2Flocalhost%3A3100%2Ff%2Fq8Zt3LrW
const ENCRYPTED_SHARE_LINK = /\/f\/[A-Za-z0-9]{8}#k=/;
const UPLOAD_TIMEOUT_MS = 30_000;
const PASSKEY = 'K7QM-2HXP-9RTA';

const testFile = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Redesign check') };

/** Whether anything sticks out sideways, which makes a phone page scroll horizontally. */
const scrollsSideways = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

SCHEMES.forEach((colorScheme) => {
  test.describe(`upload screens (${colorScheme})`, () => {
    test.use({ colorScheme });

    test(`the home page fits a phone screen (${colorScheme})`, async ({ page }) => {
      await page.setViewportSize(PHONE);
      await page.goto('/');
      await page.locator('input[type="file"]').setInputFiles([testFile]);
      await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
      await page.getByRole('switch', { name: 'Also require a passkey' }).click();

      expect(await scrollsSideways(page)).toBe(false);
      await expectNoAccessibilityViolations(page);
    });

    test(`the link-ready card passes the accessibility checks (${colorScheme})`, async ({ page }) => {
      await page.goto('/');
      await page.getByLabel('Title (optional)').fill('Redesign check');
      await page.locator('input[type="file"]').setInputFiles([testFile]);
      await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
      await page.getByRole('switch', { name: 'Also require a passkey' }).click();
      await page.getByLabel('Passkey', { exact: true }).fill(PASSKEY);
      await page.getByRole('button', { name: 'Create share link' }).click();

      const heading = page.getByRole('heading', { name: 'Your link is ready' });
      await expect(heading).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS });
      await expect(heading).toBeFocused();
      await expect(page.getByText('Redesign check · 1 file', { exact: false })).toBeVisible();
      await expect(page.getByLabel('Passkey', { exact: true })).toHaveValue(PASSKEY);
      await expect(page.getByLabel('Share link')).toHaveValue(ENCRYPTED_SHARE_LINK);

      await page.getByText('Show QR code').click();
      // The QR code's name is an SVG <title>, which getByTitle (title attributes only) doesn't see.
      await expect(page.locator('details[open] svg')).toBeVisible();
      await expectNoAccessibilityViolations(page);
    });
  });
});

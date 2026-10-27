import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The README's screenshots (docs/images), in both themes. Not a test of the app: run on demand against the production
// setup, so /sample works and the links look like the real site's:
//   scripts/prod-local.ps1 up; cd src/fileholder-ui; npx playwright test --project=screenshots
//   $env:SCREENSHOT_URL='https://fileholder.app'; npx playwright test --project=screenshots   # after a deploy
const OUT_DIR = fileURLToPath(new URL('../../../docs/images/', import.meta.url));
const photo = {
  name: 'Flower.jpg',
  mimeType: 'image/jpeg',
  buffer: fs.readFileSync(fileURLToPath(new URL('../sample-content/photo.jpg', import.meta.url))),
};
const UPLOAD_TIMEOUT_MS = 30_000;
const SCHEMES = ['light', 'dark'] as const;

const notes = {
  name: 'Meeting-notes.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('Agenda: launch checklist, demo walkthrough, open questions.'),
};

async function shoot(page: Page, name: string, scheme: string): Promise<void> {
  // Fonts settle before the picture is taken; picking files scrolls the form, so it starts from the top.
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: `${OUT_DIR}${name}-${scheme}.png` });
}

test.beforeAll(() => fs.mkdirSync(OUT_DIR, { recursive: true }));

SCHEMES.forEach((colorScheme) => {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test(`upload form and share link (${colorScheme})`, async ({ page }) => {
      await page.goto('/');
      await page.locator('input[type="file"]').setInputFiles([photo, notes]);
      await page.getByLabel('Title (optional)').fill('Holiday photos');
      await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
      await shoot(page, 'upload', colorScheme);

      await page.getByRole('button', { name: 'Create share link' }).click();
      await expect(page.getByRole('heading', { name: 'Your link is ready' })).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS });
      await page.getByText('Show QR code').click();
      await shoot(page, 'share-link', colorScheme);
    });

    test(`the sample bundle, decrypted (${colorScheme})`, async ({ page }) => {
      await page.goto('/sample');
      await expect(page.getByRole('heading', { name: 'FileHolder sample' })).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS });
      await shoot(page, 'download', colorScheme);
    });
  });
});

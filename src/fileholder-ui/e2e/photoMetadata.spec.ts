import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import { readExif } from '../src/shared/utils/imageMetadata/exif';
import { APP1, buildJpeg, leakedSecrets, segments, splitJpeg } from '../src/shared/utils/imageMetadata/__tests__/photoFixtures';

/**
 * Photo metadata removal (#62), end to end: a rotated JPEG carrying GPS, camera details, XMP and a comment is uploaded,
 * then downloaded in a fresh browser. The metadata must be gone, the orientation and image data kept, and the photo
 * must look exactly as it did, in each browser engine.
 */

const UPLOAD_TIMEOUT_MS = 30_000;
const ROTATED_90 = 6;
const SEGMENT_HEADER_BYTES = 4;
const EXIF_PREFIX = 'Exif\0\0';
const PHOTO_NAME = 'IMG_2041.jpg';
const LOCATION_LABEL = '📍 Contains location';
const WILL_REMOVE_LABEL = 'Metadata will be removed';

const original = buildJpeg([segments.exif({ orientation: ROTATED_90 }), segments.xmp({ gps: true }), segments.comment()]);
const photo = { name: PHOTO_NAME, mimeType: 'image/jpeg', buffer: Buffer.from(original) };

/** Uploads the photo and returns its share link. */
async function uploadPhoto(page: Page, options: { encrypted: boolean; strip: boolean }): Promise<string> {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles([photo]);
  await expect(page.getByText(LOCATION_LABEL)).toBeVisible();

  const stripCheckbox = page.getByRole('checkbox', { name: 'Remove photo metadata' });
  await expect(stripCheckbox).toBeChecked();
  if (!options.strip) {
    await stripCheckbox.click();
    // The location warning stays with removal off; only the promise to remove it goes.
    await expect(page.getByText(LOCATION_LABEL)).toBeVisible();
    await expect(page.getByText(WILL_REMOVE_LABEL)).not.toBeVisible();
  } else {
    await expect(page.getByText(WILL_REMOVE_LABEL)).toBeVisible();
  }
  if (options.encrypted) {
    await page.getByRole('checkbox', { name: 'End-to-end encryption' }).click();
  }

  await page.getByRole('button', { name: 'Generate Shareable Link' }).click();
  const shareLinkInput = page.locator('input[readonly]');
  await expect(shareLinkInput).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS });
  const summary = page.getByText('Removed metadata from 1 photo.');
  await (options.strip ? expect(summary).toBeVisible() : expect(summary).not.toBeVisible());
  return shareLinkInput.inputValue();
}

/** Opens the link in a fresh browser, downloads the single file, and returns its bytes and the page. */
async function downloadPhoto(browser: Browser, shareUrl: string): Promise<{ bytes: Uint8Array; page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(shareUrl);
  await expect(page.getByText(PHOTO_NAME)).toBeVisible();

  const downloadPromise = page.waitForEvent('download', { timeout: UPLOAD_TIMEOUT_MS });
  await page.getByRole('button', { name: 'Download File' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(PHOTO_NAME);
  const bytes = new Uint8Array(fs.readFileSync((await download.path())!));
  return { bytes, page, close: () => context.close() };
}

/** The photo's pixels as the browser shows it (EXIF orientation applied), for comparing two files. */
async function decodedPixels(page: Page, bytes: Uint8Array): Promise<string> {
  return page.evaluate(async (base64) => {
    const data = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }), { imageOrientation: 'from-image' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return `${bitmap.width}x${bitmap.height}:${context.getImageData(0, 0, bitmap.width, bitmap.height).data.join(',')}`;
  }, Buffer.from(bytes).toString('base64'));
}

async function expectCleanedPhoto(page: Page, downloaded: Uint8Array): Promise<void> {
  expect(leakedSecrets(downloaded)).toEqual([]);

  // Only a minimal EXIF holding the orientation is left.
  const exif = splitJpeg(downloaded).segments.filter((segment) => segment.marker === APP1);
  expect(exif).toHaveLength(1);
  expect(readExif(exif[0].bytes.subarray(SEGMENT_HEADER_BYTES + EXIF_PREFIX.length))).toEqual({ orientation: ROTATED_90, hasLocation: false });

  // The image itself is byte-for-byte the same, and shows exactly as the original does, rotation included.
  expect(Buffer.from(splitJpeg(downloaded).imageData).equals(Buffer.from(splitJpeg(original).imageData))).toBe(true);
  expect(await decodedPixels(page, downloaded)).toBe(await decodedPixels(page, original));
}

test.describe('Photo metadata removal (#62)', () => {
  test('8. A photo in a normal bundle downloads without its location or camera details, upright and unchanged', async ({ page, browser }) => {
    const shareUrl = await uploadPhoto(page, { encrypted: false, strip: true });
    const recipient = await downloadPhoto(browser, shareUrl);

    await expectCleanedPhoto(recipient.page, recipient.bytes);
    await recipient.close();
  });

  test('9. A photo in an encrypted bundle is cleaned before encryption too @cross-browser', async ({ page, browser }) => {
    const shareUrl = await uploadPhoto(page, { encrypted: true, strip: true });
    const recipient = await downloadPhoto(browser, shareUrl);

    await expectCleanedPhoto(recipient.page, recipient.bytes);
    await recipient.close();
  });

  test('10. With removal turned off, the photo downloads byte-for-byte as it was uploaded', async ({ page, browser }) => {
    const shareUrl = await uploadPhoto(page, { encrypted: false, strip: false });
    const recipient = await downloadPhoto(browser, shareUrl);

    expect(Buffer.from(recipient.bytes).equals(Buffer.from(original))).toBe(true);
    await recipient.close();
  });
});

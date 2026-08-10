import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

test.describe('FileHolder End-to-End System Tests', () => {
  const e2eDir = path.resolve(process.cwd(), 'e2e');
  const testFileName = 'playwright_test_document.txt';
  const testFilePath = path.join(e2eDir, testFileName);

  test.beforeAll(() => {
    if (!fs.existsSync(e2eDir)) {
      fs.mkdirSync(e2eDir, { recursive: true });
    }
    fs.writeFileSync(testFilePath, 'Hello World! This is an automated Playwright E2E test file payload.');
  });

  test.afterAll(() => {
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  test('1. Full Password-Protected Journey: Upload -> Copy Link -> Download -> Self-Destruct Expiration', async ({ page, browser }) => {
    // 1. Open Upload Page
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Secure File Sharing/i })).toBeVisible();

    // 2. Upload file via file input
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFilePath);
    await expect(page.getByText(testFileName)).toBeVisible();

    // 3. Set Expiration = 24 Hours, Max Downloads = 1 (Self-Destruct), Password = "PlaywrightPass123!"
    const selects = page.locator('select');
    await selects.nth(0).selectOption('24');
    await selects.nth(1).selectOption('1');

    const passwordInput = page.getByPlaceholder(/Leave empty for public link/i);
    await passwordInput.fill('PlaywrightPass123!');

    // 4. Click "Generate Shareable Link" and read output
    await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

    const shareLinkInput = page.locator('input[readonly]');
    await expect(shareLinkInput).toBeVisible({ timeout: 15000 });
    
    const shareUrl = await shareLinkInput.inputValue();
    expect(shareUrl).toContain('/f/');

    // 5. Open FRESH Incognito Browser Context
    const downloaderContext = await browser.newContext();
    const downloaderPage = await downloaderContext.newPage();

    // 6. Navigate to Share Link
    await downloaderPage.goto(shareUrl);
    await expect(downloaderPage.getByText(testFileName)).toBeVisible();
    await expect(downloaderPage.getByText(/Remaining Downloads: 1/i)).toBeVisible();

    // 7. Test WRONG Password
    const downloadPasswordInput = downloaderPage.getByPlaceholder(/Enter password to download/i);
    await downloadPasswordInput.fill('WrongPassword!');
    await downloaderPage.getByRole('button', { name: /Download File/i }).click();
    await expect(downloaderPage.getByText(/Incorrect password/i)).toBeVisible();

    // 8. Test CORRECT Password & File Download
    await downloadPasswordInput.fill('PlaywrightPass123!');
    const downloadPromise = downloaderPage.waitForEvent('download');
    await downloaderPage.getByRole('button', { name: /Download File/i }).click();
    
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(testFileName);

    // 9. Verify Self-Destruct Expiration (HTTP 410)
    await downloaderPage.reload();
    await expect(downloaderPage.getByText(/This file link has expired/i)).toBeVisible();

    await downloaderContext.close();
  });

  test('2. Security Rule: Rejects Executable Script Files (.exe)', async ({ page }) => {
    const maliciousFilePath = path.join(e2eDir, 'virus.exe');
    fs.writeFileSync(maliciousFilePath, 'MZ_FAKE_EXECUTABLE_HEADER');

    try {
      await page.goto('/');

      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles(maliciousFilePath);

      await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

      // Target error banner
      const errorBanner = page.locator('.bg-rose-500\\/10');
      await expect(errorBanner).toBeVisible({ timeout: 10000 });

      const errorText = await errorBanner.textContent();
      expect(errorText).toMatch(/Forbidden|Executable|One or more/i);
    } finally {
      if (fs.existsSync(maliciousFilePath)) {
        fs.unlinkSync(maliciousFilePath);
      }
    }
  });

  test('3. Public Share Link: Allows Direct Download Without Password Prompt', async ({ page, browser }) => {
    await page.goto('/');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFilePath);

    // Click Generate without filling a password
    await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

    const shareLinkInput = page.locator('input[readonly]');
    await expect(shareLinkInput).toBeVisible({ timeout: 15000 });
    const shareUrl = await shareLinkInput.inputValue();

    // Open Incognito Browser Context
    const publicContext = await browser.newContext();
    const publicPage = await publicContext.newPage();
    await publicPage.goto(shareUrl);

    // Verify Password Input is NOT rendered
    await expect(publicPage.getByPlaceholder(/Enter password to download/i)).not.toBeVisible();

    // Click Download directly
    const downloadPromise = publicPage.waitForEvent('download');
    await publicPage.getByRole('button', { name: /Download File/i }).click();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(testFileName);

    await publicContext.close();
  });

  test('4. Download Counter Decrement: Decrements Remaining Downloads Upon Download', async ({ page, browser }) => {
    await page.goto('/');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFilePath);

    // Select 5 Downloads
    const selects = page.locator('select');
    await selects.nth(1).selectOption('5');

    await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

    const shareLinkInput = page.locator('input[readonly]');
    await expect(shareLinkInput).toBeVisible({ timeout: 15000 });
    const shareUrl = await shareLinkInput.inputValue();

    // Open Incognito Context
    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();
    await userPage.goto(shareUrl);

    // Verify Remaining Downloads initially = 5
    await expect(userPage.getByText(/Remaining Downloads: 5/i)).toBeVisible();

    // Download #1
    const downloadPromise = userPage.waitForEvent('download');
    await userPage.getByRole('button', { name: /Download File/i }).click();
    await downloadPromise;

    // Reload and verify Remaining Downloads decremented to 4
    await userPage.reload();
    await expect(userPage.getByText(/Remaining Downloads: 4/i)).toBeVisible();

    await userContext.close();
  });
});
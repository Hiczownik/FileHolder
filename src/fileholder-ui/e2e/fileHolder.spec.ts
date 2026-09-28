import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

test.describe('FileHolder Multi-File v1.1.0 System Tests', () => {
  const e2eDir = path.resolve(process.cwd(), 'e2e');
  const file1Name = 'doc1.txt';
  const file2Name = 'doc2.txt';
  const file1Path = path.join(e2eDir, file1Name);
  const file2Path = path.join(e2eDir, file2Name);

  test.beforeAll(() => {
    if (!fs.existsSync(e2eDir)) {
      fs.mkdirSync(e2eDir, { recursive: true });
    }
    fs.writeFileSync(file1Path, 'Multi-file payload #1 content');
    fs.writeFileSync(file2Path, 'Multi-file payload #2 content');
  });

  test.afterAll(() => {
    if (fs.existsSync(file1Path)) fs.unlinkSync(file1Path);
    if (fs.existsSync(file2Path)) fs.unlinkSync(file2Path);
  });

test('1. Multi-File Password-Protected Journey: Upload -> Download Individual File -> Expiry', async ({ page, browser }) => {
    page.on('console', (msg) => console.log(`[Browser ${msg.type()}]: ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`[Browser Exception]: ${err.message}`));

    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Secure File Sharing/i })).toBeVisible();

    await page.getByPlaceholder(/e.g. Project Deliverables v1/i).fill('E2E Deliverables');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles([file1Path, file2Path]);

    await expect(page.getByText('Selected Files (2)')).toBeVisible();

    const selects = page.locator('select');
    await selects.nth(0).selectOption('24');
    await selects.nth(1).selectOption('1');

    const passwordInput = page.getByPlaceholder(/Leave empty for public link/i);
    await passwordInput.fill('PlaywrightPass123!');

    await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

    const shareLinkInput = page.locator('input[readonly]');
    const errorBanner = page.locator('.bg-rose-500\\/10');

    await Promise.race([
      shareLinkInput.waitFor({ state: 'visible', timeout: 30000 }),
      errorBanner.waitFor({ state: 'visible', timeout: 30000 }).then(async () => {
        const errorText = await errorBanner.textContent();
        throw new Error(`Upload failed on UI with error message: "${errorText}"`);
      })
    ]);

    const shareUrl = await shareLinkInput.inputValue();
    expect(shareUrl).toContain('/f/');

    const downloaderContext = await browser.newContext();
    const downloaderPage = await downloaderContext.newPage();

    await downloaderPage.goto(shareUrl);
    await expect(downloaderPage.getByRole('heading', { name: 'E2E Deliverables' })).toBeVisible();

    await expect(downloaderPage.getByText(file1Name)).not.toBeVisible();
    await expect(downloaderPage.getByText(file2Name)).not.toBeVisible();

    const vaultPasswordInput = downloaderPage.getByPlaceholder(/Enter password/i);
    await vaultPasswordInput.fill('WrongPassword!');
    await downloaderPage.getByRole('button', { name: /Unlock Files/i }).click();
    await expect(downloaderPage.getByText(/Incorrect password|unauthorized/i)).toBeVisible();

    await vaultPasswordInput.fill('PlaywrightPass123!');
    await downloaderPage.getByRole('button', { name: /Unlock Files/i }).click();

    await expect(downloaderPage.getByText(file1Name)).toBeVisible();
    await expect(downloaderPage.getByText(file2Name)).toBeVisible();

    const downloadPromise = downloaderPage.waitForEvent('download');
    await downloaderPage.getByRole('button', { name: /Download All.*ZIP/i }).click();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);

    await downloaderPage.reload();
    await expect(downloaderPage.getByText(/has expired/i)).toBeVisible();

    await downloaderContext.close();
  });

  test('2. Security Rule: Rejects Executable Script Files (.exe) in Multi-File Payload', async ({ page }) => {
    const maliciousFilePath = path.join(e2eDir, 'virus.exe');
    fs.writeFileSync(maliciousFilePath, 'MZ_FAKE_EXECUTABLE_HEADER');

    try {
      await page.goto('/');

      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles([file1Path, maliciousFilePath]);

      await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

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

  test('3. Download All as ZIP: Stream and downloads complete bundle archive', async ({ page, browser }) => {
    await page.goto('/');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles([file1Path, file2Path]);

    await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

    const shareLinkInput = page.locator('input[readonly]');
    await expect(shareLinkInput).toBeVisible({ timeout: 30000 });
    const shareUrl = await shareLinkInput.inputValue();

    const downloaderContext = await browser.newContext();
    const downloaderPage = await downloaderContext.newPage();
    await downloaderPage.goto(shareUrl);

    const downloadPromise = downloaderPage.waitForEvent('download');
    await downloaderPage.getByRole('button', { name: /Download All.*ZIP/i }).click();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);

    await downloaderContext.close();
  })
});
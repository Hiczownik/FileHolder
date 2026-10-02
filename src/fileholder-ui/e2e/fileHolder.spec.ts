import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import JSZip from 'jszip';

test.describe('FileHolder Multi-File v1.1.0 System Tests', () => {
  const testFile1 = {
    name: 'doc1.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Multi-file payload #1 content'),
  };

  const testFile2 = {
    name: 'doc2.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Multi-file payload #2 content'),
  };

  test('1. Multi-File Password-Protected Journey: Upload -> Download Individual File -> Expiry', async ({ page, browser }) => {
    page.on('console', (msg) => console.log(`[Browser ${msg.type()}]: ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`[Browser Exception]: ${err.message}`));

    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Secure File Sharing/i })).toBeVisible();

    await page.getByPlaceholder(/e.g. Project Deliverables v1/i).fill('E2E Deliverables');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles([testFile1, testFile2]);

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
      }),
    ]);

    const shareUrl = await shareLinkInput.inputValue();
    expect(shareUrl).toContain('/f/');

    const downloaderContext = await browser.newContext();
    const downloaderPage = await downloaderContext.newPage();

    await downloaderPage.goto(shareUrl);
    await expect(downloaderPage.getByRole('heading', { name: 'E2E Deliverables' })).toBeVisible();

    await expect(downloaderPage.getByText(testFile1.name)).not.toBeVisible();
    await expect(downloaderPage.getByText(testFile2.name)).not.toBeVisible();

    const vaultPasswordInput = downloaderPage.getByPlaceholder(/Enter password/i);
    await vaultPasswordInput.fill('WrongPassword!');
    await downloaderPage.getByRole('button', { name: /Unlock Files/i }).click();
    await expect(downloaderPage.getByText(/Incorrect password|unauthorized/i)).toBeVisible();

    await vaultPasswordInput.fill('PlaywrightPass123!');
    await downloaderPage.getByRole('button', { name: /Unlock Files/i }).click();

    await expect(downloaderPage.getByText(testFile1.name)).toBeVisible();
    await expect(downloaderPage.getByText(testFile2.name)).toBeVisible();

    const downloadPromise = downloaderPage.waitForEvent('download');
    await downloaderPage.getByRole('button', { name: /Download All.*ZIP/i }).click();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);

    await downloaderPage.reload();
    await expect(downloaderPage.getByText(/has expired/i)).toBeVisible();

    await downloaderContext.close();
  });

  test('2. Security Rule: Rejects Executable Script Files (.exe) in Multi-File Payload', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles([
      testFile1,
      {
        name: 'virus.exe',
        mimeType: 'application/x-msdownload',
        buffer: Buffer.from('MZ_FAKE_EXECUTABLE'),
      },
    ]);

    await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

    const errorBanner = page.locator('.bg-rose-500\\/10');
    await expect(errorBanner).toBeVisible({ timeout: 10000 });

    const errorText = await errorBanner.textContent();
    expect(errorText).toMatch(/Forbidden|Executable|One or more/i);
  });

  test('3. Download All as ZIP: Stream and downloads complete bundle archive', async ({ page, browser }) => {
    await page.goto('/');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles([testFile1, testFile2]);

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
  });

  test('4. Zero-Knowledge E2EE Bundle Journey: Client Encryption, Key Isolation, Decrypted Manifest & Payload Integrity', async ({ page, browser }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Secure File Sharing/i })).toBeVisible();

    await page.getByPlaceholder(/e.g. Project Deliverables v1/i).fill('E2EE Classified Archive');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles([testFile1, testFile2]);
    await expect(page.getByText('Selected Files (2)')).toBeVisible();

    const e2eeCheckbox = page.locator('input[type="checkbox"]');
    await e2eeCheckbox.check();
    await expect(e2eeCheckbox).toBeChecked();

    const confirmRequestPromise = page.waitForRequest(
      (req) => req.url().includes('/api/v1/files/confirm') && req.method() === 'POST'
    );

    await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

    const confirmRequest = await confirmRequestPromise;
    const postData = confirmRequest.postDataJSON();
    const rawPostData = confirmRequest.postData() || '';

    expect(postData.isEncrypted).toBe(true);
    expect(postData.files).toHaveLength(1);
    expect(postData.encryptedManifest).toBeTruthy();
    expect(typeof postData.encryptedManifest).toBe('string');

    const shareLinkInput = page.locator('input[readonly]');
    await expect(shareLinkInput).toBeVisible({ timeout: 30000 });

    const shareUrl = await shareLinkInput.inputValue();
    expect(shareUrl).toMatch(/\/f\/[A-Za-z0-9_-]+#key=[A-Za-z0-9_-]+/);

    const keyMatch = shareUrl.match(/#key=([A-Za-z0-9_-]+)/);
    const rawKeyString = keyMatch ? keyMatch[1] : '';
    expect(rawKeyString.length).toBeGreaterThan(10);

    expect(postData.encryptedManifest).not.toBe(rawKeyString);
    expect(rawPostData).not.toContain(rawKeyString);

    const downloaderContext = await browser.newContext();
    const downloaderPage = await downloaderContext.newPage();

    await downloaderPage.goto(shareUrl);

    await expect(downloaderPage.getByRole('heading', { name: 'E2EE Classified Archive' })).toBeVisible();
    await expect(downloaderPage.getByText(testFile1.name)).toBeVisible();
    await expect(downloaderPage.getByText(testFile2.name)).toBeVisible();
    await expect(downloaderPage.getByText('fileGroup.enc')).not.toBeVisible();

    const downloadPromise = downloaderPage.waitForEvent('download');
    await downloaderPage.getByRole('button', { name: /Download All.*ZIP/i }).click();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);

    const downloadStream = await download.createReadStream();
    if (!downloadStream) throw new Error('Failed to create read stream from download.');
    const chunks: Buffer[] = [];
    for await (const chunk of downloadStream) {
      chunks.push(Buffer.from(chunk));
    }
    const zipBuffer = Buffer.concat(chunks);

    const zip = await JSZip.loadAsync(zipBuffer);
    const doc1Content = await zip.file(testFile1.name)?.async('string');
    const doc2Content = await zip.file(testFile2.name)?.async('string');

    expect(doc1Content).toBe('Multi-file payload #1 content');
    expect(doc2Content).toBe('Multi-file payload #2 content');

    await downloaderContext.close();

    const strippedUrl = shareUrl.split('#')[0];
    const noKeyContext = await browser.newContext();
    const noKeyPage = await noKeyContext.newPage();

    try {
      await noKeyPage.goto(strippedUrl);

      const errorMessage = noKeyPage.getByText(/no decryption key was found/i);
      await expect(errorMessage).toBeVisible();

      await expect(noKeyPage.getByText(testFile1.name)).not.toBeVisible();
      await expect(noKeyPage.getByText(testFile2.name)).not.toBeVisible();
      await expect(noKeyPage.getByRole('button', { name: /Download File/i })).not.toBeVisible();
      await expect(noKeyPage.getByRole('button', { name: /Download All.*ZIP/i })).not.toBeVisible();
    } finally {
      await noKeyContext.close();
    }
  });

  test('5. Memory Safety Boundary: Rejects Multi-File E2EE Bundles Exceeding 200 MB', async ({ page }) => {
    const tempDir = path.resolve(process.cwd(), 'e2e');
    const bigFile1Path = path.join(tempDir, 'big1.bin');
    const bigFile2Path = path.join(tempDir, 'big2.bin');

    // Create two 110 MB sparse files instantly (~1ms, 0 RAM overhead)
    const fd1 = fs.openSync(bigFile1Path, 'w');
    fs.ftruncateSync(fd1, 110 * 1024 * 1024);
    fs.closeSync(fd1);

    const fd2 = fs.openSync(bigFile2Path, 'w');
    fs.ftruncateSync(fd2, 110 * 1024 * 1024);
    fs.closeSync(fd2);

    try {
      await page.goto('/');

      const fileInput = page.locator('input[type="file"]');
      // Pass filesystem paths (bypasses Playwright's 50MB in-memory CDP buffer limit)
      await fileInput.setInputFiles([bigFile1Path, bigFile2Path]);

      await expect(page.getByText('Selected Files (2)')).toBeVisible();

      const e2eCheckbox = page.locator('input[type="checkbox"]');
      await e2eCheckbox.check();
      await expect(e2eCheckbox).toBeChecked();

      // Assert: Warning banner appears immediately
      const warningBanner = page.locator('.bg-amber-500\\/10');
      await expect(warningBanner).toBeVisible();
      await expect(warningBanner).toContainText(/200 MB/i);

      // Assert: Submit button is disabled
      const submitBtn = page.getByRole('button', { name: /Generate Shareable Link/i });
      await expect(submitBtn).toBeDisabled();

      // Uncheck and verify it re-enables
      await e2eCheckbox.uncheck();
      await expect(warningBanner).not.toBeVisible();
      await expect(submitBtn).toBeEnabled();
    } finally {
      // Isolated teardown strictly scoped to this test
      if (fs.existsSync(bigFile1Path)) fs.unlinkSync(bigFile1Path);
      if (fs.existsSync(bigFile2Path)) fs.unlinkSync(bigFile2Path);
    }
  });
});
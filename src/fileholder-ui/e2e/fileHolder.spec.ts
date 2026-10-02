import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import JSZip from 'jszip';

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
  });

  test('4. Zero-Knowledge E2EE Bundle Journey: Client Encryption, Key Isolation, Decrypted Manifest & Payload Integrity', async ({ page, browser }) => {
    // -------------------------------------------------------------------------
    // Phase 1: Upload Form & E2EE Activation
    // -------------------------------------------------------------------------
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Secure File Sharing/i })).toBeVisible();

    await page.getByPlaceholder(/e.g. Project Deliverables v1/i).fill('E2EE Classified Archive');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles([file1Path, file2Path]);
    await expect(page.getByText('Selected Files (2)')).toBeVisible();

    const e2eeCheckbox = page.locator('input[type="checkbox"]');
    await e2eeCheckbox.check();
    await expect(e2eeCheckbox).toBeChecked();

    // -------------------------------------------------------------------------
    // Phase 2: Wire Interception & Zero-Knowledge Verification
    // -------------------------------------------------------------------------
    const confirmRequestPromise = page.waitForRequest(
      (req) => req.url().includes('/api/v1/files/confirm') && req.method() === 'POST'
    );

    await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

    const confirmRequest = await confirmRequestPromise;
    const postData = confirmRequest.postDataJSON();
    const rawPostData = confirmRequest.postData() || '';

    // Assertion 2.1: Upload is flagged as encrypted on the wire
    expect(postData.isEncrypted).toBe(true);

    // Assertion 2.2: Payload is packaged into a single encrypted container blob
    expect(postData.files).toHaveLength(1);

    // Assertion 2.3: Encrypted manifest string is populated
    expect(postData.encryptedManifest).toBeTruthy();
    expect(typeof postData.encryptedManifest).toBe('string');

    // Wait for the share link card to appear
    const shareLinkInput = page.locator('input[readonly]');
    await expect(shareLinkInput).toBeVisible({ timeout: 30000 });

    const shareUrl = await shareLinkInput.inputValue();

    // Assertion 2.4: Share link contains URL hash key fragment
    expect(shareUrl).toMatch(/\/f\/[A-Za-z0-9_-]+#key=[A-Za-z0-9_-]+/);

    const keyMatch = shareUrl.match(/#key=([A-Za-z0-9_-]+)/);
    const rawKeyString = keyMatch ? keyMatch[1] : '';
    expect(rawKeyString.length).toBeGreaterThan(10);

    // Assertion 2.5: Zero-Knowledge contract - raw key is NEVER leaked in the request body
    expect(postData.encryptedManifest).not.toBe(rawKeyString);
    expect(rawPostData).not.toContain(rawKeyString);

    // -------------------------------------------------------------------------
    // Phase 3: Fresh Browser Context & Manifest Hydration
    // -------------------------------------------------------------------------
    const downloaderContext = await browser.newContext();
    const downloaderPage = await downloaderContext.newPage();

    await downloaderPage.goto(shareUrl);

    // Assertion 3.1: Bundle title is rendered
    await expect(downloaderPage.getByRole('heading', { name: 'E2EE Classified Archive' })).toBeVisible();

    // Assertion 3.2: Decrypted file names are resolved in DOM from encryptedManifest
    await expect(downloaderPage.getByText(file1Name)).toBeVisible();
    await expect(downloaderPage.getByText(file2Name)).toBeVisible();

    // Assertion 3.3: Storage placeholder is masked and not exposed
    await expect(downloaderPage.getByText('fileGroup.enc')).not.toBeVisible();

    // -------------------------------------------------------------------------
    // Phase 4: Payload Decryption & Archive Integrity
    // -------------------------------------------------------------------------
    const tempZipPath = path.join(e2eDir, 'e2ee_downloaded.zip');

    try {
      const downloadPromise = downloaderPage.waitForEvent('download');
      await downloaderPage.getByRole('button', { name: /Download All.*ZIP/i }).click();

      const download = await downloadPromise;

      // Assertion 4.1: Downloaded artifact is a ZIP file
      expect(download.suggestedFilename()).toMatch(/\.zip$/);

      await download.saveAs(tempZipPath);

      // Verify ZIP decompresses cleanly and payloads match unencrypted test files
      const zipBuffer = fs.readFileSync(tempZipPath);
      const zip = await JSZip.loadAsync(zipBuffer);

      const doc1Content = await zip.file(file1Name)?.async('string');
      const doc2Content = await zip.file(file2Name)?.async('string');

      // Assertion 4.2 & 4.3: Decrypted file contents match originals byte-for-byte
      expect(doc1Content).toBe('Multi-file payload #1 content');
      expect(doc2Content).toBe('Multi-file payload #2 content');
    } finally {
      if (fs.existsSync(tempZipPath)) {
        fs.unlinkSync(tempZipPath);
      }
      await downloaderContext.close();
    }

    // -------------------------------------------------------------------------
    // Phase 5: Negative Case (Missing Key Fragment)
    // -------------------------------------------------------------------------
    const strippedUrl = shareUrl.split('#')[0];
    const noKeyContext = await browser.newContext();
    const noKeyPage = await noKeyContext.newPage();

    try {
      await noKeyPage.goto(strippedUrl);

      // Assertion 5.1: Missing key error banner appears
      const errorMessage = noKeyPage.getByText(/no decryption key was found/i);
      await expect(errorMessage).toBeVisible();

      // Assertion 5.2: Encrypted file contents remain undisclosed
      await expect(noKeyPage.getByText(file1Name)).not.toBeVisible();
      await expect(noKeyPage.getByText(file2Name)).not.toBeVisible();

      // Assertion 5.3: Action buttons are not rendered
      await expect(noKeyPage.getByRole('button', { name: /Download File/i })).not.toBeVisible();
      await expect(noKeyPage.getByRole('button', { name: /Download All.*ZIP/i })).not.toBeVisible();
    } finally {
      await noKeyContext.close();
    }
  });
});
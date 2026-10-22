import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';

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

    const passwordInput = page.locator('input[type="password"]');
    await passwordInput.fill('PlaywrightPass123!');

    await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

    const shareLinkInput = page.locator('input[readonly]');
    const errorBanner = page.locator('[data-variant="error"]');

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

    const vaultPasswordInput = downloaderPage.locator('input[type="password"]');
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

    const errorBanner = page.locator('[data-variant="error"]');
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

  test('4. Zero-Knowledge E2EE Bundle Journey: Password Envelope Encryption, Clean URL & Decrypted Manifest @cross-browser', async ({ page, browser, browserName }) => {
    test.setTimeout(60000);

    page.on('console', (msg) => console.log(`[Browser ${msg.type()}]: ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`[Browser Exception]: ${err.message}`));

    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Secure File Sharing/i })).toBeVisible();

    await page.getByPlaceholder(/e.g. Project Deliverables v1/i).fill('E2EE Classified Archive');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles([testFile1, testFile2]);
    await expect(page.getByText('Selected Files (2)')).toBeVisible();

    const e2eeCheckbox = page.getByRole('checkbox', { name: 'End-to-end encryption' });
    await e2eeCheckbox.click();
    await expect(e2eeCheckbox).toBeChecked();
    await page.getByRole('checkbox', { name: 'Also require a passkey' }).click();

    const passwordInput = page.locator('input[type="password"]');
    await passwordInput.fill('ClassifiedPass123!');

    const confirmRequestPromise = page.waitForRequest(
      (req) => req.url().includes('/api/v1/files/confirm') && req.method() === 'POST'
    );

    await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

    const confirmRequest = await confirmRequestPromise;
    const postData = confirmRequest.postDataJSON();
    const rawPostData = confirmRequest.postData() || '';

    expect(postData.isEncrypted).toBe(true);
    expect(postData.files).toHaveLength(2);
    expect(postData.keyEnvelope).toBeTruthy();
    expect(postData.keySalt).toBeTruthy();
    expect(postData.encryptedManifest).toBeTruthy();
    expect(postData.keyMode).toBe('LinkKeyAndPasskey');

    // Verify plaintext password is never sent over the wire
    expect(rawPostData).not.toContain('ClassifiedPass123!');

    const shareLinkInput = page.locator('input[readonly]');
    await expect(shareLinkInput).toBeVisible({ timeout: 30000 });

    const shareUrl = await shareLinkInput.inputValue();
    // The link key travels only in the fragment: matches "/f/abc#k=" plus 43 base64url characters, rejects "/f/abc".
    // https://regex101.com/?regex=%5C%2Ff%5C%2F%5BA-Za-z0-9_-%5D%2B%23k%3D%5BA-Za-z0-9_-%5D%7B43%7D%24&testString=%2Ff%2Fabc%23k%3Dq3-_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%0A%2Ff%2Fabc
    expect(shareUrl).toMatch(/\/f\/[A-Za-z0-9_-]+#k=[A-Za-z0-9_-]{43}$/);
    expect(rawPostData).not.toContain(new URL(shareUrl).hash.slice('#k='.length));

    const downloaderContext = await browser.newContext();
    const downloaderPage = await downloaderContext.newPage();

    downloaderPage.on('console', (msg) => console.log(`[Downloader ${msg.type()}]: ${msg.text()}`));
    downloaderPage.on('pageerror', (err) => console.log(`[Downloader Exception]: ${err.message}`));
    // The app logs which saving method the browser used: '[FileHolder] Saved "name" via <method>.'
    const savedVia = new Promise<string>((resolve) => {
      downloaderPage.on('console', (msg) => {
        if (msg.text().startsWith('[FileHolder] Saved')) resolve(msg.text());
      });
    });

    await downloaderPage.goto(shareUrl);

    // Initial state: the link's key is taken out of the address bar, the passkey prompt shows, files are hidden
    await expect(downloaderPage.getByText('Passkey Required')).toBeVisible();
    expect(new URL(downloaderPage.url()).hash).toBe('');
    await expect(downloaderPage.getByText(testFile1.name)).not.toBeVisible();
    await expect(downloaderPage.getByText(testFile2.name)).not.toBeVisible();

    // Wrong passkey challenge rejection
    const vaultPasswordInput = downloaderPage.locator('input[type="password"]');
    await vaultPasswordInput.fill('WrongPassphrase!');
    await downloaderPage.getByRole('button', { name: /Unlock Files/i }).click();
    await expect(downloaderPage.getByText('Incorrect passkey', { exact: false })).toBeVisible();

    // Correct password unlocks manifest
    await vaultPasswordInput.fill('ClassifiedPass123!');
    await downloaderPage.getByRole('button', { name: /Unlock Files/i }).click();

    await expect(downloaderPage.getByText(testFile1.name)).toBeVisible();
    await expect(downloaderPage.getByText(testFile2.name)).toBeVisible();

    // Download All as ZIP: verifies in-browser decrypted zip reconstruction
    const downloadPromise = downloaderPage.waitForEvent('download');
    await downloaderPage.getByRole('button', { name: /Download All.*ZIP/i }).click();

    const downloadErrorBanner = downloaderPage.locator('[data-variant="error"]');
    const download = await Promise.race([
      downloadPromise,
      downloadErrorBanner.waitFor({ state: 'visible', timeout: 30000 }).then(async () => {
        const errorText = await downloadErrorBanner.textContent();
        throw new Error(`Download ZIP failed on UI with error message: "${errorText}"`);
      }),
    ]);

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

    // The ZIP is built as a stream and saved like a single file; Chromium must do that through the worker.
    const method = await savedVia;
    console.log(`[${browserName}] ${method}`);
    if (browserName === 'chromium') {
      expect(method).toContain('via service-worker');
    }

    await downloaderContext.close();
  });

  test('5. Streaming Architecture: Multi-File E2EE Bundles Exceeding 200 MB Are Permitted With Passkey', async ({ page }) => {
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

      const e2eCheckbox = page.getByRole('checkbox', { name: 'End-to-end encryption' });
      await e2eCheckbox.click();
      await expect(e2eCheckbox).toBeChecked();

      // Assert: No 200 MB warning banner appears in the new streaming architecture
      const warningBanner = page.locator('[data-variant="warning"]');
      await expect(warningBanner).not.toBeVisible();

      // The link carries the key, so no passkey is needed by default
      const submitBtn = page.getByRole('button', { name: /Generate Shareable Link/i });
      await expect(submitBtn).toBeEnabled();

      // Once a passkey is required, submit is disabled until it is entered
      await page.getByRole('checkbox', { name: 'Also require a passkey' }).click();
      await expect(submitBtn).toBeDisabled();

      // Entering passkey enables the submit button for 220 MB payload
      const passwordInput = page.locator('input[type="password"]');
      await passwordInput.fill('VaultPass123!');
      await expect(submitBtn).toBeEnabled();
    } finally {
      // Isolated teardown strictly scoped to this test
      if (fs.existsSync(bigFile1Path)) fs.unlinkSync(bigFile1Path);
      if (fs.existsSync(bigFile2Path)) fs.unlinkSync(bigFile2Path);
    }
  });

  test('6. Chunked E2EE: a multipart encrypted file uploads to real storage and decrypts back byte for byte @cross-browser', async ({ page, browser, browserName }) => {
    const MIB = 1024 * 1024;
    const ENCRYPTED_CHUNK_BYTES = 4 * MIB + 16;
    const TEST_TIMEOUT_MS = 180_000;
    const TRANSFER_TIMEOUT_MS = 120_000;
    const PATTERN_LENGTH = 251;
    const PROBE_TIMEOUT_MS = 5_000;
    test.setTimeout(TEST_TIMEOUT_MS);

    // Over the 50 MB multipart threshold, so the server sizes parts as whole encrypted chunks (16 MiB + 64 bytes)
    // and storage checks every part against the size its URL was signed for. The odd tail ends mid-chunk.
    const fileName = 'chunked-e2ee.bin';
    const filePath = path.join(path.resolve(process.cwd(), 'e2e'), fileName);
    const sizeBytes = 60 * MIB + 12345;
    const pattern = Buffer.from(Array.from({ length: PATTERN_LENGTH }, (_, i) => i));
    const content = Buffer.alloc(sizeBytes, pattern);
    fs.writeFileSync(filePath, content);
    const expectedSha256 = createHash('sha256').update(content).digest('hex');

    try {
      await page.goto('/');
      await page.getByPlaceholder(/e.g. Project Deliverables v1/i).fill('Chunked E2EE');
      await page.locator('input[type="file"]').setInputFiles([filePath]);
      await expect(page.getByText('Selected Files (1)')).toBeVisible();
      await page.getByRole('checkbox', { name: 'End-to-end encryption' }).click();
      await page.getByRole('checkbox', { name: 'Also require a passkey' }).click();
      await page.locator('input[type="password"]').fill('ChunkedPass123!');

      const presignResponsePromise = page.waitForResponse((res) => res.url().includes('/api/v1/files/presign') && res.request().method() === 'POST');
      await page.getByRole('button', { name: /Generate Shareable Link/i }).click();

      const presign = await (await presignResponsePromise).json();
      expect(presign.items[0].uploadMode).toBe('Multipart');
      expect(presign.items[0].partSizeBytes % ENCRYPTED_CHUNK_BYTES).toBe(0);

      const shareLinkInput = page.locator('input[readonly]');
      const errorBanner = page.locator('[data-variant="error"]');
      await Promise.race([
        shareLinkInput.waitFor({ state: 'visible', timeout: TRANSFER_TIMEOUT_MS }),
        errorBanner.waitFor({ state: 'visible', timeout: TRANSFER_TIMEOUT_MS }).then(async () => {
          throw new Error(`Upload failed on UI with error message: "${await errorBanner.textContent()}"`);
        }),
      ]);
      const shareUrl = await shareLinkInput.inputValue();

      const downloaderContext = await browser.newContext();
      const downloaderPage = await downloaderContext.newPage();
      // The app logs which saving method the browser used: '[FileHolder] Saved "name" via <method>.'
      const savedVia = new Promise<string>((resolve) => {
        downloaderPage.on('console', (msg) => {
          const text = msg.text();
          if (text.startsWith('[FileHolder] Saved')) resolve(text);
        });
      });
      await downloaderPage.goto(shareUrl);
      await downloaderPage.locator('input[type="password"]').fill('ChunkedPass123!');
      await downloaderPage.getByRole('button', { name: /Unlock Files/i }).click();
      await expect(downloaderPage.getByText(fileName)).toBeVisible();

      // A one-file bundle offers "Download File" (decrypted in the browser) rather than a ZIP.
      const downloadPromise = downloaderPage.waitForEvent('download', { timeout: TRANSFER_TIMEOUT_MS });
      await downloaderPage.getByRole('button', { name: /^Download File$/i }).click();
      const download = await downloadPromise;

      expect(download.suggestedFilename()).toBe(fileName);
      const decrypted = fs.readFileSync((await download.path())!);
      expect(decrypted.length).toBe(sizeBytes);
      expect(createHash('sha256').update(decrypted).digest('hex')).toBe(expectedSha256);

      const method = await savedVia;
      console.log(`[${browserName}] ${method}`);
      // Chromium must stream through the service worker; a silent fallback would hide a broken worker.
      if (browserName === 'chromium') {
        expect(method).toContain('via service-worker');
      }

      // Diagnostics only, never fails the test: which disk-storage features this engine offers to the page and
      // to a worker (createSyncAccessHandle only exists in workers), to guide saving on engines that fall back.
      const storageFeatures = await downloaderPage.evaluate(async (probeTimeoutMs: number) => {
        const describe = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        const page: Record<string, string> = { secureContext: String(isSecureContext), getDirectory: typeof navigator.storage?.getDirectory };
        try {
          const root = await navigator.storage.getDirectory();
          const handle = await root.getFileHandle('feature-probe-page', { create: true });
          page.createWritable = typeof (handle as Partial<FileSystemFileHandle>).createWritable;
          await root.removeEntry('feature-probe-page');
        } catch (err) {
          page.error = describe(err);
        }

        const workerSource = `self.onmessage = async () => {
          const result = {};
          try {
            const root = await navigator.storage.getDirectory();
            const handle = await root.getFileHandle('feature-probe-worker', { create: true });
            result.createSyncAccessHandle = typeof handle.createSyncAccessHandle;
            result.createWritable = typeof handle.createWritable;
            if (typeof handle.createSyncAccessHandle === 'function') {
              const access = await handle.createSyncAccessHandle();
              access.write(new Uint8Array([1, 2, 3]), { at: 0 });
              access.flush();
              result.syncWriteBytes = String(access.getSize());
              access.close();
            }
            await root.removeEntry('feature-probe-worker');
          } catch (err) {
            result.error = err.name + ': ' + err.message;
          }
          postMessage(result);
        };`;
        const worker = await new Promise<Record<string, string>>((resolve) => {
          try {
            const probe = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
            probe.onmessage = (event) => resolve(event.data);
            probe.onerror = (event) => resolve({ workerError: event.message });
            probe.postMessage('probe');
            setTimeout(() => resolve({ timeout: 'no answer in 5 s' }), probeTimeoutMs);
          } catch (err) {
            resolve({ workerError: describe(err) });
          }
        });
        return { page, worker };
      }, PROBE_TIMEOUT_MS).catch((err: unknown) => ({ probeFailed: String(err) }));
      console.log(`[${browserName}] storage features: ${JSON.stringify(storageFeatures)}`);

      await downloaderContext.close();
    } finally {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  });

  test('7. Link-key E2EE (#61): the link alone opens the files, and a link without its key is refused without asking the server @cross-browser', async ({ page, browser }) => {
    const UPLOAD_TIMEOUT_MS = 30_000;
    const LINK_KEY_PREFIX = '#k=';

    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles([testFile1]);
    await expect(page.getByText('Selected Files (1)')).toBeVisible();
    await page.getByRole('checkbox', { name: 'End-to-end encryption' }).click();

    // No passkey by default: the field isn't even shown, and the link is said to be the secret.
    await expect(page.getByRole('checkbox', { name: 'Also require a passkey' })).not.toBeChecked();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByText('The link is the secret', { exact: false })).toBeVisible();

    const confirmRequestPromise = page.waitForRequest((req) => req.url().includes('/api/v1/files/confirm') && req.method() === 'POST');
    await page.getByRole('button', { name: 'Generate Shareable Link' }).click();
    const confirmRequest = await confirmRequestPromise;
    expect(confirmRequest.postDataJSON().keyMode).toBe('LinkKey');

    const shareLinkInput = page.locator('input[readonly]');
    await expect(shareLinkInput).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS });
    await expect(page.getByText('Anyone with this link or QR code can open the files.')).toBeVisible();
    const shareUrl = await shareLinkInput.inputValue();
    const linkKey = new URL(shareUrl).hash.slice(LINK_KEY_PREFIX.length);
    expect(new URL(shareUrl).hash.startsWith(LINK_KEY_PREFIX)).toBe(true);
    expect(confirmRequest.postData() ?? '').not.toContain(linkKey);

    // A fresh browser with only the link: no prompt, the files are listed, and the key leaves the address bar.
    const recipientContext = await browser.newContext();
    const recipientPage = await recipientContext.newPage();
    await recipientPage.goto(shareUrl);
    await expect(recipientPage.getByText(testFile1.name)).toBeVisible();
    await expect(recipientPage.locator('input[type="password"]')).toHaveCount(0);
    expect(new URL(recipientPage.url()).hash).toBe('');

    const downloadPromise = recipientPage.waitForEvent('download');
    await recipientPage.getByRole('button', { name: 'Download File' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(testFile1.name);
    expect(fs.readFileSync((await download.path())!).toString()).toBe(testFile1.buffer.toString());
    await recipientContext.close();

    // The same link without its key (e.g. cut off when copied): explained, and no unlock attempt is used up.
    const cutOffContext = await browser.newContext();
    const cutOffPage = await cutOffContext.newPage();
    const unlockRequests: string[] = [];
    cutOffPage.on('request', (req) => {
      if (req.url().includes('/unlock')) unlockRequests.push(req.url());
    });
    await cutOffPage.goto(shareUrl.slice(0, shareUrl.indexOf('#')));
    await expect(cutOffPage.getByText('This link is incomplete', { exact: false })).toBeVisible();
    await expect(cutOffPage.locator('input[type="password"]')).toHaveCount(0);
    await expect(cutOffPage.getByText(testFile1.name)).not.toBeVisible();
    expect(unlockRequests).toEqual([]);
    await cutOffContext.close();
  });
});

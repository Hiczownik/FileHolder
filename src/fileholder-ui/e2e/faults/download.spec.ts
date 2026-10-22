import { test as base, expect, type BrowserContext, type Download, type Locator, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import { apiErrorsSince, bundleCounts } from './checks';
import { cutResponseAfter, failServiceWorkerRegistration, isStorageDownload } from './faults';
import {
  SMALL_ENCRYPTED_FILE_BYTES,
  TRANSFER_TIMEOUT_MS,
  collectSaveReports,
  errorBanner,
  fillUploadForm,
  sha256,
  shareTokenOf,
  submitUpload,
  waitForShareLink,
  writeTestFile,
  type TestFile,
} from './flows';

// Scenario numbers are those of issue #71. Encrypted files are saved differently per engine (streamSaving.ts), so
// the scenarios about saving run in Firefox and WebKit too.
const TEST_TIMEOUT_MS = 180_000;
const HALF = 2;
// The one cut off, then the retry.
const DOWNLOADS_IN_S7 = 2;
// One that falls back, one that uses the worker.
const DOWNLOADS_IN_S8 = 2;

/** The recipient's own browser, separate from the uploader's, closed after the test whatever its outcome. */
const test = base.extend<{ recipientContext: BrowserContext }>({
  // Not named `use`, which the React hooks lint rule would take for a hook.
  recipientContext: async ({ browser }, provide) => {
    const context = await browser.newContext();
    await provide(context);
    await context.close();
  },
});

/** Uploads one file as an end-to-end encrypted bundle opened by its link alone; returns the share link. */
async function shareEncrypted(page: Page, file: TestFile): Promise<string> {
  await fillUploadForm(page, [file], { encrypted: true });
  await submitUpload(page);
  return waitForShareLink(page);
}

/** Opens the link as the recipient; the link key unlocks the bundle without a prompt. */
async function openAsRecipient(context: BrowserContext, shareUrl: string, fileName: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(shareUrl);
  await expect(page.getByText(fileName)).toBeVisible();
  return page;
}

const downloadButton = (page: Page): Locator => page.getByRole('button', { name: 'Download File' });

// How long a download that should fail gets to end. Chromium fails one whose stream errored at once; Firefox has
// been seen to leave it pending (tested for 30 s), which keeps no file either, so both are accepted.
const DOWNLOAD_OUTCOME_WAIT_MS = 5_000;

type DownloadOutcome = 'completed' | 'failed' | 'pending';

/** How a browser download ended: completed (a file was kept), failed, or still pending after a short wait. */
async function outcomeOf(download: Download): Promise<DownloadOutcome> {
  const ended = async (): Promise<DownloadOutcome> => ((await download.failure()) === null ? 'completed' : 'failed');
  const stillPending = new Promise<DownloadOutcome>((resolve) => setTimeout(() => resolve('pending'), DOWNLOAD_OUTCOME_WAIT_MS));
  return Promise.race([ended(), stillPending]);
}

/**
 * Clicks Download File and waits for the browser's download of it, then checks it is complete and intact.
 * `dispatch` sends the click as a DOM event instead of through the mouse: once a download served by the service
 * worker has failed, Playwright's Firefox silently drops mouse clicks on the page (a click listener on the document
 * never fires), while a dispatched click works and the app behaves as it should. A real click is still the default,
 * because the "Save as" dialog Chromium may fall back to needs the user activation only a real click gives.
 */
async function downloadAndCheck(page: Page, file: TestFile, options: { readonly dispatch?: boolean } = {}): Promise<void> {
  const download = page.waitForEvent('download', { timeout: TRANSFER_TIMEOUT_MS });
  await (options.dispatch ? downloadButton(page).dispatchEvent('click') : downloadButton(page).click());
  const saved = await download;
  expect(saved.suggestedFilename()).toBe(file.name);
  expect(await saved.failure()).toBeNull();
  expect(sha256(fs.readFileSync((await saved.path()) ?? ''))).toBe(file.sha256);
}

test.describe('Network faults: downloads', () => {
  test.describe.configure({ timeout: TEST_TIMEOUT_MS });

  test('S7. A download cut off half way saves nothing as complete, and the retry uses the same counted download (#25) @cross-browser', async ({ page, recipientContext, browserName }, testInfo: TestInfo) => {
    const startedAt = new Date();
    const file = writeTestFile(testInfo, 'cut-off.bin', SMALL_ENCRYPTED_FILE_BYTES);
    const shareUrl = await shareEncrypted(page, file);

    // The first fetch of the file stops half way; the retry gets all of it.
    await cutResponseAfter(recipientContext, SMALL_ENCRYPTED_FILE_BYTES / HALF, { times: 1 });
    const recipient = await openAsRecipient(recipientContext, shareUrl, file.name);
    const reports = collectSaveReports(recipient);
    const fetches: string[] = [];
    recipient.on('request', (request) => {
      if (isStorageDownload(request)) fetches.push(request.url());
    });
    // Where the browser saves as the bytes arrive (the service worker), a download starts at once and must then
    // fail; where the page writes the file first (OPFS, on WebKit), none should start at all.
    const downloads: Download[] = [];
    recipient.on('download', (download) => downloads.push(download));

    await downloadButton(recipient).click();
    await expect(errorBanner(recipient)).toBeVisible({ timeout: TRANSFER_TIMEOUT_MS });
    await expect(errorBanner(recipient)).toContainText('connection was lost');
    expect(fetches).toHaveLength(1);
    expect(await Promise.all(downloads.map(outcomeOf)), 'no download may finish').not.toContain('completed');
    expect(reports, 'nothing reported as saved').toEqual([]);
    await expect(downloadButton(recipient)).toBeEnabled();

    const shareToken = shareTokenOf(shareUrl);
    expect(bundleCounts(shareToken)).toEqual({ downloadCount: 1, downloadSessions: 1 });

    // The retry, on the same page: the session the first attempt opened covers it.
    await downloadAndCheck(recipient, file, { dispatch: browserName === 'firefox' });
    await expect(errorBanner(recipient)).toHaveCount(0);
    await expect.poll(() => reports.length).toBe(1);
    expect(fetches).toHaveLength(DOWNLOADS_IN_S7);
    // The worker must have saved it where it is used, or the cut above never tested it (as when a route was set).
    if (browserName !== 'webkit') {
      expect(reports[0]).toContain('via service-worker');
    }
    expect(bundleCounts(shareToken), 'the retry is not counted again').toEqual({ downloadCount: 1, downloadSessions: 1 });
    expect(apiErrorsSince(startedAt)).toEqual([]);
  });

  test('S8. A service worker that failed to register is tried again on the next download (#41) @cross-browser', async ({ page, recipientContext, browserName }, testInfo: TestInfo) => {
    // WebKit holds the service worker back on purpose (SERVICE_WORKER_SAVING_ON_WEBKIT), so it never registers one.
    test.skip(browserName === 'webkit', 'WebKit never uses the service worker');
    const startedAt = new Date();
    const file = writeTestFile(testInfo, 'worker-retry.bin', SMALL_ENCRYPTED_FILE_BYTES);
    const shareUrl = await shareEncrypted(page, file);

    // Next in line after the worker is Chromium's "Save as" dialog, which a headless browser cancels at once, and
    // the app rightly takes that as the user cancelling. Without it, as in Firefox, the fallback is OPFS.
    await recipientContext.addInitScript(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await failServiceWorkerRegistration(recipientContext, { times: 1 });
    const recipient = await openAsRecipient(recipientContext, shareUrl, file.name);
    const reports = collectSaveReports(recipient);

    // The first download is saved another way, and says why the worker wasn't used.
    await downloadAndCheck(recipient, file);
    await expect.poll(() => reports.length).toBe(1);
    expect(reports[0]).not.toContain('via service-worker');
    expect(reports[0]).toContain('service-worker (the download worker could not be registered');

    // The failure isn't remembered for the page's life: the next download registers the worker and uses it.
    await downloadAndCheck(recipient, file);
    await expect.poll(() => reports.length).toBe(DOWNLOADS_IN_S8);
    expect(reports[1]).toContain('via service-worker');

    expect(bundleCounts(shareTokenOf(shareUrl))).toEqual({ downloadCount: 1, downloadSessions: 1 });
    expect(apiErrorsSince(startedAt)).toEqual([]);
  });
});

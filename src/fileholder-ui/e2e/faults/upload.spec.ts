import { test, expect, type Page, type Request } from '@playwright/test';
import { apiErrorsSince, incompleteUploads, multipartSessions } from './checks';
import {
  INTERNAL_ERROR,
  SLOW_DOWN,
  apiCall,
  failRequests,
  holdRequests,
  isPartUpload,
  partKey,
} from './faults';
import {
  MULTIPART_FILE_BYTES,
  deferred,
  downloadOnlyFile,
  fillUploadForm,
  sha256,
  submitUpload,
  waitForShareLink,
  waitForUploadError,
  writeTestFile,
} from './flows';

// Scenario numbers are those of issue #71. Every upload here is multipart: 4 parts per file.
const TEST_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS_PER_PART = 3;
const PARTS_PER_FILE = 4;
// The part that fails, in the middle of the file so earlier and later parts are in flight around it.
const FAILING_PART = 3;
// One short of giving up, so the last attempt goes through.
const FAILURES_BEFORE_SUCCESS = MAX_ATTEMPTS_PER_PART - 1;
const OFFLINE_AT_PART = 2;
// A refused first attempt, then the retry.
const ATTEMPTS_PER_SLOWED_PART = 2;

/** Requests the page sends that match, collected as they go out. */
function recordRequests(page: Page, match: (request: Request) => boolean): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => {
    if (match(request)) requests.push(request);
  });
  return requests;
}

test.describe('Network faults: uploads', () => {
  test.describe.configure({ timeout: TEST_TIMEOUT_MS });

  test('S1. A part that keeps failing stops the whole bundle, and every started upload is aborted (#45)', async ({ page }, testInfo) => {
    const startedAt = new Date();
    const files = ['a.bin', 'b.bin', 'c.bin'].map((name, seed) => writeTestFile(testInfo, name, MULTIPART_FILE_BYTES, seed));

    // b.bin's 3rd part always fails. a.bin's and c.bin's last parts wait until it has failed for good, so they are
    // still unfinished when the upload stops, however fast this machine is. Only one part each is held, so the
    // bundle's 4 parts in flight never all wait and b.bin's part 3 always gets its turn.
    const failedForGood = deferred();
    const failing = await failRequests(page, isPartUpload({ fileName: 'b.bin', partNumber: FAILING_PART }), INTERNAL_ERROR);
    const isHeldPart = (request: Request): boolean =>
      isPartUpload({ partNumber: PARTS_PER_FILE })(request) && !isPartUpload({ fileName: 'b.bin' })(request);
    await holdRequests(page, isHeldPart, failedForGood.promise);
    const aborts = recordRequests(page, apiCall('POST', 'multipart/abort'));
    const confirms = recordRequests(page, apiCall('POST', 'confirm'));

    await fillUploadForm(page, files);
    const presign = await submitUpload(page);
    expect(presign.items.map((item) => item.uploadMode)).toEqual(['Multipart', 'Multipart', 'Multipart']);

    await expect.poll(() => failing.requests.length, { timeout: TEST_TIMEOUT_MS }).toBe(MAX_ATTEMPTS_PER_PART);
    failedForGood.resolve();

    const message = await waitForUploadError(page);
    expect(message).toContain('HTTP 500), so nothing was shared');
    expect(confirms).toHaveLength(0);
    // Every upload presign started is aborted, the failing one and the two it stopped.
    await expect.poll(() => aborts.length).toBe(presign.items.length);
    expect(new Set(aborts.map((request) => request.postDataJSON().uploadId))).toEqual(new Set(presign.items.map((item) => item.uploadId)));

    const sessions = multipartSessions(presign.uploadToken);
    expect(sessions).toHaveLength(presign.items.length);
    expect(sessions.every((session) => session.isAborted && !session.isCompleted)).toBe(true);
    expect(presign.items.flatMap((item) => incompleteUploads(item.storageKey)), 'no parts left in storage').toEqual([]);
    expect(apiErrorsSince(startedAt)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Generate Shareable Link' })).toBeEnabled();
  });

  test('S2. A part that fails twice is retried and the file arrives byte for byte', async ({ page, browser }, testInfo) => {
    const startedAt = new Date();
    const file = writeTestFile(testInfo, 'retried.bin', MULTIPART_FILE_BYTES);
    const failing = await failRequests(page, isPartUpload({ partNumber: FAILING_PART }), INTERNAL_ERROR, { times: FAILURES_BEFORE_SUCCESS });

    await fillUploadForm(page, [file]);
    const presign = await submitUpload(page);
    const shareUrl = await waitForShareLink(page);

    // Two failures and the retry that went through, each to a freshly signed URL.
    expect(failing.requests).toHaveLength(MAX_ATTEMPTS_PER_PART);
    expect(new Set(failing.requests.map((request) => request.url())).size).toBe(MAX_ATTEMPTS_PER_PART);
    expect(multipartSessions(presign.uploadToken).map((session) => session.isCompleted)).toEqual([true]);

    expect(sha256(await downloadOnlyFile(browser, shareUrl))).toBe(file.sha256);
    expect(apiErrorsSince(startedAt)).toEqual([]);
  });

  test('S11. Going offline mid-upload fails clearly, never as a success, and the same form uploads once back online', async ({ page, context, browser }, testInfo) => {
    const startedAt = new Date();
    const file = writeTestFile(testInfo, 'offline.bin', MULTIPART_FILE_BYTES);

    // The connection drops as the 2nd part goes out, and stays down until the page has given up.
    let wentOffline = false;
    await page.route('**/*', async (route, request) => {
      if (!wentOffline && isPartUpload({ partNumber: OFFLINE_AT_PART })(request)) {
        wentOffline = true;
        await context.setOffline(true);
        await route.abort('internetdisconnected');
        return;
      }
      await route.fallback();
    });
    const confirms = recordRequests(page, apiCall('POST', 'confirm'));

    await fillUploadForm(page, [file]);
    const firstPresign = await submitUpload(page);
    const message = await waitForUploadError(page);
    expect(message).toContain('connection was lost');
    expect(confirms).toHaveLength(0);
    // The aborts couldn't reach the server while offline; the purge aborts these when their session expires.
    expect(multipartSessions(firstPresign.uploadToken).some((session) => session.isCompleted)).toBe(false);

    await context.setOffline(false);
    const secondPresign = await submitUpload(page);
    const shareUrl = await waitForShareLink(page);
    expect(secondPresign.uploadToken).not.toBe(firstPresign.uploadToken);
    expect(sha256(await downloadOnlyFile(browser, shareUrl))).toBe(file.sha256);
    expect(apiErrorsSince(startedAt)).toEqual([]);
  });

  test('S12. Storage answering 503 SlowDown to every part makes the upload back off, then complete', async ({ page, browser }, testInfo) => {
    const startedAt = new Date();
    const file = writeTestFile(testInfo, 'slow-down.bin', MULTIPART_FILE_BYTES);
    // Each part's first attempt is refused; its retry goes through.
    const slowed = await failRequests(page, isPartUpload(), SLOW_DOWN, { times: 1, keyOf: partKey });

    await fillUploadForm(page, [file]);
    const presign = await submitUpload(page);
    const shareUrl = await waitForShareLink(page);

    expect(slowed.requests).toHaveLength(ATTEMPTS_PER_SLOWED_PART * PARTS_PER_FILE);
    expect(multipartSessions(presign.uploadToken).map((session) => session.isCompleted)).toEqual([true]);
    expect(sha256(await downloadOnlyFile(browser, shareUrl))).toBe(file.sha256);
    expect(apiErrorsSince(startedAt)).toEqual([]);
  });
});

import { expect, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** The uploading and downloading steps the fault scenarios share. */

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
// Over the server's 50 MB multipart threshold: 4 parts of 16 MiB (the last one shorter).
const MULTIPART_FILE_MIB = 51;
export const MULTIPART_FILE_BYTES = MULTIPART_FILE_MIB * BYTES_PER_MIB;
// Encrypted files are sealed in 4 MiB chunks; 10 MiB makes three, still a single (not multipart) upload.
const SMALL_ENCRYPTED_FILE_MIB = 10;
export const SMALL_ENCRYPTED_FILE_BYTES = SMALL_ENCRYPTED_FILE_MIB * BYTES_PER_MIB;
export const TRANSFER_TIMEOUT_MS = 120_000;
// Byte patterns repeat with a prime length, so no part or chunk lines up with a repetition.
const PATTERN_LENGTH = 251;

export interface TestFile {
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Writes a file of `sizeBytes` into the test's output folder (Playwright clears it between runs). Large files go
 * through disk because Playwright caps in-memory file payloads. `seed` makes files of the same size differ, so a
 * mix-up between them can't go unnoticed.
 */
export function writeTestFile(testInfo: TestInfo, name: string, sizeBytes: number, seed = 0): TestFile {
  const pattern = Buffer.from(Array.from({ length: PATTERN_LENGTH }, (_, i) => (i * (seed + 1) + seed) % PATTERN_LENGTH));
  const content = Buffer.alloc(sizeBytes, pattern);
  const filePath = testInfo.outputPath(name);
  fs.writeFileSync(filePath, content);
  return { path: filePath, name, sizeBytes, sha256: sha256(content) };
}

export interface PresignedItem {
  readonly fileName: string;
  readonly storageKey: string;
  readonly uploadMode: 'Single' | 'Multipart';
  readonly uploadId?: string | null;
  readonly totalParts?: number | null;
}

export interface Presign {
  readonly uploadToken: string;
  readonly items: readonly PresignedItem[];
}

export interface UploadOptions {
  /** End-to-end encrypted, opened with the link alone (no passkey). */
  readonly encrypted?: boolean;
}

/** Opens the upload page and fills it in with these files, ready to submit. */
export async function fillUploadForm(page: Page, files: readonly TestFile[], options: UploadOptions = {}): Promise<void> {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(files.map((file) => file.path));
  await expect(page.getByText(`Selected Files (${files.length})`)).toBeVisible();
  if (options.encrypted) {
    await page.getByRole('checkbox', { name: 'End-to-end encryption' }).click();
  }
}

/** Submits the filled-in form; resolves with presign's answer, which names the uploads the app then starts. */
export async function submitUpload(page: Page): Promise<Presign> {
  const presignResponse = page.waitForResponse((res) => res.url().endsWith('/api/v1/files/presign') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Generate Shareable Link' }).click();
  return (await presignResponse).json() as Promise<Presign>;
}

export const errorBanner = (page: Page): Locator => page.locator('[data-variant="error"]');
const shareLinkInput = (page: Page): Locator => page.locator('input[readonly]');

/** Waits for the share link; fails with the page's error message if an error shows instead. */
export async function waitForShareLink(page: Page, timeout = TRANSFER_TIMEOUT_MS): Promise<string> {
  await expect(shareLinkInput(page).or(errorBanner(page))).toBeVisible({ timeout });
  if (await errorBanner(page).isVisible()) {
    throw new Error(`Upload failed on the page: "${await errorBanner(page).textContent()}"`);
  }
  return shareLinkInput(page).inputValue();
}

/** Waits for the upload to fail; fails if a share link shows instead. Returns the message shown. */
export async function waitForUploadError(page: Page, timeout = TRANSFER_TIMEOUT_MS): Promise<string> {
  await expect(shareLinkInput(page).or(errorBanner(page))).toBeVisible({ timeout });
  await expect(shareLinkInput(page), 'the upload must not report success').toHaveCount(0);
  return (await errorBanner(page).textContent()) ?? '';
}

/** The share token in a link like http://localhost:3000/f/{token}#k=… */
export const shareTokenOf = (shareUrl: string): string => new URL(shareUrl).pathname.split('/').pop() ?? '';

/** Opens a plain (unencrypted, no password) one-file bundle in a fresh browser and downloads its file. */
export async function downloadOnlyFile(browser: Browser, shareUrl: string): Promise<Buffer> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(shareUrl);
    const download = page.waitForEvent('download', { timeout: TRANSFER_TIMEOUT_MS });
    await page.getByRole('button', { name: 'Download File' }).click();
    return fs.readFileSync((await (await download).path()) ?? '');
  } finally {
    await context.close();
  }
}

/** A promise with its resolve function, for a test to say when something it waits on has happened. */
export function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Collects the app's '[FileHolder] Saved "name" via <method>…' console lines, which say how each download was saved. */
export function collectSaveReports(page: Page): string[] {
  const reports: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('[FileHolder] Saved')) reports.push(message.text());
  });
  return reports;
}

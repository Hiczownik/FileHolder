import { test, expect, type APIResponse, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import JSZip from 'jszip';

/** The UI pages' security headers (#130, nginx.conf.template), and that the app runs under its CSP untouched. */

const UPLOAD_TIMEOUT_MS = 30_000;
const JOURNEY_TIMEOUT_MS = 90_000;
const HTTP_OK = 200;
// Any 8-character token: nginx answers every path with the app, so the page's headers don't depend on a real bundle.
const SOME_SHARE_PATH = '/f/AbCd1234';
// How browsers report a blocked resource in the console. Matches Chromium's and WebKit's "… violates the following
// Content Security Policy directive" and Firefox's "Content-Security-Policy: The page's settings blocked …";
// rejects "Failed to load resource".
// https://regex101.com/?regex=Content%5B-%20%5DSecurity%5B-%20%5DPolicy&flags=i&testString=Refused%20to%20connect%20because%20it%20violates%20the%20following%20Content%20Security%20Policy%20directive%0AContent-Security-Policy%3A%20The%20page%E2%80%99s%20settings%20blocked%20the%20loading%20of%20a%20resource%0AFailed%20to%20load%20resource
const CSP_CONSOLE_MESSAGE = /Content[- ]Security[- ]Policy/i;
// WebKit's console line for a blocked inline style (see watchCspViolations).
const WEBKIT_STYLE_REPORT = 'Refused to apply a stylesheet because its hash, its nonce, or \'unsafe-inline\'';
// The built entry script as index.html references it. Matches src="/assets/index-BA-CNldm.js" (capturing the path),
// rejects src="/theme-init.js".
// https://regex101.com/?regex=src%3D%22(%5C%2Fassets%5C%2F%5B%5E%22%5D%2B%5C.js)%22&testString=%3Cscript%20type%3D%22module%22%20crossorigin%20src%3D%22%2Fassets%2Findex-BA-CNldm.js%22%3E%3C%2Fscript%3E%0A%3Cscript%20src%3D%22%2Ftheme-init.js%22%3E%3C%2Fscript%3E
const BUILT_SCRIPT = /src="(\/assets\/[^"]+\.js)"/;
// Whitespace between a directive's name and its sources. Matches the gaps in "script-src 'self'  'wasm-unsafe-eval'";
// "script-src" alone has none.
// https://regex101.com/?regex=%5Cs%2B&flags=g&testString=script-src%20'self'%20%20'wasm-unsafe-eval'%0Ascript-src
const WHITESPACE = /\s+/;
// connect-src: the app itself and one storage origin (STORAGE_PUBLIC_URL), filled in when the container started.
// Matches "'self' http://localhost:9000", rejects "'self' ${STORAGE_PUBLIC_URL}" (left unfilled) and
// "'self' http://localhost:9000/bucket".
// https://regex101.com/?regex=%5E'self'%20https%3F%3A%5C%2F%5C%2F%5B%5E%5Cs%2F%5D%2B%24&flags=gm&testString='self'%20http%3A%2F%2Flocalhost%3A9000%0A'self'%20%24%7BSTORAGE_PUBLIC_URL%7D%0A'self'%20http%3A%2F%2Flocalhost%3A9000%2Fbucket
const CONNECT_SRC = /^'self' https?:\/\/[^\s/]+$/;

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

/** The policy's directives by name, e.g. { 'script-src': "'self' 'wasm-unsafe-eval'" }. */
function directivesOf(policy: string): Map<string, string> {
  return new Map(policy.split(';').map((directive) => directive.trim()).filter(Boolean).map((directive) => {
    const [name, ...sources] = directive.split(WHITESPACE);
    return [name, sources.join(' ')];
  }));
}

function expectUiHeaders(response: APIResponse, what: string): void {
  expect(response.status(), what).toBe(HTTP_OK);
  const headers = response.headers();
  expect(headers['x-frame-options'], what).toBe('DENY');
  expect(headers['x-content-type-options'], what).toBe('nosniff');
  expect(headers['referrer-policy'], what).toBe('no-referrer');

  const directives = directivesOf(headers['content-security-policy'] ?? '');
  expect(directives.get('default-src'), what).toBe("'self'");
  expect(directives.get('script-src'), what).toBe("'self' 'wasm-unsafe-eval'");
  expect(directives.get('style-src'), what).toBe("'self'");
  expect(directives.get('object-src'), what).toBe("'none'");
  expect(directives.get('base-uri'), what).toBe("'none'");
  expect(directives.get('frame-ancestors'), what).toBe("'none'");
  expect(directives.get('connect-src'), what).toMatch(CONNECT_SRC);
}

/**
 * Records every CSP violation in this context's pages: the securitypolicyviolation events the page sees, and the
 * browser's console reports, which also cover what the page can't see (workers). Call the result once the journey
 * is done.
 *
 * Two kinds of report come from the browser or Playwright rather than the app, and are left out:
 * - Playwright's WebKit reports style-src-attr for every <select> as React creates it: its own built-in parts of the
 *   control carry inline styles. The selects look exactly the same with and without the policy. Its console line
 *   for these ("Refused to apply a stylesheet …") is left out too; the event above still catches the app's own.
 * - A <style> with no source file: Playwright adds one to hide the caret when it takes a screenshot. The app's
 *   scripts always have a source file.
 */
async function watchCspViolations(context: BrowserContext): Promise<() => Promise<string[]>> {
  const consoleReports: string[] = [];
  context.on('console', (message) => {
    const text = message.text();
    if (CSP_CONSOLE_MESSAGE.test(text) && !text.startsWith(WEBKIT_STYLE_REPORT)) consoleReports.push(text);
  });
  await context.addInitScript(() => {
    const reports: string[] = [];
    window.__cspViolations = reports;
    document.addEventListener('securitypolicyviolation', (event) => {
      const element = event.target instanceof Element ? event.target.tagName : '';
      const fromSelectInternals = event.effectiveDirective === 'style-src-attr' && element === 'SELECT';
      const fromPlaywright = event.effectiveDirective.startsWith('style-src') && !event.sourceFile;
      if (!fromSelectInternals && !fromPlaywright) {
        reports.push(`${event.effectiveDirective} blocked ${event.blockedURI || '(inline)'} on ${element || 'the page'}, from ${event.sourceFile}:${event.lineNumber}`);
      }
    });
  });
  return async () => {
    const fromPages = await Promise.all(context.pages().map((page) => page.evaluate(() => window.__cspViolations ?? [])));
    return [...fromPages.flat(), ...consoleReports];
  };
}

test.describe('UI security headers (#130)', () => {
  test('the pages, a share link, built assets and the download worker all carry the headers', async ({ request }) => {
    const home = await request.get('/');
    expectUiHeaders(home, '/');
    expectUiHeaders(await request.get(SOME_SHARE_PATH), SOME_SHARE_PATH);
    expectUiHeaders(await request.get('/download-sw.js'), '/download-sw.js');

    const builtScript = BUILT_SCRIPT.exec(await home.text())?.[1];
    expect(builtScript, 'index.html references a built script').toBeTruthy();
    expectUiHeaders(await request.get(builtScript!), builtScript!);
  });

  test('API responses keep only the API\'s own headers, not a second set from nginx', async ({ request }) => {
    const response = await request.get(`/api/v1/files${SOME_SHARE_PATH.slice('/f'.length)}`);
    const count = (name: string): number => response.headersArray().filter((header) => header.name.toLowerCase() === name).length;

    expect(count('content-security-policy')).toBe(1);
    expect(count('x-frame-options')).toBe(1);
    expect(count('referrer-policy')).toBe(1);
    // SecurityHeadersMiddleware's policy, not the UI's.
    expect(response.headers()['content-security-policy']).not.toContain('frame-ancestors');
  });

  test('an encrypted bundle with a passkey uploads, unlocks and downloads without a single CSP violation @cross-browser', async ({ browser, browserName }) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS);
    const passkey = 'CspJourney-2026!';
    const files = [
      { name: 'csp-1.txt', mimeType: 'text/plain', buffer: Buffer.from('First file under the policy') },
      { name: 'csp-2.txt', mimeType: 'text/plain', buffer: Buffer.from('Second file under the policy') },
    ];

    // Uploading: the passkey is stretched with Argon2id (WebAssembly in a worker), the files go straight to storage.
    const uploaderContext = await browser.newContext();
    const uploaderViolations = await watchCspViolations(uploaderContext);
    const page = await uploaderContext.newPage();
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(files);
    await expect(page.getByText('2 files', { exact: true })).toBeVisible();
    await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
    await page.getByRole('switch', { name: 'Also require a passkey' }).click();
    await page.getByLabel('Passkey', { exact: true }).fill(passkey);
    await page.getByRole('button', { name: 'Create share link' }).click();

    const shareLinkInput = page.getByLabel('Share link');
    await expect(shareLinkInput).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS });
    const shareUrl = await shareLinkInput.inputValue();
    // The QR code is drawn as inline SVG, so img-src needs nothing beyond 'self'.
    await page.getByText('Show QR code').click();
    await expect(page.locator('svg').filter({ has: page.locator('title', { hasText: 'QR code for the share link' }) })).toBeVisible();

    // Downloading in a fresh browser: Argon2id again, decrypted in the page, saved through the service worker,
    // a Save as dialog or OPFS, whichever this browser uses.
    const recipientContext = await browser.newContext();
    const recipientViolations = await watchCspViolations(recipientContext);
    const recipient = await recipientContext.newPage();
    const savedVia = new Promise<string>((resolve) => {
      recipient.on('console', (message) => {
        if (message.text().startsWith('[FileHolder] Saved')) resolve(message.text());
      });
    });
    await recipient.goto(shareUrl);
    await recipient.locator('input[type="password"]').fill(passkey);
    await recipient.getByRole('button', { name: 'Unlock files' }).click();
    await expect(recipient.getByText(files[0].name)).toBeVisible();

    const downloadPromise = recipient.waitForEvent('download');
    await recipient.getByRole('button', { name: 'Download all as ZIP' }).click();
    const download = await downloadPromise;
    const zip = await JSZip.loadAsync(fs.readFileSync((await download.path())!));
    const contents = await Promise.all(files.map((file) => zip.file(file.name)?.async('string')));
    expect(contents).toEqual(files.map((file) => file.buffer.toString()));
    console.log(`[${browserName}] ${await savedVia}`);

    expect(await uploaderViolations(), 'CSP violations while uploading').toEqual([]);
    expect(await recipientViolations(), 'CSP violations while downloading').toEqual([]);
    await uploaderContext.close();
    await recipientContext.close();
  });
});

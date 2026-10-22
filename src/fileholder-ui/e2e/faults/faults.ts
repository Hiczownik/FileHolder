import type { BrowserContext, Page, Request, Route } from '@playwright/test';

/**
 * Faults injected between the browser and the API or storage, by intercepting the browser's requests (Layer 1 of
 * issue #71). Each helper only handles the requests its matcher picks and falls back for the rest, so several can
 * be combined on one page; the last one added is asked first.
 */

/** Where presigned URLs point: Storage:PublicBaseUrl in docker-compose.yml. */
export const STORAGE_ORIGIN = 'http://localhost:9000';
export const API_FILES_PATH = '/api/v1/files/';

export type FaultTarget = Page | BrowserContext;
export type RequestMatcher = (request: Request) => boolean;

/** An HTTP error response, or the connection failing without one. */
export type Fault = { readonly status: number; readonly body?: string; readonly contentType?: string } | 'abort';

const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** What storage answers when a client sends too fast; S3 clients are expected to back off and retry. */
export const SLOW_DOWN: Fault = {
  status: HTTP_SERVICE_UNAVAILABLE,
  contentType: 'application/xml',
  body: '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>',
};

export const INTERNAL_ERROR: Fault = {
  status: HTTP_INTERNAL_SERVER_ERROR,
  contentType: 'application/xml',
  body: '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>',
};

/** The requests a helper acted on, in order, to check what the app sent (e.g. how often it retried). */
export interface FaultLog {
  readonly requests: readonly Request[];
}

const isStorage = (request: Request): boolean => new URL(request.url()).origin === STORAGE_ORIGIN;

/**
 * A part of a multipart upload: PUT {storage}/{bucket}/uploads/{id}_{fileName}?partNumber=N&uploadId=…, optionally
 * only part N, or only parts of the file with this name (plain uploads keep the name in the storage key).
 */
export const isPartUpload = (only: { readonly partNumber?: number; readonly fileName?: string } = {}): RequestMatcher => (request) => {
  if (!isStorage(request) || request.method() !== 'PUT') return false;
  const url = new URL(request.url());
  const partNumber = url.searchParams.get('partNumber');
  if (partNumber === null) return false;
  return (only.partNumber === undefined || partNumber === String(only.partNumber))
    && (only.fileName === undefined || decodeURIComponent(url.pathname).endsWith(`_${only.fileName}`));
};

/** A file fetched from storage with a presigned GET URL. */
export const isStorageDownload: RequestMatcher = (request) => isStorage(request) && request.method() === 'GET';

/** An API call, e.g. apiCall('POST', 'multipart/abort'). */
export const apiCall = (method: string, pathAfterFiles: string): RequestMatcher => (request) =>
  request.method() === method && new URL(request.url()).pathname === `${API_FILES_PATH}${pathAfterFiles}`;

/** Identifies one part of one upload, whatever its URL's signature: retries are sent to a freshly signed URL. */
export const partKey = (request: Request): string => {
  const params = new URL(request.url()).searchParams;
  return `${params.get('uploadId')}#${params.get('partNumber')}`;
};

const answer = (route: Route, fault: Fault): Promise<void> =>
  fault === 'abort'
    ? route.abort('connectionreset')
    : route.fulfill({ status: fault.status, contentType: fault.contentType, body: fault.body ?? '' });

// Matches what Playwright throws when answering a request that is already gone: "Request was cancelled",
// "Target page, context or browser has been closed". Doesn't match a real failure like "Route is already handled!".
// https://regex101.com/?regex=cancel%7Cclosed&flags=i&testString=Request%20was%20cancelled%0ATarget%20page%2C%20context%20or%20browser%20has%20been%20closed%0ARoute%20is%20already%20handled!
const REQUEST_GONE = /cancel|closed/i;

/** The request may have been cancelled by the page meanwhile (e.g. an upload stopped), which is no error here. */
const quietly = async (action: () => Promise<void>): Promise<void> => {
  try {
    await action();
  } catch (err: unknown) {
    if (!(err instanceof Error) || !REQUEST_GONE.test(err.message)) throw err;
  }
};

async function intercept(target: FaultTarget, handle: (route: Route, request: Request) => Promise<boolean>): Promise<void> {
  await target.route('**/*', async (route, request) => {
    if (!(await handle(route, request))) {
      await route.fallback();
    }
  });
}

/**
 * Fails the first `times` attempts at each matching request, counted per `keyOf` (by default all matching requests
 * share one count). `times: Infinity` fails them for good.
 */
export async function failRequests(
  target: FaultTarget,
  match: RequestMatcher,
  fault: Fault,
  options: { readonly times?: number; readonly keyOf?: (request: Request) => string } = {}
): Promise<FaultLog> {
  const { times = Infinity, keyOf = () => '' } = options;
  const attempts = new Map<string, number>();
  const requests: Request[] = [];
  await intercept(target, async (route, request) => {
    if (!match(request)) return false;
    requests.push(request);
    const key = keyOf(request);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    if (attempt > times) return false;
    await quietly(() => answer(route, fault));
    return true;
  });
  return { requests };
}

/** Fails only the n-th matching request (1-based); every other one goes through. */
export async function failNthRequest(target: FaultTarget, match: RequestMatcher, n: number, fault: Fault): Promise<FaultLog> {
  let seen = 0;
  const requests: Request[] = [];
  await intercept(target, async (route, request) => {
    if (!match(request)) return false;
    requests.push(request);
    seen += 1;
    if (seen !== n) return false;
    await quietly(() => answer(route, fault));
    return true;
  });
  return { requests };
}

/** Sends each matching request on only after `ms`. */
export async function delayRequests(target: FaultTarget, match: RequestMatcher, ms: number): Promise<FaultLog> {
  const requests: Request[] = [];
  await intercept(target, async (route, request) => {
    if (!match(request)) return false;
    requests.push(request);
    await new Promise((resolve) => setTimeout(resolve, ms));
    await quietly(() => route.fallback());
    return true;
  });
  return { requests };
}

/**
 * Holds each matching request until `release` settles, then sends it on, so a test can decide exactly what happens
 * first instead of racing real timings. Requests the page cancels meanwhile are dropped.
 */
export async function holdRequests(target: FaultTarget, match: RequestMatcher, release: Promise<unknown>): Promise<FaultLog> {
  const requests: Request[] = [];
  await intercept(target, async (route, request) => {
    if (!match(request)) return false;
    requests.push(request);
    await release.catch(() => undefined);
    await quietly(() => route.fallback());
    return true;
  });
  return { requests };
}

/**
 * Drops the connection of the page's first `times` file downloads from storage after `bytes`: the body stops with
 * the TypeError a browser gives for a lost connection. Must be called before the page loads.
 *
 * Done inside the page rather than with a route: Playwright's request interception makes Chromium send requests
 * past service workers (with a route set on the context, the worker never served a download, even after
 * `unrouteAll`), so the download worker could not serve the download being tested. Don't combine the route-based
 * helpers with a download that should use the worker.
 */
export async function cutResponseAfter(target: FaultTarget, bytes: number, options: { readonly times?: number } = {}): Promise<void> {
  await target.addInitScript(({ origin, limit, times }) => {
    const realFetch = window.fetch.bind(window);
    let cut = 0;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await realFetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const isDownload = url.origin === origin && (init?.method ?? 'GET') === 'GET';
      if (!isDownload || !response.body || cut >= times) return response;
      cut += 1;

      const reader = response.body.getReader();
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (sent + value.byteLength >= limit) {
            controller.enqueue(value.subarray(0, limit - sent));
            controller.error(new TypeError('network error'));
            await reader.cancel();
            return;
          }
          sent += value.byteLength;
          controller.enqueue(value);
        },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  }, { origin: STORAGE_ORIGIN, limit: bytes, times: options.times ?? Number.MAX_SAFE_INTEGER });
}

/**
 * Makes the page's first `times` service worker registrations fail with the TypeError a browser gives when the
 * worker's script can't be fetched. Must be called before the page loads.
 *
 * Done inside the page rather than by failing /download-sw.js with a route: with a route set on the context, the
 * worker that then registered never served a download in Chromium, even after `unrouteAll` (see cutResponseAfter).
 */
export async function failServiceWorkerRegistration(target: FaultTarget, options: { readonly times?: number } = {}): Promise<void> {
  await target.addInitScript(({ times }) => {
    const container = navigator.serviceWorker as ServiceWorkerContainer | undefined;
    if (!container) return;
    const realRegister = container.register.bind(container);
    let failed = 0;
    container.register = (scriptURL: string | URL, options?: RegistrationOptions): Promise<ServiceWorkerRegistration> => {
      if (failed >= times) return realRegister(scriptURL, options);
      failed += 1;
      return Promise.reject(new TypeError(`Failed to register a ServiceWorker: A bad HTTP response code (500) was received when fetching the script.`));
    };
  }, { times: options.times ?? Number.MAX_SAFE_INTEGER });
}

/** Takes the whole browser context offline for `ms`, as if the network dropped, then back online. */
export async function goOfflineFor(context: BrowserContext, ms: number): Promise<void> {
  await context.setOffline(true);
  try {
    await new Promise((resolve) => setTimeout(resolve, ms));
  } finally {
    await context.setOffline(false);
  }
}

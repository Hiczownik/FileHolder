# Network-fault tests

These tests break the network on purpose while files upload and download, then check that FileHolder fails safely (issue #71):

- nothing is left behind (no unfinished multipart uploads in storage);
- no failed save is counted as a download;
- the page shows a clear message;
- it works again once the network is back.

This folder holds **Layer 1**: the browser's own requests are failed, delayed or cut with Playwright's request interception (`page.route`). The stack needs nothing extra.

## Running them

Start the stack as CI does. The CI override raises the rate limits, since every test request comes from one address. Then run the `faults` projects:

```powershell
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --build api ui
cd src/fileholder-ui
npx playwright test --project="faults*"
```

`faults` runs every scenario in Chromium. `faults-firefox` and `faults-webkit` run only those tagged `@cross-browser`, because saving a download works differently per engine (`streamSaving.ts`). The other projects skip this folder, and CI's `npx playwright test` runs them all.

The checks read the stack's containers through `docker exec`, so `docker` must be on the PATH, and the containers must have the names fixed in `docker-compose.yml` (`fileholder-postgres`, `fileholder-minio`, `fileholder-api`). Each project runs one test at a time, because the checks share the stack's database, storage and API log.

## Files

| File | What it holds |
| :--- | :--- |
| `faults.ts` | The faults: `failRequests`, `failNthRequest`, `delayRequests`, `holdRequests`, `cutResponseAfter`, `failServiceWorkerRegistration`, `goOfflineFor`, plus request matchers (`isPartUpload`, `isStorageDownload`, `apiCall`). |
| `checks.ts` | What a scenario left behind: `multipartSessions`, `bundleCounts` (Postgres), `incompleteUploads` (storage, via `mc`), `apiErrorsSince` (`ERR`/`FTL` lines in the API log). |
| `flows.ts` | Shared steps: test files on disk, filling in and submitting the upload form, waiting for the link or the error, downloading. |
| `upload.spec.ts` | Scenarios 1, 2, 11, 12. |
| `download.spec.ts` | Scenarios 7, 8. |

## Scenarios

The numbers are those in issue #71.

| # | Fault | Checked |
| :--- | :--- | :--- |
| 1 | In a 3-file upload, one file's 3rd part always fails | The others stop, all 3 multipart uploads are aborted with nothing left in storage, no confirm, and a clear message |
| 2 | One part fails twice, then succeeds | Retried with freshly signed URLs; the downloaded file is byte-identical |
| 7 | An encrypted download is cut off half way (once) | No download finishes, an error is shown, and the retry succeeds without counting another download |
| 8 | The service worker fails to register once | The first download falls back to another saving method; the next one registers the worker and uses it |
| 11 | The browser goes offline as the 2nd part is sent | A clear "connection was lost" message and no confirm; once back online, the same form uploads |
| 12 | Storage answers `503 SlowDown` to every part's first attempt | Each part is retried once and the upload completes |

## Keeping them deterministic

No scenario depends on how fast the machine is. Faults are triggered by counting requests, never by timers. When a scenario needs one thing to happen before another, it holds requests until then (`holdRequests`). For example, in scenario 1 the other files' last parts wait until the failing part has used up its retries, so those files are still unfinished when the upload stops.

Hold only a few requests at a time. The page sends at most 4 parts at once for the whole bundle, so holding 4 would stall the upload.

## Browser quirks to know

- **Routes switch off service workers in Chromium.** Playwright's request interception makes Chromium send requests past service workers. With a route set on the context, the download worker never served a download, even after `unrouteAll`. So the two download faults work inside the page instead, with init scripts:
  - `cutResponseAfter` wraps `fetch` so the body errors after N bytes;
  - `failServiceWorkerRegistration` makes `navigator.serviceWorker.register` reject.

  Scenario 7 checks that Chromium's retry really went through the worker.
- **Headless Chromium cancels the "Save as" dialog at once.** The app rightly treats that as the user cancelling. Scenario 8 removes `showSaveFilePicker`, as Firefox lacks it, so the fallback after the worker is OPFS.
- **Firefox and failed worker downloads.** When a download served by the worker fails, Firefox leaves it pending (seen for 30 s and more) instead of failing it. Scenario 7 accepts "failed" or "pending", but never "completed". After that, Playwright's mouse clicks no longer reach the page in Firefox, so its retry click is dispatched as a DOM event. Whether real Firefox users see a stuck entry in the download panel still needs checking by hand.

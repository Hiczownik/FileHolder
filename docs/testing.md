# 🧪 Testing

## 1. Backend tests (.NET xUnit)
```bash
dotnet test FileHolder.sln
```
This runs both the unit tests (`tests/FileHolder.Tests.Unit`) and the integration tests (`tests/FileHolder.Tests.Integration`). The integration tests start PostgreSQL with Testcontainers, so **Docker must be running**. CI runs both.

## 2. Frontend unit tests (Vitest)
```bash
cd src/fileholder-ui
npm test            # once
npm run test:watch  # re-run on changes
```

## 3. Property tests (FsCheck and fast-check)
Besides examples, the rules that must hold for *any* input are tested with generated inputs. These cover file names, Content-Disposition, the stream cipher's format and tamper checks, bundle limits, password lockout and the passkey and token generators. They are the `*Properties.cs` classes in `tests/FileHolder.Tests.Unit` and the `*.properties.test.ts` files in the UI. Both suites run as part of the commands above.

* **Fixed seed in CI.** Every run, locally and on a PR, tries the same inputs (500 per property in C#, 200 in TS), so a failure always reproduces.
* **Random seed nightly.** `.github/workflows/nightly-properties.yml` runs them every night on a fresh seed, with 20,000 (C#) and 10,000 (TS) inputs per property. It can also be started from the Actions tab.
* **Shared file-name examples.** The server (`FileSecurityUtils`) and the browser (`fileNameSafety.ts`) each have a copy of the file-name rules, and both must give the same answers. `tests/vectors/file-names.json` lists names with their expected results, and both test suites check them (`FileNameVectorTests`, `fileNameVectors.test.ts`). After changing the rules in **both** copies, regenerate the file and commit it:
  ```powershell
  cd src/fileholder-ui
  $env:UPDATE_VECTORS='1'; npx vitest run fileNameVectors; Remove-Item Env:UPDATE_VECTORS
  ```

**Replaying a failure** (for example from the nightly run). Each failure prints how to rerun it:

* **C# (FsCheck):** the message says `Replay directly at failing step with (a,b,c)`. Run just that test with the triple:
  ```powershell
  $env:FSCHECK_REPLAY='(a,b,c)'; dotnet test tests/FileHolder.Tests.Unit --filter "FullyQualifiedName~<TestName>"; Remove-Item Env:FSCHECK_REPLAY
  ```
* **TypeScript (fast-check):** the test name ends `(with seed=N)`. Rerun with that seed and the same number of runs:
  ```powershell
  cd src/fileholder-ui
  $env:FC_SEED='N'; $env:FC_NUM_RUNS='10000'; npx vitest run <file> -t "<test name>" --testTimeout=600000
  Remove-Item Env:FC_SEED, Env:FC_NUM_RUNS
  ```

Once it reproduces, add the shrunk input as a plain example test next to the fix, so it stays covered whatever the seed.

## 4. End-to-end browser tests (Playwright)
The tests run against the app at `http://localhost:3000`, so start the stack first:
```bash
docker compose up -d --build
cd src/fileholder-ui
npx playwright install   # first time only: downloads the browsers
npx playwright test      # Chromium, Firefox and WebKit
```

*For interactive visual UI testing mode:*
```bash
npx playwright test --ui
```

**Network-fault tests:** `e2e/faults` breaks the network on purpose: failed parts, a dropped connection, a download cut off half way. Each test then checks that nothing is left behind or counted twice. They run with the others; to run only them, start the stack with `docker-compose.ci.yml` as well, which raises the rate limits, and use `npx playwright test --project="faults*"`. See [`e2e/faults/README.md`](../src/fileholder-ui/e2e/faults/README.md).

## 5. Load tests (k6)
k6 scenarios in `tests/load` send many requests at once. Some check the rules that only matter under concurrency: exactly `MaxDownloads` sessions however many clients race, password lockout against parallel guesses, unknown tokens never cached, and 429s with a correct `Retry-After`. Others measure capacity: many small files, 2 GiB multipart uploads, mixed traffic, 20 server ZIPs at once, and a 2-hour soak. Run them on demand, in PowerShell:
```powershell
./tests/load/run.ps1 4,5,6,9   # correctness, about 6 minutes
./tests/load/run.ps1 1,2,3,7   # capacity, about 30 minutes
```
The script starts the stack with the load-test compose files, runs k6 in a container, checks the database, Postgres connections and API and nginx logs afterwards, purges everything the run made and checks storage is left clean, and then starts the stack with its usual configuration again. Grafana's **FileHolder load tests** dashboard shows each run. See [`tests/load/README.md`](../tests/load/README.md).

## 6. Before a deploy: everything CI would run
While GitHub Actions are off, `scripts/pre-deploy-check.ps1` runs on this machine what CI, the nightly job and the security workflow would, and ends with a pass/fail summary (about 25 minutes, unattended; exit code 0 when nothing failed):
```powershell
scripts/pre-deploy-check.ps1                     # everything
scripts/pre-deploy-check.ps1 -SkipBrowserTests   # leave the running stack alone
```
1. **Tests:** .NET, Vitest, and both property suites at nightly strength (20,000 FsCheck cases, 10,000 fast-check runs).
2. **Dependency audits:** NuGet (vulnerable packages, transitive too) and npm (fails on production dependencies, warns on development ones).
3. **Browser tests:** rebuilds the dev stack from the checkout in CI's setup, runs Playwright on Chromium, Firefox and WebKit plus the fault tests, then restarts the stack with its usual files, your override included. During those ~10 minutes the stack runs CI's setup.
4. **Image scans** with Trivy (CI's version): the API and UI images, and every image production runs (Caddy, Postgres, Prometheus, Tempo), plus Silo. Fixable HIGH and CRITICAL findings fail, except those accepted with a reason and an expiry date: in `.trivyignore` for every image, or in `docker/trivy/<image>.trivyignore` for one image only. Postgres is scanned without `gosu`, which only switches users at start-up.
5. **Code and secret scans:** Semgrep with CI's rule sets, and gitleaks over the whole history.
6. **DNS** for `fileholder.app`, over HTTPS: DNSSEC, CAA, DMARC, and where `A`/`AAAA` point.

Each step's log is kept under `%TEMP%\fileholder-pre-deploy-check`; the summary names the folder.

## 7. Testing from a Phone (e.g. Safari on iPhone)
Encrypted downloads are saved differently per browser (see [Encrypted Downloads](how-it-works.md#-encrypted-downloads)), and CI can't run real Safari. To check a phone by hand, it has to reach your local stack **over HTTPS**: Safari only enables service workers and its private file storage (OPFS) on HTTPS, so a plain `http://<your-PC-IP>:3000` test would silently fall back to saving in memory and prove nothing.

1. **Run the current stack.** Older builds don't route the API through the UI: `docker compose up -d --build --force-recreate`. `--force-recreate` matters when upgrading a stack created before the compose network was pinned: otherwise compose recreates the network but only restarts the old containers on it, without their service names (`minio`, `postgres`), and `minio-init` fails with `lookup minio … no such host`. Data is kept in Docker volumes.
2. **Open two HTTPS tunnels** with [Cloudflare quick tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (free, no account; on Windows `winget install --id Cloudflare.cloudflared`), each in its own terminal. Each prints a temporary `https://….trycloudflare.com` address:
   ```bash
   cloudflared tunnel --url http://localhost:3000   # the app
   cloudflared tunnel --url http://localhost:9000   # storage: upload and download links point straight at it
   ```
3. **Point upload and download links at the storage tunnel:** copy `docker-compose.override.example.yml` to `docker-compose.override.yml` (git-ignored), put the storage tunnel's address in it (in both places: the API's links and the UI's Content-Security-Policy), then `docker compose up -d api ui`.
4. **Upload through the app tunnel's address** (on the PC is fine), so the share link uses that address too. Open the share link on the phone with `?diagnostics` added **before the `#`**, e.g. `https://….trycloudflare.com/f/AbCd1234?diagnostics#k=…`. A *Diagnostics* panel shows which saving methods the browser will try, why others are left out, the free site storage, and how the last download was saved. **Copy** puts the whole report on the clipboard.
5. **Checks:**
   - A small encrypted file downloads to *Files → Downloads* and opens; the panel says `via opfs`.
   - An encrypted file of about 1.5 GB (over the 1 GB in-memory cap) also says `via opfs`. If the page instead says the browser *can only save up to 1 GB*, the panel's *Left out up front* / *Skipped* reasons say why OPFS wasn't used.
   - *Download All* on a multi-file encrypted bundle gives a ZIP that opens in Files.
   - **Link keys:**
     - A link-only bundle opens on the phone without a prompt, both from a pasted link and by scanning the success card's QR code with the camera.
     - A bundle with *Also require a passkey* asks for the passkey only.
     - After opening, the address bar shows no `#k=…`.
     - After a reload, a link-only bundle opens again without a prompt, and a bundle with a passkey asks for the passkey again (never *"This link is incomplete"*).
   - **Photo metadata:**
     - Pick a photo from the iPhone's library in Safari. The file list shows whether iOS handed over a JPEG copy (labelled *Metadata will be removed*, and 📍 if it has a location) or the HEIC original (*Metadata can't be removed (HEIC)*).
     - After downloading, the photo shows no location in Photos or Files (swipe up or *Get Info*), and displays the right way up.
   - A tampered file must fail with an error, not save. Tamper with the stored copy (Git Bash on Windows): `scripts/tamper-stored-file.sh <share-token> [file-number] [byte-offset]`. It flips one byte (by default in the middle of the file) and prints the command that restores it.
6. **Close the tunnels** (Ctrl+C) when done: while open, anyone with an address can reach the app. Use throwaway files, and don't tunnel the storage console (port 9001). Then delete `docker-compose.override.yml` and run `docker compose up -d api ui`.

**If `cloudflared` reports it can't reach port 7844** (some networks block it), use [Tailscale](https://tailscale.com) instead. It only needs normal HTTPS, and the addresses are reachable by your own devices only:
1. Install it on the PC and the phone with the same account.
2. Turn on *MagicDNS* and *HTTPS Certificates* in the admin console.
3. Run `tailscale serve --bg --https=443 http://127.0.0.1:3000` and `tailscale serve --bg --https=8443 http://127.0.0.1:9000`.
4. Set `Storage__PublicBaseUrl` and the UI's `STORAGE_PUBLIC_URL` to `https://<your-pc>.<tailnet>.ts.net:8443` (`tailscale serve status` shows the address).
5. Stop serving afterwards with `tailscale serve reset`.

If uploads fail with `403 SignatureDoesNotMatch`, the storage tunnel isn't passing the original host name on to storage (upload links are signed for it). A named Cloudflare tunnel has a fixed host name that can be set with `--http-host-header`. Upload parts are 16 MiB and single uploads at most 50 MB, well under Cloudflare's per-request size limit.

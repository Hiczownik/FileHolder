# 🖥️ Running FileHolder

## Production
One server runs the whole app with `docker-compose.prod.yml`; files live in Cloudflare R2 ([Running on Cloudflare R2](#running-on-cloudflare-r2)).

```
 Internet ──443/80──▶ Caddy ──▶ nginx (ui) ──/api/──▶ API ──▶ PostgreSQL
                      HTTPS,     UI, CSP,              │  ╲
                      HSTS       redacted log          │   ╲──▶ Tempo (traces)
                                                       ▼
 Browser ──presigned URLs──────────────────────▶ Cloudflare R2        Prometheus ◀── /metrics
```

* **Only Caddy is published**, on 80 and 443. Docker's published ports get around a host firewall such as `ufw`, so nothing else is: the admin port (9465), Prometheus (9090) and Tempo (3200) are bound to the server's loopback, and Postgres, nginx and the API aren't published at all.
* **Caddy** (`docker/caddy/Caddyfile`) gets and renews the certificate for `SITE_ADDRESS` (Let's Encrypt, ZeroSSL as the fallback), redirects HTTP to HTTPS, adds `Strict-Transport-Security`, drops the `Server` header, and streams everything to nginx. It keeps no access log (paths hold share tokens); nginx logs them redacted. Its certificates are on the `caddy_data` volume: keep it, or every restart asks for new ones and soon hits Let's Encrypt's rate limits. **HTTP/2 is off for now** (`protocols h1 h3`): Caddy 2.11.7 is built with a Go whose HTTP/2 can be tied up by a flood of SETTINGS frames. Browsers use HTTP/1.1 or HTTP/3 meanwhile; turn it back on with the next Caddy release (`docker/trivy/caddy.trivyignore`).
* **Terms and privacy** are pages of the UI (`/terms`, `/privacy`), linked from every page's footer and under the upload button. They name the operator and contact address (`VITE_OPERATOR_NAME`, `VITE_CONTACT_EMAIL`), read the deployment's limits from the API, and describe what the code does: no stored IP addresses, retention, the providers (OVHcloud, Cloudflare) and OVHcloud's 7-day server backups. Change them together with any change to what's stored or for how long.
* **Client addresses** pass along a fixed chain: Caddy sets `X-Forwarded-For`, nginx trusts it only from Caddy's address (`TRUSTED_PROXIES`), the API only from nginx's (`KnownProxies`).
* **Hardening, on every container:** `no-new-privileges`, all Linux capabilities dropped except the few each needs (Caddy: binding 80/443; nginx and Postgres: switching to their own users), a read-only filesystem with tmpfs where they write, a memory limit (about 320 MB in use for the whole app, against limits of 2.3 GB), and logs rotated at 3 × 10 MB per container.
* **Deploys** let running ZIP downloads finish ([Networking & Rate Limits](development.md#networking--rate-limits)); `restart: unless-stopped` brings everything back after a reboot.
* **Monitoring** stays private: Prometheus keeps 7 days and Tempo 48 hours, and Grafana runs on your own computer, reaching them through an SSH tunnel (`ssh -L 9090:localhost:9090 -L 3200:localhost:3200 <server>`) or Tailscale.
* **Settings:** the server's `.env`, listed in `.env.prod.example`: the site address, the R2 bucket and token, the Postgres password, the admin token and the image version; the demo's upload limits are the defaults.
* **Images** are built on a development machine and copied to the server (`scripts/deploy.ps1`, below), so `docker-compose.prod.yml` refers to them as `fileholder-api:<version>`, `fileholder-ui:<version>` and `fileholder-sample:<version>` (the sample keeper, [Sample Bundle](#sample-bundle); the UI's Dockerfile, target `sample`).

### Deploying
```powershell
scripts/deploy.ps1 -Server fileholder            # build this checkout, copy it over, switch, check
scripts/deploy.ps1 -Server fileholder -Rollback  # back to the version before
```
`-Server` is an SSH destination, best a `Host` in `~/.ssh/config` (or set `FILEHOLDER_SERVER`). The script:
1. refuses uncommitted changes (`-AllowDirty` overrides), and checks the server has Docker Compose and its `.env`;
2. builds the three images here, tagged `<version>-<commit>` (e.g. `0.9.0-4ba83f2`);
3. copies them over SSH (`docker save`, `scp -C`, `docker load`; about 150 MB compressed, 60 MB of it the sample keeper's Node runtime), with `docker-compose.prod.yml` and the Caddy, Prometheus and Tempo configs. There's no registry; once the repository is public, images can move to GHCR;
4. sets `FILEHOLDER_VERSION` in the server's `.env`, remembers the previous version, and runs `docker compose up --wait`. **If anything doesn't come up healthy, it switches back to the previous version by itself** and fails;
5. checks the API on the server, and `https://fileholder.app/api/v1/status` (`-SiteUrl`; empty skips it), report the new commit;
6. keeps the new and the previous images, removes older ones, and logs each deploy, failure and rollback in `deploy.log` on the server.

Only the API, UI and sample keeper containers are recreated; Caddy, Postgres, Prometheus and Tempo keep running. A deploy interrupted halfway (Ctrl+C, a dropped connection) can leave a container stopped: run it again, or `docker compose -f docker-compose.prod.yml up -d` on the server.

**First time on a new server** (a fresh Debian or Ubuntu):
1. An SSH key on your computer (`ssh-keygen -t ed25519`), installed on the server, and a `Host fileholder` entry in `~/.ssh/config` with its address, user and key. Turn off password logins.
2. Docker Engine with the Compose plugin ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/)). If you deploy as a user other than root, add it to the `docker` group, which is root-equivalent on the server.
3. A firewall allowing only SSH, 80 and 443 (`ufw allow OpenSSH; ufw allow 80; ufw allow 443; ufw enable`). Docker's published ports get around it, so `docker-compose.prod.yml` publishes nothing else.
4. `/opt/fileholder`, owned by the deploying user, with a `.env` made from `.env.prod.example`.
5. DNS: `A`/`AAAA` for the site address pointing at the server, **DNS only** (not proxied by Cloudflare), so Caddy gets its certificate and sees real client addresses.
6. `scripts/deploy.ps1 -Server fileholder`. Caddy asks for the certificate on its first start, so DNS must already point at the server.
7. The sample bundle's access code ([Sample Bundle](#sample-bundle)).

**Trying it locally first:** `scripts/prod-local.ps1` runs the same setup next to the dev stack, as its own compose project with its own volumes, ports and random secrets (`.env.prod-local`). Caddy serves `https://localhost:18443` with its local certificate authority, and storage is Silo instead of R2 (`docker-compose.prod-local.yml`).
```powershell
scripts/prod-local.ps1 up      # build from this checkout and start; waits until everything is healthy
scripts/prod-local.ps1 test    # Playwright: HTTPS and headers, plain and encrypted bundles through Caddy, the admin port, access codes, /sample
scripts/prod-local.ps1 down -Volumes
```

## Running on Cloudflare R2

The API works with any S3-compatible storage. The conformance suite (`StorageConformanceTests`) runs everything the API and the browser do with storage against Silo, and against R2 when a test bucket is configured (below). R2 needs these settings, all made in Cloudflare's dashboard:

1. **Bucket:** create it with a **jurisdiction** (e.g. *European Union*) if the data must stay in one region. The jurisdiction can't be changed later, and it gives the bucket its own address: `https://<account-id>.eu.r2.cloudflarestorage.com`.
2. **CORS policy** (bucket → Settings). Browsers upload and download directly, and must be able to read each part's `ETag`:
   ```json
   [
     {
       "AllowedOrigins": ["https://fileholder.app"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["content-type", "range", "if-range"],
       "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Content-Disposition"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
3. **Lifecycle rule** (bucket → Settings → Object lifecycle rules), the storage safety net: delete objects after the days below, and **abort incomplete multipart uploads after 2 days**. The API can't set it there (step 4), but it logs the exact values at startup, and the `storage_lifecycle` health check shows them.

   | `UploadLimits__MaxExpiryHours` | Delete objects after |
   | :--- | :--- |
   | 24 | 4 days |
   | 72 | 6 days |
   | 168 (default) | 10 days |

   R2 applies rules in the background, so deletion can lag by up to about a day; the purge stays the main mechanism.
4. **API token:** *Object Read & Write*, limited to this bucket. It can't change the bucket's settings, so a leaked key can't make the bucket public or reconfigure it (the conformance suite checks that too). That's also why the rule and CORS are set by hand.
5. **Settings:**
   ```yaml
   services:
     api:
       environment:
         Storage__ServiceUrl: "https://<account-id>.eu.r2.cloudflarestorage.com"
         Storage__PublicBaseUrl: "https://<account-id>.eu.r2.cloudflarestorage.com"
         Storage__BucketName: "<bucket>"
         Storage__AccessKey: "<token's Access Key ID>"        # from .env, never committed
         Storage__SecretKey: "<token's Secret Access Key>"    # from .env, never committed
         Storage__LifecycleRule: "External"
     ui:
       environment:
         STORAGE_PUBLIC_URL: "https://<account-id>.eu.r2.cloudflarestorage.com"   # the page's CSP allows only this
   ```
   Presigned URLs use R2's own address: custom domains don't support them.

**Checking a bucket:** put a test bucket's details in `%USERPROFILE%\.fileholder\r2-test.env` (outside the repository) and run the conformance suite. Without the file, only Silo is checked.
```
R2_ACCOUNT_ID=<account id>
R2_ACCESS_KEY_ID=<Access Key ID>
R2_SECRET_ACCESS_KEY=<Secret Access Key>
R2_BUCKET=<test bucket>
R2_JURISDICTION=eu
```
```powershell
dotnet test tests/FileHolder.Tests.Integration --filter "FullyQualifiedName~StorageConformance"
```

**Checking the production bucket** before launch: set the same `R2_*` values as environment variables (they take precedence over the file), with `R2_BROWSER_ORIGIN=https://fileholder.app`, so the CORS check uses the site's own origin instead of `http://localhost:3000`. The suite writes a few test objects and deletes them again.

## Maintenance Modes
Uploads can be paused, or the whole site closed, within seconds and without a restart: for abuse, a full bucket, or maintenance.

| Mode | New uploads | Uploads already started | Bundle pages | New downloads | Downloads already started |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Normal` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `UploadsPaused` | ❌ | ✅ (multipart steps and confirm) | ✅ | ✅ | ✅ |
| `ReadOnly` | ❌ | ❌ | ✅ (and unlocking) | ❌ | ✅ (an open download session) |
| `Closed` | ❌ | ❌ | ❌ | ❌ | ❌ |

* **The purge runs in every mode,** so pausing never delays a deletion. Aborting a multipart upload is also always allowed: it only frees storage.
* **Refused requests** get `503` with `Retry-After` (until the mode's `until`, else 5 minutes), the owner's message as the problem's `detail`, and the mode as its `mode` field.
* **`GET /api/v1/status`** → `{ "mode": "UploadsPaused", "message": "…", "until": "…" }`, for the UI. Never cached.
* **What visitors see:** the UI asks for the status when the page loads (and again after a failed upload, in case uploads were paused meanwhile).
  * `UploadsPaused` and `ReadOnly`: a banner on every page with the owner's message (or a default one) and *"Expected back …"* while `until` is ahead. The upload form stays visible, but its button reads *Uploads are paused* and can't be pressed.
  * `Closed`: one page, *"FileHolder is closed for now"*, instead of every page.
  * If the status can't be read, the UI behaves as in `Normal`: the API refuses whatever the mode doesn't allow anyway.
* **Switching it:** `scripts/admin.ps1` calls the admin endpoints on port 9465 with `ADMIN_TOKEN` from `.env`:
  ```powershell
  scripts/admin.ps1 status
  scripts/admin.ps1 mode UploadsPaused -Reason "abuse reports" -Message "Uploads are paused for a few hours." -Until "2026-10-27T14:00Z"
  scripts/admin.ps1 mode Normal -Reason "all clear"
  ```
  * `-Reason` is required and only goes into the log; `-Message` and `-Until` are shown to visitors. `until` is informational: nothing switches back by itself.
  * The admin port is bound to the host's loopback and never proxied. On a server, run the script there or through an SSH tunnel (`ssh -L 9465:localhost:9465 …`).
  * Without the token, or on any other port, `/admin/…` answers `404`; with a wrong token, `401`.
* **Where it's kept:** each change is a row in `ServiceModeChanges` (mode, message, until, reason, who, when); the latest row is the current mode. Each API instance re-reads it at most every 5 seconds. Every change is logged as a warning, a pause still on after a restart is logged at startup, and the mode is the metric `fileholder_service_mode{mode}` (1 for the current one).

## Takedown
For abuse reports (`abuse@fileholder.app`) and legal requests, a bundle can be removed at once:
```powershell
scripts/admin.ps1 takedown "https://fileholder.app/f/Ab3dE6gH#k=..." -Reason "phishing, reported to abuse@ on 2026-10-27"
scripts/admin.ps1 takedowns   # the latest takedowns
```
* **What happens:**
  1. The bundle is closed and the takedown is recorded, together. From here on, its link answers `410` *"This bundle was removed by FileHolder."* (title `Link Removed`, field `removed: true`), and its download sessions stop working, so downloads in progress are cut off.
  2. Its files are deleted from storage straight away, with no grace period, so presigned URLs already handed out (valid 5 minutes) find nothing.
  3. The bundle is reduced to a tombstone like a purged one. The removed mark stays, so the link keeps saying it was removed until the tombstone goes, 7 days later.
* **A bundle confirmed less than about an hour ago** still has the uploaded originals of its small files in storage. Confirm serves copies and leaves the originals to the purge, about an hour after the upload, because deleting them earlier would let the uploader put an untracked object there through their still-valid upload URL. Nothing can download an original: no download link is ever issued for it.
* **If storage fails** to delete a file, the bundle is still closed, and the purge retries on its next run (within 30 minutes) without waiting for its grace period or for open download sessions. The script says so.
* **The script sends only the share token,** never the `#k=` key of an encrypted bundle's link. A link or a bare token both work.
* **The record** (`Takedowns`: share token, reason, who, when, file count, total size, encrypted or not) is kept after the tombstone is deleted, so a later question about the link can be answered. It holds no title, file names or keys. Taking down the same link again changes nothing and shows the first record.
* **What the recipient sees:** *"This bundle was removed by FileHolder"*, with a short note to be careful with anything else the sender sent, instead of the usual "no longer available" page.
* **Reports come in by email:** the footer's *Report abuse* link, and *Report it* under every bundle, open an email to `abuse@fileholder.app` (`VITE_ABUSE_EMAIL`). The bundle's report names its link **without the `#k=` key**, so the key never reaches the inbox; the share token is all a takedown needs.
* **Answers:** `404` for an unknown token; `409` when the bundle already expired and its files are gone. Encrypted bundles can be taken down like any other: the server can't see inside them, but it can delete them.

## Access Codes
A public demo can give anonymous uploads limits too small to be worth abusing, and unlock the full ones with a code (#169):
- **Without a code:** `UploadLimits__WithoutCodeMaxBundleSizeBytes` and `UploadLimits__WithoutCodeMaxExpiryHours` (production: 10 MB, 1 hour). Setting both turns codes on; unset (the default), every upload gets the full limits and codes aren't used.
- **With a valid code:** `UploadLimits__MaxBundleSizeBytes` and `UploadLimits__MaxExpiryHours` (production: 250 MB, 24 hours). The global quota still caps everything.
- **Managing them** on the admin port ([Maintenance Modes](#maintenance-modes)):
  ```powershell
  scripts/admin.ps1 code-create a03                # valid 30 days; prints the code and the personal link
  scripts/admin.ps1 code-create a04 -ExpiresInDays 60   # or -NoExpiry
  scripts/admin.ps1 codes                          # status, bundles, bytes, first and last use
  scripts/admin.ps1 code-extend a03 -Days 30       # valid for another 30 days from now (or -NoExpiry)
  scripts/admin.ps1 code-revoke a03
  ```
  **Use neutral labels** (`a01`, `a02`, …) and keep which company each is outside FileHolder: otherwise the list is a list of the companies you applied to, on the server and in its backups.
- **A code** is the label and 12 random characters, `a03-7F3K-9Q2M-X8PD` (Crockford's base32, about 10¹⁸ possibilities). It's shown once; only its SHA-256 is stored. Case, spaces, and O/I/L for 0/1/1 don't matter when it's typed.
- **Presign** takes the code as `accessCode`. With a valid one the full limits apply; with an unknown, expired or revoked one, presign refuses with the same message for all three. Without one the smaller limits apply, and the refusal says an access code allows more. The longest expiry is fixed at presign, since confirm sends the expiry again. `POST /api/v1/files/access-codes/check` tells the UI a code's limits before uploading; `GET /api/v1/files/limits` gives the limits without a code, with `accessCodesEnabled` and `longestExpiryHours` (the longest any bundle can live, which the privacy page states).
- **In the browser:** the personal link (`/?code=…`) applies the code and removes it from the address bar; the code is kept in `sessionStorage` for that tab only. The form shows the code's limits once the server confirms it, and says plainly when a code is unknown or expired (it then uploads with the smaller limits, never sending a bad code). Above the form, *Have an access code?* opens a field to type one.
- **Counted, not linked:** each code counts its bundles, bytes, and first and last use, but no bundle records its code. Wrong codes are rate-limited per client (with presign) and counted in `fileholder_access_code_rejections_total`. There's no global limit, which would let anyone lock real codes out on purpose; with 60 random bits, guessing is hopeless anyway.

## Sample Bundle
`/sample` opens a ready-made encrypted bundle anyone can try without uploading anything or having a code: the README and the landing page can link it. Every bundle deletes itself, the sample included, so a small service keeps one alive (#82):
- **The keeper** (`sample` in `docker-compose.prod.yml`, `src/features/sample/keeper/`) uploads a one-page PDF it writes itself (naming the site and the day) and `src/fileholder-ui/sample-content/photo.jpg`, encrypted with the browser's own upload code running under Node, so the sample is made exactly as a visitor's bundle would be. Each sample lives 24 hours with 100 downloads; the keeper checks every hour and makes a new one after 12 hours (so whoever opened the old one can finish), or as soon as it's gone, expired, or down to 20 downloads (`SAMPLE_*` settings in `main.ts`).
- **The pointer:** it writes the current link to a volume nginx serves at `/sample-bundle/current.json`, which `/sample` reads and forwards to; it only forwards to a share link on the site itself. The pointer is replaced only once the new sample is uploaded.
- **It uploads with an ordinary access code**, so the server has no special case and no bundle that never expires; `scripts/admin.ps1 codes` shows how many samples it has made. Without `SAMPLE_ACCESS_CODE`, it idles and `/sample` says there's no sample.
- **The one key the server knows:** the pointer holds the sample's link, key included. The sample is public by design, so nothing is exposed; every other encrypted bundle's key still never reaches the server.
- **Setting it up**, once after the first deploy:
  ```powershell
  scripts/admin.ps1 code-create s01 -NoExpiry      # prints the code
  # add SAMPLE_ACCESS_CODE=<code> to the server's .env, then on the server:
  docker compose -f docker-compose.prod.yml up -d sample
  ```
  `scripts/prod-local.ps1 up` makes its own code.

## Tracing
One request, or one purge run, can be followed step by step: where the time went and in what order.
* **Where:** Grafana ([http://localhost:3001](http://localhost:3001)) → **Explore** → **Tempo**. Search for service `fileholder-api` and a span name such as `POST /api/v1/files/confirm` or `purge.run`, or paste a trace id from a log line (`… trace=<id> span=<id>`).
* **What a trace holds:**
  * the request, with its PostgreSQL queries and storage calls (`HEAD`, `PUT` …, from the AWS SDK's HttpClient);
  * the API's own steps: `confirm.claim` → `confirm.check_sizes` → `confirm.hash_password` → `confirm.copy_single_part_files` → `confirm.persist` → `confirm.cache_write`, `presign`, `password.check` (with its lockout decision), `download_session.open`, `bundle_zip.entry` per file, and `storage.*` around every storage call;
  * the purge worker's runs, each a trace of its own (`purge.run` and its steps, with counts).
* **What it never holds:** share tokens, presigned-URL signatures, passwords, `kAuth`, keys, titles or file names, and client addresses unless switched on (see [Security](security.md), *Traces*).
* **Kept 48 hours** (`docker/tempo/tempo.yaml`), on the `tempo_data` volume. A bundle lasts at most 7 days, and a trace still shows that a bundle was uploaded and downloaded, and when.
* **Ports:** the API sends traces to `tempo:4317` over the compose network only. Tempo's query port is on loopback (`127.0.0.1:3200`) for tooling.
* **Check it works:** with the stack up, run `scripts/check-traces.sh` (Git Bash). It sends one request under its own trace id and checks that Tempo has it, without the share token. CI runs it after the browser tests.
* **Turn it off:** remove `OTEL_EXPORTER_OTLP_ENDPOINT` from the `api` service. Nothing is sent then, and log lines inside a request still carry their trace id.

## Versions and Releases
* **The version** is `<Version>` in `Directory.Build.props` (API) and `version` in `src/fileholder-ui/package.json` (UI). Releases bump both together. It stays below 1.0 until the first deployment, which is `1.0.0`.
* **The commit** is added at build time. Local builds take it from git. Docker builds have no `.git`, so pass `GIT_SHA` (compose reads it from the environment), otherwise the commit shows as `unknown`:
  ```powershell
  $env:GIT_SHA = git rev-parse --short HEAD; docker compose up -d --build
  ```
* **Where it shows:**
  * the UI footer (`v0.9.0 · abc1234`);
  * `/healthz`, `/healthz/live`, `/healthz/ready` and `GET /api/v1/status` (`version`, `commit`);
  * the `?diagnostics` report on a download page, as *UI build* and *API build*. A mismatch means a tab from before a deploy;
  * the API's startup log line, and the trace service version (`0.9.0+<commit>`);
  * the metric `fileholder_build_info{version,commit} 1`, for marking deploys in Grafana;
  * the image labels `org.opencontainers.image.version` (from `VERSION`, `dev` unless a release or deploy build sets it) and `org.opencontainers.image.revision`.
* **Releases** come from [release-please](https://github.com/googleapis/release-please), configured in `release-please-config.json` (the current version is in `.release-please-manifest.json` and `version.txt`). It reads the conventional commit messages since the last release. Below 1.0, `feat:` and `fix:` bump the patch (0.9.1, 0.9.2, …) and a breaking change the minor; from 1.0 on, `feat:` bumps the minor and `fix:` the patch. It then writes `CHANGELOG.md` (features, fixes, performance, reverts and docs; build, CI, test, refactor and chore commits are left out) and bumps `version.txt`, `Directory.Build.props` and the UI's `package.json` and `package-lock.json` together.
  * **While GitHub Actions are off**, cut a release from your machine with your `gh` login:
    ```powershell
    scripts/release.ps1 pr -DryRun   # what the next release would be
    scripts/release.ps1 pr           # open or update the release PR ("chore: release 0.9.1")
    # review and merge it, then:
    scripts/release.ps1 release      # tag v0.9.1 and create the GitHub release
    ```
  * **Once Actions are back**, set the repository variable `RELEASE_PLEASE_ENABLED` to `true`. `.github/workflows/release.yml` then does the same on every push to `main`, and the script is no longer needed.
  * **1.0.0, at the first deployment:** add `"release-as": "1.0.0"` to the package in `release-please-config.json`, cut that release, then remove it again.
  * **0.9.0** is the first release, made by hand: everything before it is summed up in `CHANGELOG.md`, rather than release-please listing about 150 earlier PRs.

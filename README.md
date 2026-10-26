# 📁 FileHolder: Self-Destructing File Sharing

> Share files as bundles that delete themselves after a set time or number of downloads, with optional **end-to-end encryption in the browser**. Built with **.NET 10**, **PostgreSQL 17**, S3-compatible object storage (**Silo**, a MinIO fork) and **React 19**.
> Files travel **directly between the browser and storage** through presigned URLs, so file contents never pass through the API.

> **Status:** FileHolder runs locally with Docker Compose and in CI only; it isn't deployed anywhere yet. A deployment is planned. What still blocks it is tracked in [#82](https://github.com/Hiczownik/FileHolder/issues/82).

---

## 🚀 How It Works

```
                 /api/v1/files/...
  Browser ───────────────────────▶ nginx (ui) ───▶ API (.NET 10) ───▶ PostgreSQL
     │                                              │
     │  presigned PUT / GET (file contents)          │ presign, size checks, copies, purge
     └──────────────────────────▶ Storage (Silo) ◀──┘
```

* **Uploading:** the browser asks the API to **presign** the bundle, uploads each file **straight to storage**, then **confirms**:
  * Files up to 50 MB go in a single `PUT`. Larger files go as a multipart upload in parts of at least 16 MiB, 4 at a time, retried with backoff.
  * On confirm, the API checks every stored file's size against what it approved. It serves single-file uploads from a copy, so the original upload link can't overwrite them.
  * The sender gets a share link (`/f/<token>`, plus `#k=<key>` for encrypted bundles) and a QR code for it.
* **Photo metadata (on by default):** before presign, the browser removes what photos record about where, when and with what they were taken. It happens in the browser because the files go straight to storage (and encrypted ones are encrypted first), so the server never could.
  * **Removed** from JPEG, PNG and WebP: EXIF (GPS location, camera make, model and serial numbers, date and time, the embedded thumbnail), XMP, IPTC, comments and text chunks. An Android Motion Photo's short video is removed too, leaving a still photo.
  * **Kept:** the image data, byte for byte (nothing is re-encoded), colour profiles, animation, HDR gain maps, and the orientation, so rotated photos still show the right way up.
  * **Not cleaned**, and labelled as such in the file list: HEIC/HEIF, AVIF, TIFF/RAW and videos, and photos too damaged to read. These upload as they are.
  * The file list marks photos that contain a location with 📍, even with the option off. The option can be turned off on the upload form, for photographers who want to keep their EXIF.
* **Downloading:** the recipient opens the link, unlocks it with the password if there is one, and starts a **download session**:
  * The session counts as one download and lasts up to 6 hours, never past the bundle's expiry. Within it, the recipient can fetch the files (or retry) without using up another download.
  * Each file link is valid for 5 minutes and points straight at storage.
  * *Download All* gives a ZIP: built by the server for normal bundles, and in the browser for encrypted ones.
* **Self-destruction:**
  * A bundle closes when it expires (1–168 hours, or less with `UploadLimits__MaxExpiryHours`) or when its downloads are used up.
  * A background worker runs every 30 minutes. It deletes a closed bundle's files from storage once no download session is still running (plus a 10-minute grace for links already handed out).
  * **Storage safety net:** in case that worker is stuck, crashes or has a bug, storage itself deletes **any object older than 10 days**, and **multipart uploads left incomplete for 48 hours**. No legitimate file gets that old: at most about 8 days (24 h to confirm an upload, 7 days of bundle life, then the grace and the worker's next run).
    * The API sets the 10-day bucket lifecycle rule at startup, calculated from its own timings and the longest a bundle may live (`StorageSafetyNet`; 4 days when bundles live at most 24 hours), and refuses to start if `Storage__LifecycleExpiryDays` is set lower. The `fileholder_storage_lifecycle_days` metric shows the rule's days once storage has confirmed it (0 until then).
    * Silo ignores the abort-incomplete-uploads part of lifecycle rules, so abandoned uploads are removed by its own stale-upload clean-up instead: `MINIO_API_STALE_UPLOADS_EXPIRY=48h` in `docker-compose.yml` (Silo's default, 24 h, could cut off a slow upload before it is confirmed).
  * **The bundle's details go with its files:** in the same step, the worker deletes the file names, sizes and types, and clears the title, password hash and an encrypted bundle's key material and manifest. What's left is an anonymous tombstone (the share token, the dates, and whether it was encrypted), so the link says "expired" rather than "not found". **Tombstones are deleted after 7 days**, and finished multipart-upload records 1 day after they finish.
    * This is deleted *from the database*, not wiped from the disk: Postgres keeps old row versions until it reuses the space, and its write-ahead log for a while. **Database backups keep whatever they copied**, so keep them for 7 days or less.
* **End-to-end encryption (optional):**
  * **The key is in the link:** the browser creates a random 256-bit *link key* and puts it in the share link's fragment (`/f/<token>#k=<key>`). Browsers never send the fragment to a server, not even in the `Referer` header, so the API and nginx never see it.
  * **Two modes**, chosen on the upload form:

    | Mode | What the recipient needs | Who can read the files |
    | :--- | :--- | :--- |
    | Link only (**default**) | the link (or its QR code) | **anyone who has the link**: chat history, synced browser history, extensions, a photo of the QR code |
    | *Also require a passkey* | the link **and** a passkey, sent separately | only someone with both. A leaked link alone is useless, and so is a leaked passkey alone |

    Use the passkey for sensitive files. A typed passkey needs at least 10 characters; *Generate* makes one of 14. A bundle's mode can't be changed after upload.
  * **Keys:** the browser creates a random master key and locks it with a key derived from the link key, plus the passkey when there is one. The passkey is stretched with Argon2id (64 MiB of memory, 3 passes, in a background worker), because it's what someone holding the link would have to guess; its settings are stored with the bundle, and both server and browser refuse settings outside fixed limits. `/diagnostics/argon2` times the settings on a device. The random link key isn't stretched. Both then go through HKDF, salted per bundle. Each file gets its own key derived from the master key.
  * **File contents:** encrypted with AES-256-GCM in 4 MiB chunks. Each chunk's position and a last-chunk flag are authenticated, so chunks can't be reordered, dropped or added.
  * **File names and types:** live only in an encrypted manifest. Storage holds `<id>.enc` files.
  * **Title:** encrypted with the master key like the manifest, and only returned once the bundle is unlocked. Until then, the page shows "Encrypted bundle".
  * **What the server receives:** never the link key or the passkey. It only gets a separate value derived from them, which it checks on unlock like a password, with the same lockout after repeated failures. That value is 32 random bytes, so the server stores its SHA-256 rather than a slow bcrypt hash.
  * **What it can still see:** the number of files, each file's encrypted size (the real size to within 16 bytes per 4 MiB), the expiry, the download limit, how many downloads were used, and whether the bundle needs a passkey. Anyone with the link without its key (or without the passkey) sees the same.
  * **Older encrypted bundles**, which had only a passkey and no key in the link, can no longer be opened. The page says so.

---

## 🔒 Security Measures

* **Private storage:** the bucket allows no anonymous access, and every upload and download uses a short-lived presigned URL. CI checks that anonymous requests are refused.
* **File names:** paths are stripped and unsafe characters replaced. Blocked extensions (`.exe`, `.bat`, `.sh`, `.cmd`, `.dll`, `.ps1`, `.js`, `.msi`, `.jar`, `.lnk`, `.iso` and more) are refused by the server. For encrypted bundles, the recipient's browser checks the decrypted names.
* **Headers:** content types must match a strict media-type pattern, and download `Content-Disposition` headers are always plain ASCII.
* **Passwords:** until the password is given, a bundle shows only its file count, expiry and downloads left: not its title, file names or sizes. Stored as bcrypt hashes. 5 wrong passwords are free (typos happen); each further one locks the bundle for 1, 2, 4, … minutes, up to 1 hour.
* **Rate limits per client address** (fixed one-minute windows; a `429` carries `Retry-After`):

  | Endpoint | Limit | Setting |
  | :--- | :--- | :--- |
  | `presign` | 10 / min | `RateLimits__UploadInitiatePermitLimit` |
  | Multipart steps (`multipart/presign-batch`, `complete`, `abort`) | 300 / min | `RateLimits__MultipartPipelinePermitLimit` |
  | `confirm` | 10 / min | `RateLimits__ConfirmPermitLimit` |
  | Unlock, download sessions, file links, *Download All* | 30 / min | `RateLimits__DownloadPermitLimit` |
  | Bundle info (`GET /{token}`) | 60 / min | `RateLimits__MetadataPermitLimit` |

  These are the defaults; each can be set (1–100,000) with the setting next to it. Only raise them for a test stack where every request comes from one address, as CI's end-to-end tests do (`docker-compose.ci.yml`).
* **Download counting** is a single conditional database update, so a bundle limited to N downloads can never be downloaded more than N times, however many recipients try at once.
* **API responses** carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` and a Content-Security-Policy.
  * **The UI pages, served by nginx, don't send these headers yet.** Tracked in [#130](https://github.com/Hiczownik/FileHolder/issues/130), a deployment blocker ([#82](https://github.com/Hiczownik/FileHolder/issues/82)).
* **Error responses** use RFC 7807 `ProblemDetails`. Internal error messages are only shown in Development.
* **Logs** name the route (`/api/v1/files/{shareToken}`), never the request path, since a share token opens a bundle without a password. File names and titles stay out of them too: a rejected request's message, which can name a file, is only logged at `Debug`. nginx's access log shows `[token]` in place of the token and leaves out query strings; its error log, whose format can't be changed, still shows the full request when it can't reach the API.
* **Traces** (sent only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set) keep out what logs keep out, and more (`TraceRedactionProcessor`):
  * request paths become their route (`/api/v1/files/{shareToken}/unlock`), and query strings are dropped, so share tokens, presigned-URL signatures and download-session ids never appear;
  * storage keys keep their GUID and lose the file name (`uploads/{guid}_[name]`);
  * request and response bodies (passwords, `kAuth`, keys, manifests) are never recorded, and neither are database parameter values;
  * the API's own spans (confirm steps, storage calls, password checks, download sessions, ZIP entries, purge runs) carry counts, outcomes and GUIDs only: a ZIP entry is its index, and a password check is its decision (`free_attempt_used`, `lockout_applied`…), never the attempt;
  * client addresses are left out unless `Tracing__RecordClientAddress=true`: with them, a trace would say which address unlocked and downloaded which bundle.
  * A test runs a whole upload and download through an in-memory exporter and checks that none of these reach it.
* **Dependencies** are pinned and checked:
  * **Pinning:**
    * Every container image is pinned to a version and digest. A test fails on any that isn't.
    * Every GitHub Action is pinned to a commit.
    * Every NuGet version is exact, in `Directory.Packages.props`.
    * npm installs from `package-lock.json`.
  * **Dependabot** proposes updates weekly (`.github/dependabot.yml`).
  * **CI fails** on a high or critical vulnerability with a fix available:
    * in NuGet packages, transitive ones included (restore);
    * in npm packages that ship in the app (`npm audit`);
    * in the API, UI and storage images (Trivy). Accepted exceptions are in `.trivyignore`, each with a reason and an expiry date.
  * **`security.yml`** runs Semgrep on the C# and TypeScript code, and gitleaks on every commit for committed secrets. These are free tools, since GitHub's own code scanning needs a paid add-on on a private repository.

**[Threat model](docs/threat-model.md):** what each party can see and do, the protections with their code, the known gaps and the accepted risks.

**Found a vulnerability?** Please don't open a public issue; see [`SECURITY.md`](SECURITY.md).

---

## 📏 Limits

| What | Limit | Setting |
| :--- | :--- | :--- |
| Files per bundle | 1–50 | |
| Bundle size | 5 GB in total (encrypted bundles: measured before encryption) | `UploadLimits:MaxBundleSizeBytes` |
| Expiry | 1–168 hours (required) | `UploadLimits:MaxExpiryHours` (can only be lowered) |
| Storage in use, all bundles together | No limit | `UploadLimits:GlobalQuotaBytes`. While full, presign answers `503` with `Retry-After`; uploads already started still finish |
| Downloads | 1–1000 | |
| Password / passkey | 4–100 characters, not only spaces | |
| Unconfirmed uploads | Expire after 24 hours | |
| Download session | Up to 6 hours, never past the bundle's expiry | |
| File download link | 5 minutes | |
| Single upload | Up to 50 MB; larger files use multipart (parts ≥ 16 MiB) | |
| In-memory saving (browsers without streaming saves) | 1 GB | see *Encrypted Downloads* |

The UI reads the upload limits from `GET /api/v1/files/limits` when the page loads, so its size check, expiry choices and texts follow the server's configuration. If that request fails, it uses the defaults above, and the server still enforces its own limits.

---

## 🛠️ Technology Stack

| Tier | Technology | Notes |
| :--- | :--- | :--- |
| **Backend API** | **.NET 10**, ASP.NET Core Minimal APIs | Route groups, typed results, FluentValidation, RFC 7807 `ProblemDetails` |
| **API docs** | Native OpenAPI + **Scalar UI** | Development only |
| **Database** | **PostgreSQL 17**, **EF Core 10** (Npgsql) | Migrations applied at startup, filtered indexes |
| **Object storage** | **Silo** (`pgsty/silo`) | A community-maintained fork of the MinIO server (MinIO wound down its community edition). Private bucket, accessed with the AWS SDK for .NET. The compose service is still called `minio`. Pinned to one release by tag and digest, like every image here; one vendor maintains it on a best-effort basis, so read its release notes before updating |
| **Caching** | .NET `HybridCache` | In-memory only (no shared L2 cache), with stampede protection |
| **Background work** | `BackgroundService` | Storage purge every 30 minutes |
| **Frontend** | **React 19**, Vite 8, TypeScript 6, Tailwind CSS 4 | axios, react-hook-form, client-zip (ZIPs in the browser), qrcode.react |
| **Observability** | OpenTelemetry metrics → Prometheus → Grafana; OpenTelemetry traces → Grafana Tempo → Grafana; Serilog console logs with trace ids | |
| **Tests** | xUnit, FluentAssertions, NSubstitute, FsCheck, Testcontainers (PostgreSQL); Vitest + Testing Library, fast-check; Playwright (Chromium, Firefox, WebKit) | |
| **Containers** | Docker Compose, multi-stage builds | |

---

## ⚡ Quick Start

Make sure [Docker Desktop](https://www.docker.com/products/docker-desktop/) is running. Then create a `.env` file next to `docker-compose.yml` with the stack's passwords, and start it. Compose refuses to start while any password is missing, and git ignores the file. `.env.example` lists what goes in it.

PowerShell:
```powershell
function New-Secret { $b = New-Object byte[] 16; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join '' }
@(
  "GRAFANA_ADMIN_PASSWORD=$(New-Secret)"
  "POSTGRES_PASSWORD=$(New-Secret)"
  "STORAGE_ROOT_USER=fileholder-admin"
  "STORAGE_ROOT_PASSWORD=$(New-Secret)"
  "STORAGE_API_SECRET_KEY=$(New-Secret)"
  "ADMIN_TOKEN=$(New-Secret)$(New-Secret)"
) | Set-Content -Encoding ascii .env
docker compose up --build
```

Bash:
```bash
cat > .env <<EOF
GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 16)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
STORAGE_ROOT_USER=fileholder-admin
STORAGE_ROOT_PASSWORD=$(openssl rand -hex 16)
STORAGE_API_SECRET_KEY=$(openssl rand -hex 16)
ADMIN_TOKEN=$(openssl rand -hex 32)
EOF
docker compose up --build
```

### Application Endpoints
* **Web app**: [http://localhost:3000](http://localhost:3000). This port is published on **all network interfaces**, so other devices on your network can reach it too.
* **API health check**: [http://localhost:8080/healthz/ready](http://localhost:8080/healthz/ready).
  * **Statuses:**
    * *Unhealthy* (503): the database or storage can't be reached.
    * *Degraded* (still 200): the purge is lagging, or storage is filling up. The storage lifecycle rule isn't confirmed, the purge worker hasn't completed a run for an hour, bundles have waited over 2 hours to be deleted, or 80% of the storage quota is in use.
  * **Who waits on it:** compose (before starting the UI) and CI.
  * **Liveness:** [`/healthz/live`](http://localhost:8080/healthz/live) only shows the process is up. `/healthz` is the same as `/healthz/ready`.
  * **Metrics:** each check's status is also on the metrics port as `fileholder_health_status`, with `fileholder_purge_overdue_groups`, `fileholder_purge_last_success_age_seconds`, `fileholder_storage_used_bytes` and, with a quota set, `fileholder_storage_quota_bytes`. The maintenance mode is `fileholder_service_mode{mode}` (see *Maintenance Modes*).
* **Grafana**: [http://localhost:3001](http://localhost:3001) *(login: `admin` / your `GRAFANA_ADMIN_PASSWORD`)*. Prometheus metrics, and Tempo traces (see *Tracing*).
* **Storage console (Silo)**: [http://localhost:9001](http://localhost:9001) *(login: your `STORAGE_ROOT_USER` / `STORAGE_ROOT_PASSWORD`)*
* **Scalar API docs**: only when the API runs in Development (see *Development*). The compose stack runs the API in Production.

### Passwords and Storage Users
* **No password is committed.** `docker-compose.yml` reads them all from `.env`, and `appsettings.json` has none.
* **The API has its own storage user,** `fileholder-api`, which `minio-init` creates on every start. `docker/silo/api-policy.json` limits it to the one bucket: its objects, multipart uploads, and the safety net's lifecycle rule. It can't change the bucket's access policy or touch other buckets. The storage admin (`STORAGE_ROOT_*`) is only used by `minio-init` and the storage console.
* **Changing a password:**
  * `GRAFANA_ADMIN_PASSWORD`, `STORAGE_ROOT_*`, `STORAGE_API_SECRET_KEY` and `ADMIN_TOKEN`: edit `.env` and run `docker compose up -d`. Storage keeps its data under new admin credentials, and `minio-init` updates the API user's secret.
  * `POSTGRES_PASSWORD` only takes effect when the `postgres_data` volume is first created. To change it on an existing volume, change it in the database first, then in `.env`, then run `docker compose up -d`:
    ```powershell
    docker compose exec postgres psql -U fileholder_user -d fileholder_db -c "ALTER USER fileholder_user PASSWORD 'the-new-password'"
    ```
* **Upgrading a stack from before `ADMIN_TOKEN` existed:** add `ADMIN_TOKEN=<64 random hex characters>` to `.env` (PowerShell: `"ADMIN_TOKEN=$(New-Secret)$(New-Secret)" | Add-Content -Encoding ascii .env`, with `New-Secret` from *Quick Start*).
* **Upgrading a stack from before these passwords existed:** its Postgres volume still has the old password, `fileholder_password`. Either put `POSTGRES_PASSWORD=fileholder_password` in `.env` and change it as above, or start from empty volumes with `docker compose down -v` (deletes the local database and stored files).

### Networking & Rate Limits
* **The browser talks to the API through the UI's nginx** (`http://localhost:3000/api/...`).
  * nginx sets `X-Forwarded-For`, and the API trusts it only from the UI container's fixed address (`172.30.250.10`, `ForwardedHeaders__KnownProxies__0`), so rate limits apply per client.
  * Port 8080 is bound to loopback, for local tooling only.
* **The compose network is pinned to `172.30.250.0/24`.** If that clashes with a network on your machine, change the subnet, the UI's `ipv4_address` and `ForwardedHeaders__KnownProxies__0` together.
* **A reverse proxy in front of the UI container** (Caddy in production): list its address in the UI container's `TRUSTED_PROXIES`. nginx then replaces the connection's address with the client's from that proxy's `X-Forwarded-For` and passes it on, so the access log, the rate limits and the password lockout see real clients. The API keeps trusting only nginx. Other clients' forwarded headers are ignored.
* **Deploys don't cut downloads off:** on a stop, the API lets running requests (bundle ZIPs) finish for up to 90 s, then stays up 5 s more so the last buffered bytes leave before Docker removes the container's network. Compose gives it 100 s (`stop_grace_period`), and Postgres 30 s for a clean shutdown.
* **Behind your own reverse proxy or load balancer**, list its address under `ForwardedHeaders:KnownProxies`, or its range under `ForwardedHeaders:KnownNetworks` (CIDR, e.g. `10.0.1.0/24`). Otherwise every client shares the proxy's rate limit. Make sure the proxy overwrites `X-Forwarded-For` rather than appending to a client-supplied one.
* **Docker Desktop (Windows/macOS) hides client addresses:** its port forwarding makes every connection appear to come from one gateway address, so locally all clients still share one rate-limit partition. Linux hosts and real proxies don't have this problem.
* **Metrics** are served only on port 9464 (`Metrics:Port`), which compose never publishes. Prometheus scrapes `api:9464` over the internal network.
* **Storage addresses** (`Storage:ServiceUrl` for the API, `Storage:PublicBaseUrl` for browsers) may each be `http://` or `https://`. Upload and download links follow `PublicBaseUrl`'s scheme, so when the app is served over HTTPS, storage must be too, or browsers block the links as mixed content.
* **Security headers on the UI pages** (`nginx.conf.template`): a Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: no-referrer`. API responses get theirs from the API (`SecurityHeadersMiddleware`).
  * The policy lets the page run only its own scripts and connect only to itself and to storage. The UI container's `STORAGE_PUBLIC_URL` must therefore match the API's `Storage__PublicBaseUrl`, or every upload and download is blocked. The container won't start without a valid one.
  * Check for violations in the browser console (*Refused to …* / *Content-Security-Policy*). `e2e/securityHeaders.spec.ts` fails on any.

### Versions and Releases
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

### Maintenance Modes
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

### Takedown
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

### Tracing
One request, or one purge run, can be followed step by step: where the time went and in what order.
* **Where:** Grafana ([http://localhost:3001](http://localhost:3001)) → **Explore** → **Tempo**. Search for service `fileholder-api` and a span name such as `POST /api/v1/files/confirm` or `purge.run`, or paste a trace id from a log line (`… trace=<id> span=<id>`).
* **What a trace holds:**
  * the request, with its PostgreSQL queries and storage calls (`HEAD`, `PUT` …, from the AWS SDK's HttpClient);
  * the API's own steps: `confirm.claim` → `confirm.check_sizes` → `confirm.hash_password` → `confirm.copy_single_part_files` → `confirm.persist` → `confirm.cache_write`, `presign`, `password.check` (with its lockout decision), `download_session.open`, `bundle_zip.entry` per file, and `storage.*` around every storage call;
  * the purge worker's runs, each a trace of its own (`purge.run` and its steps, with counts).
* **What it never holds:** share tokens, presigned-URL signatures, passwords, `kAuth`, keys, titles or file names, and client addresses unless switched on (see *Security Measures*, *Traces*).
* **Kept 48 hours** (`docker/tempo/tempo.yaml`), on the `tempo_data` volume. A bundle lasts at most 7 days, and a trace still shows that a bundle was uploaded and downloaded, and when.
* **Ports:** the API sends traces to `tempo:4317` over the compose network only. Tempo's query port is on loopback (`127.0.0.1:3200`) for tooling.
* **Check it works:** with the stack up, run `scripts/check-traces.sh` (Git Bash). It sends one request under its own trace id and checks that Tempo has it, without the share token. CI runs it after the browser tests.
* **Turn it off:** remove `OTEL_EXPORTER_OTLP_ENDPOINT` from the `api` service. Nothing is sent then, and log lines inside a request still carry their trace id.

### Encrypted Downloads
* **Opening the link:**
  * The page reads the key from the address and then removes it, so it doesn't stay on screen or in screenshots. Anything else in the address, such as `?diagnostics`, stays.
  * The key is kept for that browser tab (`sessionStorage`), so a reload still works. It's forgotten once the bundle has expired or been deleted.
  * The passkey is never stored, so after a reload a bundle with a passkey asks for it again. The link key is still remembered, so only the passkey is needed.
  * Link-only bundles open without a prompt. Bundles with a passkey ask for the passkey only.
* **Incomplete or damaged links:**
  * A link whose key is missing or cut short says *"This link is incomplete"*. The server isn't asked to unlock, so none of the bundle's unlock attempts are used up.
  * A key the server refuses says the link is damaged (or, with a passkey, that the passkey or the link is wrong).
* **Size limits:** encrypted files are encrypted and decrypted in the browser in 4 MiB chunks, so their size doesn't depend on the browser's memory.
* **How they're saved:** written to disk as they decrypt. Through a service worker (Chrome, Edge, Firefox); otherwise a "Save as" dialog; otherwise the site's private storage (OPFS, which Safari has).
* **Browsers with none of those** save in memory, capped at 1 GB. They're told before the download starts (so no download is used up) to open the link in Chrome, Edge or Firefox for anything larger.
* **Checked on a real iPhone** (iOS 18.7, Safari 26.6.1): a 1.5 GB encrypted file, a multi-file ZIP and a tampered file (refused) all behaved correctly, saving through OPFS.

---

## ⚙️ Configuration

The API reads standard .NET configuration: `appsettings.json`, then environment variables, where `:` becomes `__` (e.g. `Storage__PublicBaseUrl`). The compose file sets these for the containers.

| Setting | Compose value | Meaning |
| :--- | :--- | :--- |
| `ConnectionStrings__PostgresConnection` | `Host=postgres;…;Password=<POSTGRES_PASSWORD>;Maximum Pool Size=50` | PostgreSQL connection string. Required: the API refuses to start without one. Keep each API instance's pool size well under Postgres' `max_connections` (100), so other instances and tools can still connect |
| `Storage__ServiceUrl` | `http://minio:9000` | Storage address the **API** uses |
| `Storage__PublicBaseUrl` | `http://localhost:9000` | Storage address in upload and download links, so it must be reachable from **browsers** |
| `Storage__AccessKey`, `Storage__SecretKey` | `fileholder-api`, `STORAGE_API_SECRET_KEY` from `.env` | The API's own storage user (see *Passwords and Storage Users*). Required: the API refuses to start without them |
| `Storage__BucketName` | `fileholder-bucket` | Bucket for all files |
| `UploadLimits__MaxBundleSizeBytes` | 5 GB (default) | Largest bundle. The UI reads it from the API |
| `UploadLimits__MaxExpiryHours` | 168 (default) | Longest a bundle may live, 1–168. Lowering it also shortens the storage lifecycle rule |
| `UploadLimits__GlobalQuotaBytes` | unset (no quota) | Most storage all bundles and pending uploads may take up together, counted from their declared sizes. A cap on what's accepted, not an exact meter: confirm's copies of single-part files and two presigns at once can go a little past it |
| `RateLimits__*PermitLimit` | see *Rate limits* (defaults) | Requests per client address per minute, per endpoint group. Raise only for single-address test stacks |
| `Storage__LifecycleExpiryDays` | unset (10, calculated) | Days after which storage deletes any object. Only for a longer safety net; lower than the calculated value refuses to start |
| `Storage__LifecycleRule` | `Apply` (default) | `Apply`: the API puts the lifecycle rule on the bucket at startup and confirms it. `External`: it's set outside the app (R2's dashboard, see *Running on Cloudflare R2*); the API makes no lifecycle call and logs the values the rule should have |
| `ForwardedHeaders__KnownProxies__<n>` / `ForwardedHeaders__KnownNetworks__<n>` | `172.30.250.10` | Proxies whose `X-Forwarded-For` is trusted |
| `Cors__AllowedOrigins__<n>` | `http://localhost:3000` | Origins whose pages may call the API cross-origin, e.g. `https://fileholder.app`. None by default: through nginx the browser calls the API same-origin, which needs no CORS. Scheme, host and port only, with no trailing slash, or the API refuses to start |
| `Metrics__Port` | 9464 (default) | Internal Prometheus metrics port |
| `Hosting__ShutdownTimeoutSeconds` | 90 (default) | On a stop (a deploy), how long requests already running may finish. Bundle ZIPs stream through the API, so a longer one is cut off after this. Compose's `stop_grace_period` (100 s) must be longer than this plus the linger |
| `Hosting__LingerSeconds` | 5 (default) | How long the API stays up after its last response, so the end of a ZIP still in the network buffers reaches nginx before Docker removes the container's network |
| `Admin__Token` | `ADMIN_TOKEN` from `.env` | Bearer token for the admin endpoints (see *Maintenance Modes*). At least 32 characters, or the API refuses to start; empty turns the admin endpoints off |
| `Admin__Port` | 9465 (default) | The only port the admin endpoints answer on. Compose binds it to the host's loopback |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://tempo:4317` | Where traces go over OTLP. Unset (the default outside compose), nothing is sent; log lines inside a trace still end with `trace=… span=…` |
| `Tracing__SampleRatio` | 1 (default) | Share of requests traced, 0–1. Lower it (e.g. 0.1) on a deployment that sends traces |
| `Tracing__RecordClientAddress` | false (default) | Keep the caller's address on request spans, for debugging rate limits or the lockout on a real host |
| `ASPNETCORE_ENVIRONMENT` | `Production` | `Development` enables Scalar and detailed errors |
| `.env`: `GRAFANA_ADMIN_PASSWORD`, `POSTGRES_PASSWORD`, `STORAGE_ROOT_USER`, `STORAGE_ROOT_PASSWORD`, `STORAGE_API_SECRET_KEY`, `ADMIN_TOKEN` | (yours) | The stack's passwords (see *Quick Start* and `.env.example`) |
| UI: `TRUSTED_PROXIES` | empty | Addresses or CIDR ranges of a reverse proxy in front of the UI container (Caddy in production). nginx then takes the client's address and scheme from that proxy's `X-Forwarded-For` and `X-Forwarded-Proto`. Empty: clients connect directly and those headers are ignored. A malformed value stops the container |
| UI: `STORAGE_PUBLIC_URL` | `http://localhost:9000` | The same address as `Storage__PublicBaseUrl`, without a path. The UI's Content-Security-Policy allows connections to it; without a valid one the container doesn't start |
| Build: `GIT_SHA`, `VERSION` (build args; compose reads them from the environment) | unset | The commit and image version label (see *Versions and Releases*). Unset, the commit shows as `unknown` and the label as `dev` |
| UI: `VITE_ABUSE_EMAIL` (build time) | `abuse@fileholder.app` (`.env.production`, Dockerfile) | Where the *Report abuse* links send email. Empty hides them |
| UI: `VITE_API_BASE_URL` (build time) | `/api/v1/files` (`.env.production`) | API address the UI calls; `.env.development` uses `http://localhost:8080/api/v1/files` |

`docker-compose.override.example.yml` shows how to override settings locally (used for phone testing below).

**A public demo** runs with much smaller upload limits than the defaults, so it isn't attractive as free file hosting and its storage bill stays predictable (#148). For example, 250 MB bundles that live at most a day, and 10 GB of storage in all:

```yaml
services:
  api:
    environment:
      UploadLimits__MaxBundleSizeBytes: "262144000"   # 250 MB
      UploadLimits__MaxExpiryHours: "24"
      UploadLimits__GlobalQuotaBytes: "10737418240"   # 10 GB
```

### Production
One server runs the whole app with `docker-compose.prod.yml`; files live in Cloudflare R2 (*Running on Cloudflare R2*).

```
 Internet ──443/80──▶ Caddy ──▶ nginx (ui) ──/api/──▶ API ──▶ PostgreSQL
                      HTTPS,     UI, CSP,              │  ╲
                      HSTS       redacted log          │   ╲──▶ Tempo (traces)
                                                       ▼
 Browser ──presigned URLs──────────────────────▶ Cloudflare R2        Prometheus ◀── /metrics
```

* **Only Caddy is published**, on 80 and 443. Docker's published ports get around a host firewall such as `ufw`, so nothing else is: the admin port (9465), Prometheus (9090) and Tempo (3200) are bound to the server's loopback, and Postgres, nginx and the API aren't published at all.
* **Caddy** (`docker/caddy/Caddyfile`) gets and renews the certificate for `SITE_ADDRESS` (Let's Encrypt, ZeroSSL as the fallback), redirects HTTP to HTTPS, adds `Strict-Transport-Security`, drops the `Server` header, and streams everything to nginx. It keeps no access log (paths hold share tokens); nginx logs them redacted. Its certificates are on the `caddy_data` volume: keep it, or every restart asks for new ones and soon hits Let's Encrypt's rate limits.
* **Client addresses** pass along a fixed chain: Caddy sets `X-Forwarded-For`, nginx trusts it only from Caddy's address (`TRUSTED_PROXIES`), the API only from nginx's (`KnownProxies`).
* **Hardening, on every container:** `no-new-privileges`, all Linux capabilities dropped except the few each needs (Caddy: binding 80/443; nginx and Postgres: switching to their own users), a read-only filesystem with tmpfs where they write, a memory limit (about 290 MB in use for the whole app, against limits of 2 GB), and logs rotated at 3 × 10 MB per container.
* **Deploys** let running ZIP downloads finish (*Networking & Rate Limits*); `restart: unless-stopped` brings everything back after a reboot.
* **Monitoring** stays private: Prometheus keeps 7 days and Tempo 48 hours, and Grafana runs on your own computer, reaching them through an SSH tunnel (`ssh -L 9090:localhost:9090 -L 3200:localhost:3200 <server>`) or Tailscale.
* **Settings:** the server's `.env`, listed in `.env.prod.example`: the site address, the R2 bucket and token, the Postgres password, the admin token and the image version; the demo's upload limits are the defaults.
* **Images** are built on a development machine and copied to the server (`scripts/deploy.ps1`, below), so `docker-compose.prod.yml` refers to them as `fileholder-api:<version>` and `fileholder-ui:<version>`.

#### Deploying
```powershell
scripts/deploy.ps1 -Server fileholder            # build this checkout, copy it over, switch, check
scripts/deploy.ps1 -Server fileholder -Rollback  # back to the version before
```
`-Server` is an SSH destination, best a `Host` in `~/.ssh/config` (or set `FILEHOLDER_SERVER`). The script:
1. refuses uncommitted changes (`-AllowDirty` overrides), and checks the server has Docker Compose and its `.env`;
2. builds both images here, tagged `<version>-<commit>` (e.g. `0.9.0-4ba83f2`);
3. copies them over SSH (`docker save`, `scp -C`, `docker load`; about 150 MB), with `docker-compose.prod.yml` and the Caddy, Prometheus and Tempo configs. There's no registry; once the repository is public, images can move to GHCR;
4. sets `FILEHOLDER_VERSION` in the server's `.env`, remembers the previous version, and runs `docker compose up --wait`. **If anything doesn't come up healthy, it switches back to the previous version by itself** and fails;
5. checks the API on the server, and `https://fileholder.app/api/v1/status` (`-SiteUrl`; empty skips it), report the new commit;
6. keeps the new and the previous images, removes older ones, and logs each deploy, failure and rollback in `deploy.log` on the server.

Only the API and UI containers are recreated; Caddy, Postgres, Prometheus and Tempo keep running. A deploy interrupted halfway (Ctrl+C, a dropped connection) can leave a container stopped: run it again, or `docker compose -f docker-compose.prod.yml up -d` on the server.

**First time on a new server** (a fresh Debian or Ubuntu):
1. An SSH key on your computer (`ssh-keygen -t ed25519`), installed on the server, and a `Host fileholder` entry in `~/.ssh/config` with its address, user and key. Turn off password logins.
2. Docker Engine with the Compose plugin ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/)). If you deploy as a user other than root, add it to the `docker` group, which is root-equivalent on the server.
3. A firewall allowing only SSH, 80 and 443 (`ufw allow OpenSSH; ufw allow 80; ufw allow 443; ufw enable`). Docker's published ports get around it, so `docker-compose.prod.yml` publishes nothing else.
4. `/opt/fileholder`, owned by the deploying user, with a `.env` made from `.env.prod.example`.
5. DNS: `A`/`AAAA` for the site address pointing at the server, **DNS only** (not proxied by Cloudflare), so Caddy gets its certificate and sees real client addresses.
6. `scripts/deploy.ps1 -Server fileholder`. Caddy asks for the certificate on its first start, so DNS must already point at the server.

**Trying it locally first:** `scripts/prod-local.ps1` runs the same setup next to the dev stack, as its own compose project with its own volumes, ports and random secrets (`.env.prod-local`). Caddy serves `https://localhost:18443` with its local certificate authority, and storage is Silo instead of R2 (`docker-compose.prod-local.yml`).
```powershell
scripts/prod-local.ps1 up      # build from this checkout and start; waits until everything is healthy
scripts/prod-local.ps1 test    # Playwright: HTTPS and headers, plain and encrypted bundles through Caddy, the admin port
scripts/prod-local.ps1 down -Volumes
```

### Running on Cloudflare R2

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

---

## 🗂️ Project Structure

| Path | Contents |
| :--- | :--- |
| `src/FileHolder.Api` | Endpoints, validation, rate limiting, middleware, startup |
| `src/FileHolder.Core` | Entities, request/response types, timing and format constants, file-name and crypto helpers |
| `src/FileHolder.Infrastructure` | EF Core context and migrations, storage access, services, the purge worker |
| `src/fileholder-ui` | React app (`src/features/upload`, `src/features/download`, `src/shared`), nginx config, the download service worker (`public/download-sw.js`), Playwright tests (`e2e/`) |
| `tests/FileHolder.Tests.Unit` | Unit and property tests for `FileHolder.Core` (and the API's bundle rules) |
| `tests/vectors` | Examples both test suites check, so the server's and browser's file-name rules agree |
| `tests/FileHolder.Tests.Integration` | API and service tests (Testcontainers PostgreSQL) |
| `tests/load` | k6 load tests, their runner (`run.ps1`) and database checks |
| `docker/` | Prometheus, Tempo and Grafana configuration |
| `scripts/tamper-stored-file.sh` | Flips a byte in a stored file, for testing tamper detection |
| `scripts/release.ps1` | Cuts a release with release-please while GitHub Actions are off (*Versions and Releases*) |
| `docker-compose.prod.yml`, `docker/caddy/Caddyfile` | The production setup behind Caddy (*Production*); `docker-compose.prod-local.yml` and `scripts/prod-local.ps1` run it locally |
| `scripts/deploy.ps1` | Deploys this checkout to the production server over SSH, or rolls it back (*Production*) |
| `scripts/admin.ps1` | The owner's controls: the maintenance mode and takedowns (*Maintenance Modes*, *Takedown*) |

---

## 💻 Development

* **API in Development** (Scalar docs, detailed errors): run the `http` launch profile from Rider, or `dotnet run --project src/FileHolder.Api`.
  * It listens on [http://localhost:5273](http://localhost:5273). The docs are at [http://localhost:5273/scalar/v1](http://localhost:5273/scalar/v1).
  * It uses `appsettings.json`, which expects Postgres on `localhost:5432` and storage on `localhost:9000`. The compose stack publishes both on loopback.
  * **It needs the passwords,** which aren't in `appsettings.json`. Store them once as user secrets (kept in your user profile, outside the repository), with the values from your `.env`:
    ```powershell
    dotnet user-secrets --project src/FileHolder.Api set "ConnectionStrings:PostgresConnection" "Host=localhost;Port=5432;Database=fileholder_db;Username=fileholder_user;Password=<POSTGRES_PASSWORD>"
    dotnet user-secrets --project src/FileHolder.Api set "Storage:AccessKey" "fileholder-api"
    dotnet user-secrets --project src/FileHolder.Api set "Storage:SecretKey" "<STORAGE_API_SECRET_KEY>"
    ```
  * **It applies migrations at startup** to whatever database it connects to.
* **UI dev server:** `cd src/fileholder-ui && npm install && npm run dev`.
  * It wants port 3000, which the compose `ui` container already uses, so run `docker compose stop ui` first. Otherwise Vite picks another port, and the compose API only allows `http://localhost:3000` cross-origin (`Cors__AllowedOrigins__0`).
  * It calls the API at `http://localhost:8080` (the compose API).
* **Checks before a PR:** `npm run lint` and `npm run build` in `src/fileholder-ui`, plus the tests below.

---

## 🧪 Running the Tests

### 1. Backend tests (.NET xUnit)
```bash
dotnet test FileHolder.sln
```
This runs both the unit tests (`tests/FileHolder.Tests.Unit`) and the integration tests (`tests/FileHolder.Tests.Integration`). The integration tests start PostgreSQL with Testcontainers, so **Docker must be running**. CI runs both.

### 2. Frontend unit tests (Vitest)
```bash
cd src/fileholder-ui
npm test            # once
npm run test:watch  # re-run on changes
```

### 3. Property tests (FsCheck and fast-check)
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

### 4. End-to-end browser tests (Playwright)
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

**Network-fault tests:** `e2e/faults` breaks the network on purpose: failed parts, a dropped connection, a download cut off half way. Each test then checks that nothing is left behind or counted twice. They run with the others; to run only them, start the stack with `docker-compose.ci.yml` as well, which raises the rate limits, and use `npx playwright test --project="faults*"`. See [`e2e/faults/README.md`](src/fileholder-ui/e2e/faults/README.md).

### 5. Load tests (k6)
k6 scenarios in `tests/load` send many requests at once. Some check the rules that only matter under concurrency: exactly `MaxDownloads` sessions however many clients race, password lockout against parallel guesses, unknown tokens never cached, and 429s with a correct `Retry-After`. Others measure capacity: many small files, 2 GiB multipart uploads, mixed traffic, 20 server ZIPs at once, and a 2-hour soak. Run them on demand, in PowerShell:
```powershell
./tests/load/run.ps1 4,5,6,9   # correctness, about 6 minutes
./tests/load/run.ps1 1,2,3,7   # capacity, about 30 minutes
```
The script starts the stack with the load-test compose files, runs k6 in a container, checks the database, Postgres connections and API and nginx logs afterwards, purges everything the run made and checks storage is left clean, and then starts the stack with its usual configuration again. Grafana's **FileHolder load tests** dashboard shows each run. See [`tests/load/README.md`](tests/load/README.md).

### 6. Testing from a Phone (e.g. Safari on iPhone)
Encrypted downloads are saved differently per browser (see *Encrypted Downloads*), and CI can't run real Safari. To check a phone by hand, it has to reach your local stack **over HTTPS**: Safari only enables service workers and its private file storage (OPFS) on HTTPS, so a plain `http://<your-PC-IP>:3000` test would silently fall back to saving in memory and prove nothing.

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

---

## 📄 Licence

FileHolder is released under the [MIT License](LICENSE). The libraries it uses keep their own licences (mostly MIT, Apache-2.0 and BSD). Storage runs Silo, licensed under AGPL-3.0, as a separate, unmodified service, so its licence doesn't extend to FileHolder's code.

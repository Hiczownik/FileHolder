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
  * A bundle closes when it expires (1–168 hours) or when its downloads are used up.
  * A background worker runs every 30 minutes. It deletes a closed bundle's files from storage once no download session is still running (plus a 10-minute grace for links already handed out).
  * **Storage safety net:** in case that worker is stuck, crashes or has a bug, storage itself deletes **any object older than 10 days**, and **multipart uploads left incomplete for 48 hours**. No legitimate file gets that old: at most about 8 days (24 h to confirm an upload, 7 days of bundle life, then the grace and the worker's next run).
    * The API sets the 10-day bucket lifecycle rule at startup, calculated from its own timings (`StorageSafetyNet`), and refuses to start if `Storage__LifecycleExpiryDays` is set lower. The `fileholder_storage_lifecycle_days` metric shows the rule's days once storage has confirmed it (0 until then).
    * Silo ignores the abort-incomplete-uploads part of lifecycle rules, so abandoned uploads are removed by its own stale-upload clean-up instead: `MINIO_API_STALE_UPLOADS_EXPIRY=48h` in `docker-compose.yml` (Silo's default, 24 h, could cut off a slow upload before it is confirmed).
  * **The bundle's database rows are currently kept after that** (file names, title, key material). Fixing this is tracked in [#77](https://github.com/Hiczownik/FileHolder/issues/77).
* **End-to-end encryption (optional):**
  * **The key is in the link:** the browser creates a random 256-bit *link key* and puts it in the share link's fragment (`/f/<token>#k=<key>`). Browsers never send the fragment to a server, not even in the `Referer` header, so the API and nginx never see it.
  * **Two modes**, chosen on the upload form:

    | Mode | What the recipient needs | Who can read the files |
    | :--- | :--- | :--- |
    | Link only (**default**) | the link (or its QR code) | **anyone who has the link**: chat history, synced browser history, extensions, a photo of the QR code |
    | *Also require a passkey* | the link **and** a passkey, sent separately | only someone with both. A leaked link alone is useless, and so is a leaked passkey alone |

    Use the passkey for sensitive files. A bundle's mode can't be changed after upload.
  * **Keys:** the browser creates a random master key and locks it with a key derived from the link key, plus the passkey when there is one. The passkey is stretched with PBKDF2-SHA-256 (300,000 rounds), because it's what someone holding the link would have to guess. The random link key isn't stretched. Both then go through HKDF, salted per bundle. Each file gets its own key derived from the master key.
  * **File contents:** encrypted with AES-256-GCM in 4 MiB chunks. Each chunk's position and a last-chunk flag are authenticated, so chunks can't be reordered, dropped or added.
  * **File names and types:** live only in an encrypted manifest. Storage holds `<id>.enc` files.
  * **Title:** encrypted with the master key like the manifest, and only returned once the bundle is unlocked. Until then, the page shows "Encrypted bundle".
  * **What the server receives:** never the link key or the passkey. It only gets a separate value derived from them, which it checks on unlock like a password (bcrypt, lockout after repeated failures).
  * **What it can still see:** the number of files, each file's encrypted size (the real size to within 16 bytes per 4 MiB), the expiry, the download limit, how many downloads were used, and whether the bundle needs a passkey. Anyone with the link without its key (or without the passkey) sees the same.
  * **Older encrypted bundles**, which had only a passkey and no key in the link, can no longer be opened. The page says so.

---

## 🔒 Security Measures

* **Private storage:** the bucket allows no anonymous access, and every upload and download uses a short-lived presigned URL. CI checks that anonymous requests are refused.
* **File names:** paths are stripped and unsafe characters replaced. Blocked extensions (`.exe`, `.bat`, `.sh`, `.cmd`, `.dll`, `.ps1`, `.js`, `.msi`, `.jar`, `.lnk`, `.iso` and more) are refused by the server. For encrypted bundles, the recipient's browser checks the decrypted names.
* **Headers:** content types must match a strict media-type pattern, and download `Content-Disposition` headers are always plain ASCII.
* **Passwords:** stored as bcrypt hashes. 5 wrong passwords are free (typos happen); each further one locks the bundle for 1, 2, 4, … minutes, up to 1 hour.
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
  * **The UI pages, served by nginx, don't send these headers yet.** Tracked in [#81](https://github.com/Hiczownik/FileHolder/issues/81) and [#82](https://github.com/Hiczownik/FileHolder/issues/82).
* **Error responses** use RFC 7807 `ProblemDetails`. Internal error messages are only shown in Development.

A written threat model (what each party can see and do, and the known gaps) is planned in [#81](https://github.com/Hiczownik/FileHolder/issues/81). **Please don't report vulnerabilities in public issues;** contact the maintainer privately (a `SECURITY.md` with the process is part of #81).

---

## 📏 Limits

| What | Limit | Setting |
| :--- | :--- | :--- |
| Files per bundle | 1–50 | |
| Bundle size | 5 GB in total (encrypted bundles: measured before encryption) | `UploadLimits:MaxBundleSizeBytes`. Keep in sync with `STANDARD_MAX_TOTAL_BYTES` in the UI |
| Expiry | 1–168 hours (required) | |
| Downloads | 1–1000 | |
| Password / passkey | 4–100 characters, not only spaces | |
| Unconfirmed uploads | Expire after 24 hours | |
| Download session | Up to 6 hours, never past the bundle's expiry | |
| File download link | 5 minutes | |
| Single upload | Up to 50 MB; larger files use multipart (parts ≥ 16 MiB) | |
| In-memory saving (browsers without streaming saves) | 1 GB | see *Encrypted Downloads* |

---

## 🛠️ Technology Stack

| Tier | Technology | Notes |
| :--- | :--- | :--- |
| **Backend API** | **.NET 10**, ASP.NET Core Minimal APIs | Route groups, typed results, FluentValidation, RFC 7807 `ProblemDetails` |
| **API docs** | Native OpenAPI + **Scalar UI** | Development only |
| **Database** | **PostgreSQL 17**, **EF Core 10** (Npgsql) | Migrations applied at startup, filtered indexes |
| **Object storage** | **Silo** (`pgsty/silo`) | A community-maintained fork of the MinIO server (MinIO wound down its community edition). Private bucket, accessed with the AWS SDK for .NET. The compose service is still called `minio` |
| **Caching** | .NET `HybridCache` | In-memory only (no shared L2 cache), with stampede protection |
| **Background work** | `BackgroundService` | Storage purge every 30 minutes |
| **Frontend** | **React 19**, Vite 8, TypeScript 6, Tailwind CSS 4 | axios, react-hook-form, client-zip (ZIPs in the browser), qrcode.react |
| **Observability** | OpenTelemetry metrics → Prometheus → Grafana; Serilog console logs | |
| **Tests** | xUnit, FluentAssertions, NSubstitute, Testcontainers (PostgreSQL); Vitest + Testing Library; Playwright (Chromium, Firefox, WebKit) | |
| **Containers** | Docker Compose, multi-stage builds | |

---

## ⚡ Quick Start

Make sure [Docker Desktop](https://www.docker.com/products/docker-desktop/) is running. Then set a Grafana admin password in a `.env` file next to `docker-compose.yml` (compose refuses to start without one; git ignores the file), and start the stack:

```bash
echo "GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 16)" > .env
docker compose up --build
```

### Application Endpoints
* **Web app**: [http://localhost:3000](http://localhost:3000). This port is published on **all network interfaces**, so other devices on your network can reach it too.
* **API health check**: [http://localhost:8080/healthz](http://localhost:8080/healthz). Today it only shows the API is up; it doesn't check the database or storage yet ([#80](https://github.com/Hiczownik/FileHolder/issues/80)).
* **Grafana**: [http://localhost:3001](http://localhost:3001) *(login: `admin` / your `GRAFANA_ADMIN_PASSWORD`)*
* **Storage console (Silo)**: [http://localhost:9001](http://localhost:9001) *(login: `minioadmin` / `minioadmin`)*
* **Scalar API docs**: only when the API runs in Development (see *Development*). The compose stack runs the API in Production.

The default credentials (`minioadmin`, the Postgres password in `appsettings.json` and `docker-compose.yml`) are for local use only. Replacing them is part of [#82](https://github.com/Hiczownik/FileHolder/issues/82).

### Networking & Rate Limits
* **The browser talks to the API through the UI's nginx** (`http://localhost:3000/api/...`).
  * nginx sets `X-Forwarded-For`, and the API trusts it only from the UI container's fixed address (`172.30.250.10`, `ForwardedHeaders__KnownProxies__0`), so rate limits apply per client.
  * Port 8080 is bound to loopback, for local tooling only.
* **The compose network is pinned to `172.30.250.0/24`.** If that clashes with a network on your machine, change the subnet, the UI's `ipv4_address` and `ForwardedHeaders__KnownProxies__0` together.
* **Behind your own reverse proxy or load balancer**, list its address under `ForwardedHeaders:KnownProxies`, or its range under `ForwardedHeaders:KnownNetworks` (CIDR, e.g. `10.0.1.0/24`). Otherwise every client shares the proxy's rate limit. Make sure the proxy overwrites `X-Forwarded-For` rather than appending to a client-supplied one.
* **Docker Desktop (Windows/macOS) hides client addresses:** its port forwarding makes every connection appear to come from one gateway address, so locally all clients still share one rate-limit partition. Linux hosts and real proxies don't have this problem.
* **Metrics** are served only on port 9464 (`Metrics:Port`), which compose never publishes. Prometheus scrapes `api:9464` over the internal network.
* **Storage addresses** (`Storage:ServiceUrl` for the API, `Storage:PublicBaseUrl` for browsers) may each be `http://` or `https://`. Upload and download links follow `PublicBaseUrl`'s scheme, so when the app is served over HTTPS, storage must be too, or browsers block the links as mixed content.

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
| `ConnectionStrings__PostgresConnection` | `Host=postgres;…` | PostgreSQL connection string |
| `Storage__ServiceUrl` | `http://minio:9000` | Storage address the **API** uses |
| `Storage__PublicBaseUrl` | `http://localhost:9000` | Storage address in upload and download links, so it must be reachable from **browsers** |
| `Storage__AccessKey`, `Storage__SecretKey` | `minioadmin` | Storage credentials (local defaults) |
| `Storage__BucketName` | `fileholder-bucket` | Bucket for all files |
| `UploadLimits__MaxBundleSizeBytes` | 5 GB (default) | Largest bundle. Keep in sync with the UI |
| `RateLimits__*PermitLimit` | see *Rate limits* (defaults) | Requests per client address per minute, per endpoint group. Raise only for single-address test stacks |
| `Storage__LifecycleExpiryDays` | unset (10, calculated) | Days after which storage deletes any object. Only for a longer safety net; lower than the calculated value refuses to start |
| `ForwardedHeaders__KnownProxies__<n>` / `ForwardedHeaders__KnownNetworks__<n>` | `172.30.250.10` | Proxies whose `X-Forwarded-For` is trusted |
| `Metrics__Port` | 9464 (default) | Internal Prometheus metrics port |
| `ASPNETCORE_ENVIRONMENT` | `Production` | `Development` enables Scalar and detailed errors |
| `GRAFANA_ADMIN_PASSWORD` (`.env`) | (yours) | Grafana admin password |
| UI: `VITE_API_BASE_URL` (build time) | `/api/v1/files` (`.env.production`) | API address the UI calls; `.env.development` uses `http://localhost:8080/api/v1/files` |

`docker-compose.override.example.yml` shows how to override settings locally (used for phone testing below).

---

## 🗂️ Project Structure

| Path | Contents |
| :--- | :--- |
| `src/FileHolder.Api` | Endpoints, validation, rate limiting, middleware, startup |
| `src/FileHolder.Core` | Entities, request/response types, timing and format constants, file-name and crypto helpers |
| `src/FileHolder.Infrastructure` | EF Core context and migrations, storage access, services, the purge worker |
| `src/fileholder-ui` | React app (`src/features/upload`, `src/features/download`, `src/shared`), nginx config, the download service worker (`public/download-sw.js`), Playwright tests (`e2e/`) |
| `tests/FileHolder.Tests.Unit` | Unit tests for `FileHolder.Core` |
| `tests/FileHolder.Tests.Integration` | API and service tests (Testcontainers PostgreSQL) |
| `docker/` | Prometheus and Grafana provisioning |
| `scripts/tamper-stored-file.sh` | Flips a byte in a stored file, for testing tamper detection |

---

## 💻 Development

* **API in Development** (Scalar docs, detailed errors): run the `http` launch profile from Rider, or `dotnet run --project src/FileHolder.Api`.
  * It listens on [http://localhost:5273](http://localhost:5273). The docs are at [http://localhost:5273/scalar/v1](http://localhost:5273/scalar/v1).
  * It uses `appsettings.json`, which expects Postgres on `localhost:5432` and storage on `localhost:9000`. The compose stack publishes both on loopback.
  * **It applies migrations at startup** to whatever database it connects to.
* **UI dev server:** `cd src/fileholder-ui && npm install && npm run dev`.
  * It wants port 3000, which the compose `ui` container already uses, so run `docker compose stop ui` first. Otherwise Vite picks another port, and the API's CORS policy only allows `http://localhost:3000` and `http://localhost:5173`.
  * It calls the API at `http://localhost:8080` (the compose API).
* **Checks before a PR:** `npm run lint` and `npm run build` in `src/fileholder-ui`, plus the tests below.

---

## 🧪 Running the Tests

### 1. Backend tests (.NET xUnit)
```bash
dotnet test FileHolder.sln
```
This runs both the unit tests (`tests/FileHolder.Tests.Unit`) and the integration tests (`tests/FileHolder.Tests.Integration`). The integration tests start PostgreSQL with Testcontainers, so **Docker must be running**. *(CI currently runs only the integration tests; adding the unit tests is part of [#70](https://github.com/Hiczownik/FileHolder/issues/70).)*

### 2. Frontend unit tests (Vitest)
```bash
cd src/fileholder-ui
npm test            # once
npm run test:watch  # re-run on changes
```

### 3. End-to-end browser tests (Playwright)
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

### 4. Testing from a Phone (e.g. Safari on iPhone)
Encrypted downloads are saved differently per browser (see *Encrypted Downloads*), and CI can't run real Safari. To check a phone by hand, it has to reach your local stack **over HTTPS**: Safari only enables service workers and its private file storage (OPFS) on HTTPS, so a plain `http://<your-PC-IP>:3000` test would silently fall back to saving in memory and prove nothing.

1. **Run the current stack.** Older builds don't route the API through the UI: `docker compose up -d --build --force-recreate`. `--force-recreate` matters when upgrading a stack created before the compose network was pinned: otherwise compose recreates the network but only restarts the old containers on it, without their service names (`minio`, `postgres`), and `minio-init` fails with `lookup minio … no such host`. Data is kept in Docker volumes.
2. **Open two HTTPS tunnels** with [Cloudflare quick tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (free, no account; on Windows `winget install --id Cloudflare.cloudflared`), each in its own terminal. Each prints a temporary `https://….trycloudflare.com` address:
   ```bash
   cloudflared tunnel --url http://localhost:3000   # the app
   cloudflared tunnel --url http://localhost:9000   # storage: upload and download links point straight at it
   ```
3. **Point upload and download links at the storage tunnel:** copy `docker-compose.override.example.yml` to `docker-compose.override.yml` (git-ignored), put the storage tunnel's address in it, then `docker compose up -d api`.
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
6. **Close the tunnels** (Ctrl+C) when done: while open, anyone with an address can reach the app. Use throwaway files, and don't tunnel the storage console (port 9001). Then delete `docker-compose.override.yml` and run `docker compose up -d api`.

**If `cloudflared` reports it can't reach port 7844** (some networks block it), use [Tailscale](https://tailscale.com) instead. It only needs normal HTTPS, and the addresses are reachable by your own devices only:
1. Install it on the PC and the phone with the same account.
2. Turn on *MagicDNS* and *HTTPS Certificates* in the admin console.
3. Run `tailscale serve --bg --https=443 http://127.0.0.1:3000` and `tailscale serve --bg --https=8443 http://127.0.0.1:9000`.
4. Set `Storage__PublicBaseUrl` to `https://<your-pc>.<tailnet>.ts.net:8443` (`tailscale serve status` shows the address).
5. Stop serving afterwards with `tailscale serve reset`.

If uploads fail with `403 SignatureDoesNotMatch`, the storage tunnel isn't passing the original host name on to storage (upload links are signed for it). A named Cloudflare tunnel has a fixed host name that can be set with `--http-host-header`. Upload parts are 16 MiB and single uploads at most 50 MB, well under Cloudflare's per-request size limit.

---

## 📄 Licence

The repository has no licence file yet, so all rights are reserved by default. Choosing a licence is part of [#82](https://github.com/Hiczownik/FileHolder/issues/82). Storage runs Silo, which is licensed under AGPL-3.0 as a separate service.

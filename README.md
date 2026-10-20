# 📁 FileHolder — Cloud-Native Self-Destructing File Sharing Platform

> An enterprise-grade, high-performance file-sharing platform engineered with **.NET 10**, **MinIO**, **PostgreSQL 17**, and **React 19**. 
> Utilizes **Direct-to-Storage Presigned Upload URLs** to offload transfer bandwidth, eliminating backend server CPU/memory bottlenecks.

---

## 🚀 Key Architectural Highlights

* **Zero Server Memory Overhead**: Files stream directly from the client browser to MinIO via presigned PUT URLs, bypassing backend memory allocations.
* **.NET 10 Native Standards**: Built with Minimal APIs (`MapGroup`), Native OpenAPI 3.1, `Scalar` UI documentation, `HybridCache` (L1/L2 stampede protection), and RFC 7807 `ProblemDetails` error handling.
* **Security First**: Automatic sanitization against Path Traversal, FluentValidation extension blacklisting (`.exe`, `.sh`, `.dll`), BCrypt password hashing, and Security Headers (`nosniff`, CSP, DENY).
* **Automated Storage Purge Worker**: Custom `.NET BackgroundService` worker periodically purges expired objects from storage and database records in atomic batches.
* **Automated End-to-End Testing**: Fully automated E2E browser testing suite powered by **Microsoft Playwright** and **xUnit Integration Tests**.

---

## 🛠️ Technology Stack Matrix

| Tier | Technology | Justification |
| :--- | :--- | :--- |
| **Backend API** | **.NET 10 (C# 13)** | Native Minimal APIs, high throughput, Native AOT ready |
| **API Docs** | **Scalar UI** | Modern, interactive alternative to Swashbuckle |
| **Database** | **PostgreSQL 17** | Relational metadata storage hostable on free cloud tiers |
| **ORM** | **EF Core 10** | Strong typing, compiled queries, filtered indexes |
| **Object Storage**| **MinIO** | S3-compatible storage run locally in Docker Compose (private bucket, presigned-URL access only) |
| **Caching** | **.NET 10 `HybridCache`** | L1 memory caching with built-in cache stampede locking |
| **Frontend** | **React 19 + Vite 6 + Tailwind v4** | Decoupled SPA communicating via REST and Axios direct S3 PUT |
| **E2E Testing** | **Microsoft Playwright** | Real browser automation (upload -> download -> self-destruct) |
| **Backend Testing**| **xUnit + WebApplicationFactory** | In-memory integration testing pipeline |
| **Containers** | **Docker Compose** | Single-command multi-stage container orchestration |

---

## ⚡ Quick Start (Single-Command Docker Launch)

Ensure [Docker Desktop](https://www.docker.com/products/docker-desktop/) is running, then set a Grafana admin password
(compose refuses to start without one) in a `.env` file next to `docker-compose.yml`, which git ignores:

```bash
echo "GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 16)" > .env
docker compose up --build
```

### Application Endpoints:
* **React Web App**: [http://localhost:3000](http://localhost:3000)
* **Scalar API Docs**: only when the API runs in Development (e.g. from Rider / `dotnet run`), at [http://localhost:8080/scalar/v1](http://localhost:8080/scalar/v1). The compose stack runs the API in Production.
* **Grafana**: [http://localhost:3001](http://localhost:3001) *(Login: `admin` / your `GRAFANA_ADMIN_PASSWORD`)*
* **MinIO Object Console**: [http://localhost:9001](http://localhost:9001) *(Login: `minioadmin` / `minioadmin`)*
* **API Health Check**: [http://localhost:8080/healthz](http://localhost:8080/healthz)

### Networking & Rate Limits
* **The browser talks to the API through the UI's nginx** (`http://localhost:3000/api/...`). nginx sets `X-Forwarded-For`, and the API trusts it only from the UI container's fixed address (`172.30.250.10`, `ForwardedHeaders__KnownProxies__0`), so rate limits apply per client. Port 8080 is bound to loopback for local tooling only.
* **The compose network is pinned to `172.30.250.0/24`.** If that clashes with a network on your machine, change the subnet, the UI's `ipv4_address` and `ForwardedHeaders__KnownProxies__0` together.
* **Behind your own reverse proxy or load balancer**, list its address under `ForwardedHeaders:KnownProxies`, or its range under `ForwardedHeaders:KnownNetworks` (CIDR, e.g. `10.0.1.0/24`). Otherwise every client shares the proxy's rate limit. Make sure the proxy overwrites `X-Forwarded-For` rather than appending to a client-supplied one.
* **Docker Desktop (Windows/macOS) hides client addresses**: its port forwarding makes every connection appear to come from one gateway address, so locally all clients still share one rate-limit partition. Linux hosts and real proxies don't have this problem.
* **Metrics** are served only on port 9464 (`Metrics:Port`), which compose never publishes; Prometheus scrapes `api:9464` over the internal network.
* **Storage addresses** (`Storage:ServiceUrl` for the API, `Storage:PublicBaseUrl` for browsers) may each be `http://` or `https://`. Upload and download links follow `PublicBaseUrl`'s scheme, so when the app is served over HTTPS, storage must be too, or browsers block the links as mixed content.

### Upload Limits & Encrypted Downloads
* **Bundles** hold up to 50 files and 5 GB in total (`UploadLimits:MaxBundleSizeBytes`), encrypted or not. For encrypted bundles the limit is measured before encryption.
* **Encrypted files** are encrypted and decrypted in the browser in 4 MiB chunks, so their size doesn't depend on the browser's memory. Downloads are written to disk as they decrypt: through a service worker (Chrome, Edge, Firefox), otherwise a "Save as" dialog, otherwise the site's private storage (OPFS, which Safari has).
* **Browsers with none of those** save in memory, capped at 1 GB. They are told before the download starts (so no download is used up) to open the link in Chrome, Edge or Firefox for anything larger. Safari's behaviour on real Apple devices hasn't been verified yet.

---

## 🧪 Running the Test Suites

### 1. Execute Backend Integration Tests (.NET xUnit)
```bash
dotnet test tests/FileHolder.Tests.Integration/FileHolder.Tests.Integration.csproj
```

### 2. Execute End-to-End Browser Automation Tests (Playwright)
```bash
cd src/fileholder-ui
npx playwright test
```

*For interactive visual UI testing mode:*
```bash
npx playwright test --ui
```

### 3. Testing from a Phone (e.g. Safari on iPhone)
Encrypted downloads are saved differently per browser (see *Upload Limits & Encrypted Downloads*), and CI can't run real Safari. To check a phone by hand, it has to reach your local stack **over HTTPS**: Safari only enables service workers and its private file storage (OPFS) on HTTPS, so a plain `http://<your-PC-IP>:3000` test would silently fall back to saving in memory and prove nothing.

1. **Run the current stack.** Older builds don't route the API through the UI: `docker compose up -d --build`
2. **Open two HTTPS tunnels** with [Cloudflare quick tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (free, no account; on Windows `winget install --id Cloudflare.cloudflared`), each in its own terminal. Each prints a temporary `https://….trycloudflare.com` address:
   ```bash
   cloudflared tunnel --url http://localhost:3000   # the app
   cloudflared tunnel --url http://localhost:9000   # storage: upload and download links point straight at it
   ```
3. **Point upload and download links at the storage tunnel:** copy `docker-compose.override.example.yml` to `docker-compose.override.yml` (git-ignored), put the storage tunnel's address in it, then `docker compose up -d api`.
4. **Upload through the app tunnel's address** (on the PC is fine), so the share link uses that address too. Open the share link on the phone with `?diagnostics` added, e.g. `https://….trycloudflare.com/f/AbCd1234?diagnostics`. A *Diagnostics* panel shows which saving methods the browser will try, why others are left out, the free site storage, and how the last download was saved. **Copy** puts the whole report on the clipboard.
5. **Checks:**
   - A small encrypted file downloads to *Files → Downloads* and opens; the panel says `via opfs`.
   - An encrypted file of about 1.5 GB (over the 1 GB in-memory cap) also says `via opfs`. If the page instead says the browser *can only save up to 1 GB*, the panel's *Left out up front* / *Skipped* reasons say why OPFS wasn't used.
   - *Download All* on a multi-file encrypted bundle gives a ZIP that opens in Files.
   - A tampered file must fail with an error, not save. Tamper with the stored copy (Git Bash on Windows): `scripts/tamper-stored-file.sh <share-token> [file-number] [byte-offset]`. It flips one byte (by default in the middle of the file) and prints the command that restores it.
6. **Close the tunnels** (Ctrl+C) when done: while open, anyone with an address can reach the app. Use throwaway files, and don't tunnel the MinIO console (port 9001). Then delete `docker-compose.override.yml` and run `docker compose up -d api`.

If uploads fail with `403 SignatureDoesNotMatch`, the storage tunnel isn't passing the original host name on to MinIO (upload links are signed for it). A named Cloudflare tunnel has a fixed host name that can be set with `--http-host-header`. Upload parts are 16 MiB and single uploads at most 50 MB, well under Cloudflare's per-request size limit.

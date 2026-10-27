# 💻 Development

## Application Endpoints
* **Web app**: [http://localhost:3000](http://localhost:3000). This port is published on **all network interfaces**, so other devices on your network can reach it too.
* **API health check**: [http://localhost:8080/healthz/ready](http://localhost:8080/healthz/ready).
  * **Statuses:**
    * *Unhealthy* (503): the database or storage can't be reached.
    * *Degraded* (still 200): the purge is lagging, or storage is filling up. The storage lifecycle rule isn't confirmed, the purge worker hasn't completed a run for an hour, bundles have waited over 2 hours to be deleted, or 80% of the storage quota is in use.
  * **Who waits on it:** compose (before starting the UI) and CI.
  * **Liveness:** [`/healthz/live`](http://localhost:8080/healthz/live) only shows the process is up. `/healthz` is the same as `/healthz/ready`.
  * **Metrics:** each check's status is also on the metrics port as `fileholder_health_status`, with `fileholder_purge_overdue_groups`, `fileholder_purge_last_success_age_seconds`, `fileholder_storage_used_bytes` and, with a quota set, `fileholder_storage_quota_bytes`. The maintenance mode is `fileholder_service_mode{mode}` (see [Maintenance Modes](operations.md#maintenance-modes)).
* **Grafana**: [http://localhost:3001](http://localhost:3001) *(login: `admin` / your `GRAFANA_ADMIN_PASSWORD`)*. Prometheus metrics, and Tempo traces (see [Tracing](operations.md#tracing)).
* **Storage console (Silo)**: [http://localhost:9001](http://localhost:9001) *(login: your `STORAGE_ROOT_USER` / `STORAGE_ROOT_PASSWORD`)*
* **Scalar API docs**: only when the API runs in Development (see [API and UI Outside Docker](#-api-and-ui-outside-docker)). The compose stack runs the API in Production.

## Passwords and Storage Users
* **No password is committed.** `docker-compose.yml` reads them all from `.env`, and `appsettings.json` has none.
* **The API has its own storage user,** `fileholder-api`, which `minio-init` creates on every start. `docker/silo/api-policy.json` limits it to the one bucket: its objects, multipart uploads, and the safety net's lifecycle rule. It can't change the bucket's access policy or touch other buckets. The storage admin (`STORAGE_ROOT_*`) is only used by `minio-init` and the storage console.
* **Changing a password:**
  * `GRAFANA_ADMIN_PASSWORD`, `STORAGE_ROOT_*`, `STORAGE_API_SECRET_KEY` and `ADMIN_TOKEN`: edit `.env` and run `docker compose up -d`. Storage keeps its data under new admin credentials, and `minio-init` updates the API user's secret.
  * `POSTGRES_PASSWORD` only takes effect when the `postgres_data` volume is first created. To change it on an existing volume, change it in the database first, then in `.env`, then run `docker compose up -d`:
    ```powershell
    docker compose exec postgres psql -U fileholder_user -d fileholder_db -c "ALTER USER fileholder_user PASSWORD 'the-new-password'"
    ```
* **Upgrading a stack from before `ADMIN_TOKEN` existed:** add `ADMIN_TOKEN=<64 random hex characters>` to `.env` (PowerShell: `"ADMIN_TOKEN=$(New-Secret)$(New-Secret)" | Add-Content -Encoding ascii .env`, with `New-Secret` from [Quick Start](../README.md#-quick-start)).
* **Upgrading a stack from before these passwords existed:** its Postgres volume still has the old password, `fileholder_password`. Either put `POSTGRES_PASSWORD=fileholder_password` in `.env` and change it as above, or start from empty volumes with `docker compose down -v` (deletes the local database and stored files).

## Networking & Rate Limits
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
* **Security headers on the UI pages** (`nginx.conf.template`): a Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, and a `Permissions-Policy` that turns off the camera, microphone, location, motion sensors, payment and USB. API responses get theirs from the API (`SecurityHeadersMiddleware`).
  * The policy lets the page run only its own scripts and connect only to itself and to storage. The UI container's `STORAGE_PUBLIC_URL` must therefore match the API's `Storage__PublicBaseUrl`, or every upload and download is blocked. The container won't start without a valid one.
  * Check for violations in the browser console (*Refused to …* / *Content-Security-Policy*). `e2e/securityHeaders.spec.ts` fails on any.

## ⚙️ Configuration

The API reads standard .NET configuration: `appsettings.json`, then environment variables, where `:` becomes `__` (e.g. `Storage__PublicBaseUrl`). The compose file sets these for the containers.

| Setting | Compose value | Meaning |
| :--- | :--- | :--- |
| `ConnectionStrings__PostgresConnection` | `Host=postgres;…;Password=<POSTGRES_PASSWORD>;Maximum Pool Size=50` | PostgreSQL connection string. Required: the API refuses to start without one. Keep each API instance's pool size well under Postgres' `max_connections` (100), so other instances and tools can still connect |
| `Storage__ServiceUrl` | `http://minio:9000` | Storage address the **API** uses |
| `Storage__PublicBaseUrl` | `http://localhost:9000` | Storage address in upload and download links, so it must be reachable from **browsers** |
| `Storage__AccessKey`, `Storage__SecretKey` | `fileholder-api`, `STORAGE_API_SECRET_KEY` from `.env` | The API's own storage user (see [Passwords and Storage Users](#passwords-and-storage-users)). Required: the API refuses to start without them |
| `Storage__BucketName` | `fileholder-bucket` | Bucket for all files |
| `UploadLimits__MaxBundleSizeBytes` | 5 GB (default) | Largest bundle. The UI reads it from the API |
| `UploadLimits__MaxExpiryHours` | 168 (default) | Longest a bundle may live, 1–168. Lowering it also shortens the storage lifecycle rule |
| `UploadLimits__GlobalQuotaBytes` | unset (no quota) | Most storage all bundles and pending uploads may take up together, counted from their declared sizes. A cap on what's accepted, not an exact meter: confirm's copies of single-part files and two presigns at once can go a little past it |
| `RateLimits__*PermitLimit` | see [rate limits](security.md) (defaults) | Requests per client address per minute, per endpoint group. Raise only for single-address test stacks |
| `Storage__LifecycleExpiryDays` | unset (10, calculated) | Days after which storage deletes any object. Only for a longer safety net; lower than the calculated value refuses to start |
| `Storage__LifecycleRule` | `Apply` (default) | `Apply`: the API puts the lifecycle rule on the bucket at startup and confirms it. `External`: it's set outside the app (R2's dashboard, see [Running on Cloudflare R2](operations.md#running-on-cloudflare-r2)); the API makes no lifecycle call and logs the values the rule should have |
| `ForwardedHeaders__KnownProxies__<n>` / `ForwardedHeaders__KnownNetworks__<n>` | `172.30.250.10` | Proxies whose `X-Forwarded-For` is trusted |
| `Cors__AllowedOrigins__<n>` | `http://localhost:3000` | Origins whose pages may call the API cross-origin, e.g. `https://fileholder.app`. None by default: through nginx the browser calls the API same-origin, which needs no CORS. Scheme, host and port only, with no trailing slash, or the API refuses to start |
| `Metrics__Port` | 9464 (default) | Internal Prometheus metrics port |
| `Hosting__ShutdownTimeoutSeconds` | 90 (default) | On a stop (a deploy), how long requests already running may finish. Bundle ZIPs stream through the API, so a longer one is cut off after this. Compose's `stop_grace_period` (100 s) must be longer than this plus the linger |
| `Hosting__LingerSeconds` | 5 (default) | How long the API stays up after its last response, so the end of a ZIP still in the network buffers reaches nginx before Docker removes the container's network |
| `Admin__Token` | `ADMIN_TOKEN` from `.env` | Bearer token for the admin endpoints (see [Maintenance Modes](operations.md#maintenance-modes)). At least 32 characters, or the API refuses to start; empty turns the admin endpoints off |
| `UploadLimits__WithoutCodeMaxBundleSizeBytes`, `UploadLimits__WithoutCodeMaxExpiryHours` | unset (production: 10 MB, 1 hour) | The limits of an upload without an access code. Set both to turn access codes on ([Access Codes](operations.md#access-codes)); no larger than the full limits, or the API refuses to start |
| `Admin__Port` | 9465 (default) | The only port the admin endpoints answer on. Compose binds it to the host's loopback |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://tempo:4317` | Where traces go over OTLP. Unset (the default outside compose), nothing is sent; log lines inside a trace still end with `trace=… span=…` |
| `Tracing__SampleRatio` | 1 (default) | Share of requests traced, 0–1. Lower it (e.g. 0.1) on a deployment that sends traces |
| `Tracing__RecordClientAddress` | false (default) | Keep the caller's address on request spans, for debugging rate limits or the lockout on a real host |
| `ASPNETCORE_ENVIRONMENT` | `Production` | `Development` enables Scalar and detailed errors |
| `.env`: `GRAFANA_ADMIN_PASSWORD`, `POSTGRES_PASSWORD`, `STORAGE_ROOT_USER`, `STORAGE_ROOT_PASSWORD`, `STORAGE_API_SECRET_KEY`, `ADMIN_TOKEN` | (yours) | The stack's passwords (see [Quick Start](../README.md#-quick-start) and `.env.example`) |
| UI: `TRUSTED_PROXIES` | empty | Addresses or CIDR ranges of a reverse proxy in front of the UI container (Caddy in production). nginx then takes the client's address and scheme from that proxy's `X-Forwarded-For` and `X-Forwarded-Proto`. Empty: clients connect directly and those headers are ignored. A malformed value stops the container |
| UI: `STORAGE_PUBLIC_URL` | `http://localhost:9000` | The same address as `Storage__PublicBaseUrl`, without a path. The UI's Content-Security-Policy allows connections to it; without a valid one the container doesn't start |
| Build: `GIT_SHA`, `VERSION` (build args; compose reads them from the environment) | unset | The commit and image version label (see [Versions and Releases](operations.md#versions-and-releases)). Unset, the commit shows as `unknown` and the label as `dev` |
| UI: `VITE_OPERATOR_NAME`, `VITE_CONTACT_EMAIL` (build time) | `Henryk I`, `security@fileholder.app` (`.env.production`, Dockerfile) | Who runs the deployment and where to write, named on `/terms` and `/privacy`. Unset, the pages use a neutral wording |
| UI: `NGINX_LOG_CLIENT_ADDRESS` | `off` (default) | `off`: no client address in the access log. `masked`: the network only (IPv4 /24, IPv6 /48), for investigating abuse for a while; the privacy page allows this. Anything else stops the container |
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
| `scripts/release.ps1` | Cuts a release with release-please while GitHub Actions are off ([Versions and Releases](operations.md#versions-and-releases)) |
| `docker-compose.prod.yml`, `docker/caddy/Caddyfile` | The production setup behind Caddy ([Production](operations.md#production)); `docker-compose.prod-local.yml` and `scripts/prod-local.ps1` run it locally |
| `scripts/pre-deploy-check.ps1` | Runs what CI, the nightly job and the security scans would, before a deploy ([Testing](testing.md#6-before-a-deploy-everything-ci-would-run)) |
| `scripts/deploy.ps1` | Deploys this checkout to the production server over SSH, or rolls it back ([Production](operations.md#production)) |
| `scripts/admin.ps1` | The owner's controls: the maintenance mode and takedowns ([Maintenance Modes](operations.md#maintenance-modes), [Takedown](operations.md#takedown)) |

---

## 🧰 API and UI Outside Docker

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

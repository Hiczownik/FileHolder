# Load tests (k6)

These run many requests at once against the compose stack, with [k6](https://grafana.com/docs/k6/), to check two
things: that the rules which only matter under concurrency hold (download limits, password lockout, caching), and how
the app behaves at volume. They are run on demand, not on every push (#73).

## Running them

Docker must be running. From the repository root, in PowerShell (Windows PowerShell 5.1 or PowerShell 7):

```powershell
./tests/load/run.ps1 4              # one scenario, by number or name (04-download-race)
./tests/load/run.ps1 4,5,6,9        # several: the quick correctness checks, about 6 minutes
./tests/load/run.ps1 1,2,3,7        # the capacity runs, about 30 minutes
./tests/load/run.ps1 all -Build     # every scenario (with the 2-hour soak), after rebuilding the API and UI images
./tests/load/run.ps1 4 -K6Env BURSTS=2,CLIENTS=20   # smaller, by setting the scenario's variables
```

For each scenario, `run.ps1`:

1. **Starts the stack** with two extra compose files:
   * `docker-compose.load.yml` makes presigned URLs point at `http://minio:9000`, because the k6 container sends the
     storage PUTs and GETs itself, and lets Prometheus receive k6's metrics. **While it is applied, uploads from your
     browser fail.**
   * `docker-compose.load-capacity.yml` raises every rate limit to 100,000 a minute, because all k6 traffic comes from
     one address. Scenario 9 leaves it out, because it tests the production limits.
2. **Runs the scenario** in the `k6` service (`docker-compose.yml`, profile `load`, so `docker compose up` never
   starts it). Requests go through the UI container's nginx (`http://ui/api/…`), as a browser's do. k6 sends its
   metrics to Prometheus as it goes (see *Watching a run* below).
3. **Checks what the run left behind** (see below), and fails if any check does.
4. **Purges the run**: makes everything it created due, restarts the API (whose purge runs once at start), and checks
   that one purge run removed all of it, and that storage holds no object or unfinished upload written during the run.
   This also gives the disk space back. Pass `-NoPurge` to keep the run's bundles, e.g. to look at them.
5. **Starts the stack with its usual configuration again**, including your `docker-compose.override.yml`. Pass
   `-KeepLoadConfig` to skip this, for example between several runs.

Each run gets an id such as `20261023-143101-04`. The bundles it creates have it in their title
(`k6 <run id> download race 3`), so its checks find exactly the bundles it made. The purge step finds everything the run
made by when it was made, which is safe because nothing else can upload while the load configuration is applied.

k6's summary of each run is saved as JSON in `tests/load/results/` (git ignores it).

**Disk space.** Docker Desktop's virtual disk grows to the most it ever held and doesn't shrink by itself, so the
scenarios are sized by data, not only by time: none holds more than about 12 GB at once (scenario 3), and each is
purged before the next starts.

## Watching a run

Grafana (`http://localhost:3001`) has a **FileHolder load tests** dashboard (`docker/grafana/provisioning/dashboards`).
Pick a run by its id: it shows k6's side (virtual users, requests a second, p95 and failures by request, checks, data
through k6) next to the API's (requests and p95 by route, 5xx, memory, CPU, requests in progress) and the purge's
(bundles overdue, time since the last run). Prometheus keeps its data in a volume, so a run's metrics are still there
after `run.ps1` puts the stack back.

## Scenarios

The numbers are the scenario numbers in #73. They all need nothing but the compose stack.

| # | Scenario | Load | Passes when |
| :--- | :--- | :--- | :--- |
| 1 | **Many small files** (`01-small-files.js`): bundles of 50 × 100 KB | 1 to 20 clients over 5 minutes, each uploading bundle after bundle (presign, 50 PUTs, confirm), then opening it and downloading one file | Confirm p95 < 3 s (it makes about 3 storage calls per file, one after another, #37); no failed request; every bundle lists its 50 files and its file downloads in full |
| 2 | **Large multipart** (`02-large-multipart.js`): 2 GiB files in 16 MiB parts, 4 at a time | 5 clients, one file each (10 GiB; `ITERATIONS` for more) | Every part and every upload succeeds; exactly 10 GiB arrives; the API's working set peaks < 150 MB above where it started (parts go straight to storage). Records the upload throughput |
| 3 | **Mixed** (`03-mixed.js`) | 12 uploads a minute for 15 minutes (70% small: 3 × 1 MB, 20% medium: 5 × 20 MB, 10% large: 1 × 200 MB multipart; 30% of them encrypted), and 60 downloads a minute of bundles made in setup (by file, or 30% as the server's ZIP) | p95 limits per endpoint (presign 500 ms, confirm 3 s, bundle page 200 ms, …); under 0.1% failed requests and checks |
| 4 | **Download race** (`04-download-race.js`): bundles with `MaxDownloads = 5` | 100 clients open a download session on one bundle at the same moment, 20 times with new bundles | **Exactly 5** sessions open each time; the other 95 get 410; every winner downloads the whole file; the used-up bundle reports gone. In the database: `DownloadCount` = 5, 5 sessions, marked deleted |
| 5 | **Parallel password guessing** (`05-password-guessing.js`) | 50 clients send a wrong password to one protected bundle at the same moment, 5 times with new bundles | **Exactly 6** guesses are verified (the 5 free ones and the one that takes the verification hold); the other 44 get 429 with `Retry-After`. Then the correct password is refused while locked, the lockout is `LockoutAfter(6)` = 1 minute, the password is accepted after it, and a wrong one after that is a free attempt again. Takes about 80 s |
| 6 | **Bundle info under load** (`06-bundle-info.js`) | 100 requests/s for one known bundle and 1,400/s for random unknown tokens, for 2 minutes | Known: always 200, p95 < 50 ms. Unknown: always 404, p95 < 250 ms. The API's heap (from Prometheus) grows < 48 MB, so unknown tokens aren't cached |
| 7 | **Server ZIP streaming** (`07-zip-streaming.js`): one 1 GiB bundle of four `.zip` files (stored, not compressed again) | 20 clients start `download-all` at the same moment | Every ZIP downloads to the end; the bytes received are at least 20 × 1 GiB (and no more than that plus 0.5% chunked framing); first byte p95 < 2 s; the API's working set peaks < 200 MB above where it started; nginx never spools a response to disk |
| 8 | **Soak** (`08-soak.js`): scenario 3's traffic, slowly | 2 uploads and 10 downloads a minute for 2 hours | Under 0.1% failures; the API's average working set in the last 15 minutes is < 100 MB above that of minutes 10–25; every bundle that came due during the soak was purged in time, by the purge worker itself (`checks/08-soak.sql`) |
| 9 | **Rate limits** (`09-rate-limits.js`), production limits | One client per policy pushes past its limit | Only 429s, never 5xx; every 429 has `Retry-After` (1–60 s); a client that doesn't wait is refused again; one that waits gets through; in a fresh window exactly the limit (10 presigns, 300 multipart, 10 confirms, 30 downloads, 60 bundle loads) gets through, and the next is refused. Takes about 1 minute |

Each scenario's variables (`CLIENTS`, `BURSTS`, `DURATION`, `KNOWN_RATE`, …) and their defaults are at the top of its
file.

Encrypted uploads need no real encryption: the server only checks sizes and the shape of the key material, so
scenario 3 uploads `EncryptedSize(n)` bytes with well-formed placeholder salt, envelope and manifest.

Still to come (#73): a workflow to run them on demand and nightly.

## Checks after every run

* **k6's thresholds and checks.** k6 exits with 99 if any fail.
* **Postgres connections**, counted every 2 s during the run from the database's processes. The run fails if the API
  took every connection Postgres allows (`max_connections`, 100), because then nothing else can connect.
* **API logs** of the run: no `ERR`/`FTL` lines and no unhandled exceptions.
* **nginx logs** of the run: no errors, and no response spooled to a temporary file (a streamed ZIP must pass straight
  through).
* **`checks/<scenario>.sql`**, if there is one, run with the run's id and start time. Every row it prints is a failure.
* **Nothing left behind**, unless `-NoPurge`: after the purge step, none of the run's bundles, pending uploads or
  multipart uploads remain due, and storage has no object or unfinished multipart upload written since the run began.

## What the first runs found

* **The API's connection pool could take all of Postgres' connections.** Npgsql's default pool size (100) equals
  Postgres' `max_connections`, so scenario 4's 100 simultaneous clients left the API holding every connection, idle,
  for the 5 minutes Npgsql keeps them. psql, and the migrations of a second API instance, were refused.
  `docker-compose.yml` now sets `Maximum Pool Size=50`.
* **nginx ran out of local ports above a few hundred requests a second.** It opened a new connection to the API for
  every request, and each closed one holds a port for a minute. In scenario 6, 69% of requests got 502
  (`connect() … failed (99: Address not available)`). `nginx.conf` now keeps connections to the API open and reuses them.
* **The purge couldn't keep up with uploads.** Each run of the purge worker (every 30 minutes) took one batch from each
  queue: 500 abandoned uploads, 100 bundles, 50 multipart uploads. Every single-file upload leaves its original for the
  purge (confirm serves a copy), so it could remove at most 1,000 files an hour, 20 bundles of 50 files, and anything
  more piled up in storage for good. A small scenario 1 run (50 bundles) already left 2,000 originals behind. Each run
  now keeps taking batches while they come back full and get something done, for up to 2 minutes per queue
  (`PurgeTimings.MaxQueueTimePerRun`); a batch of 500 takes under half a second. Afterwards one run removed all
  69,700 originals of a full scenario 1.

## Baseline

First runs on a 16-core Windows desktop (Docker Desktop, 12 GB for its VM), 2026-10-23. Compare later runs on the
same machine against these. Shared CI runners will be slower and vary more.

| # | Measure | Result |
| :--- | :--- | :--- |
| 1 | Bundles of 50 files in 5 minutes (ramp to 20 clients) | 1,394 (69,700 files), 0 failed requests |
| 1 | Confirm of a 50-file bundle, median / p95 | 742 ms / 2.36 s |
| 2 | Upload throughput, 5 clients × 2 GiB at once | about 48 MB/s per client |
| 2 | API working set, peak over start | +16 MB |
| 3 | 15 minutes, 180 uploads (30% encrypted) and 900 downloads | 7,490 requests, 0 failed, 0 dropped |
| 3 | p95: presign / confirm / bundle page / download session | 16 ms / 409 ms / 4.6 ms / 16 ms |
| 8 | 2-hour soak: 241 uploads, 10,100 requests | 0 failed; API working set 204 MB early on, 210 MB at the end; at most 3 Postgres connections; the purge worker kept up |
| 7 | 20 simultaneous 1 GiB ZIPs | about 350 MB/s together; first byte p95 110 ms |
| 7 | API working set, peak over start | +42 MB |
| 4 | `POST /{token}/downloads` and the download, p95 | 93 ms |
| 4 | Most Postgres connections | 50 (the pool's limit) |
| 5 | Unlock requests, p95 | 195 ms (6 bcrypt checks at once) |
| 6 | Known bundle, p95 | 1.1 ms |
| 6 | Unknown token, p95 | 3.2 ms |
| 6 | Throughput through nginx | 1,250 requests/s, 0 errors |
| 6 | API heap growth over 168,000 unknown tokens | 2 MB (129 MB with the cache eviction removed on purpose) |
| 9 | Requests, p95 | 4 ms |

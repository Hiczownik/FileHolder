# Load tests (k6)

These run many requests at once against the compose stack, with [k6](https://grafana.com/docs/k6/), to check two
things: that the rules which only matter under concurrency hold (download limits, password lockout, caching), and how
the app behaves at volume. They are run on demand, not on every push (#73).

## Running them

Docker must be running. From the repository root, in PowerShell (Windows PowerShell 5.1 or PowerShell 7):

```powershell
./tests/load/run.ps1 4              # one scenario, by number or name (04-download-race)
./tests/load/run.ps1 4,5,6,9        # several
./tests/load/run.ps1 all -Build     # every scenario, after rebuilding the API and UI images
./tests/load/run.ps1 4 -K6Env BURSTS=2,CLIENTS=20   # smaller, by setting the scenario's variables
```

For each scenario, `run.ps1`:

1. **Starts the stack** with two extra compose files:
   * `docker-compose.load.yml` makes presigned URLs point at `http://minio:9000`, because the k6 container sends the
     storage PUTs and GETs itself. **While it is applied, uploads from your browser fail.**
   * `docker-compose.load-capacity.yml` raises every rate limit to 100,000 a minute, because all k6 traffic comes from
     one address. Scenario 9 leaves it out, because it tests the production limits.
2. **Runs the scenario** in the `k6` service (`docker-compose.yml`, profile `load`, so `docker compose up` never
   starts it). Requests go through the UI container's nginx (`http://ui/api/…`), as a browser's do.
3. **Checks what the run left behind** (see below), and fails if any check does.
4. **Starts the stack with its usual configuration again**, including your `docker-compose.override.yml`. Pass
   `-KeepLoadConfig` to skip this, for example between several runs.

Each run gets an id such as `20261023-143101-04`. The bundles it creates have it in their title
(`k6 <run id> download race 3`), so its checks find exactly the bundles it made. The bundles expire after an hour and
the purge removes them, as it does any others.

k6's summary of each run is saved as JSON in `tests/load/results/` (git ignores it).

## Scenarios

The numbers are the scenario numbers in #73. They all need nothing but the compose stack.

| # | Scenario | Load | Passes when |
| :--- | :--- | :--- | :--- |
| 4 | **Download race** (`04-download-race.js`): bundles with `MaxDownloads = 5` | 100 clients open a download session on one bundle at the same moment, 20 times with new bundles | **Exactly 5** sessions open each time; the other 95 get 410; every winner downloads the whole file; the used-up bundle reports gone. In the database: `DownloadCount` = 5, 5 sessions, marked deleted |
| 5 | **Parallel password guessing** (`05-password-guessing.js`) | 50 clients send a wrong password to one protected bundle at the same moment, 5 times with new bundles | **Exactly 6** guesses are verified (the 5 free ones and the one that takes the verification hold); the other 44 get 429 with `Retry-After`. Then the correct password is refused while locked, the lockout is `LockoutAfter(6)` = 1 minute, the password is accepted after it, and a wrong one after that is a free attempt again. Takes about 80 s |
| 6 | **Bundle info under load** (`06-bundle-info.js`) | 100 requests/s for one known bundle and 1,400/s for random unknown tokens, for 2 minutes | Known: always 200, p95 < 50 ms. Unknown: always 404, p95 < 250 ms. The API's heap (from Prometheus) grows < 48 MB, so unknown tokens aren't cached |
| 9 | **Rate limits** (`09-rate-limits.js`), production limits | One client per policy pushes past its limit | Only 429s, never 5xx; every 429 has `Retry-After` (1–60 s); a client that doesn't wait is refused again; one that waits gets through; in a fresh window exactly the limit (10 presigns, 300 multipart, 10 confirms, 30 downloads, 60 bundle loads) gets through, and the next is refused. Takes about 1 minute |

Each scenario's variables (`CLIENTS`, `BURSTS`, `DURATION`, `KNOWN_RATE`, …) and their defaults are at the top of its
file.

Still to come (#73): many small files (1), large multipart uploads (2), mixed realistic traffic (3), server ZIP
streaming (7), the soak test (8), k6 results in Grafana, and a workflow.

## Checks after every run

* **k6's thresholds and checks.** k6 exits with 99 if any fail.
* **Postgres connections**, counted every 2 s during the run from the database's processes. The run fails if the API
  took every connection Postgres allows (`max_connections`, 100), because then nothing else can connect.
* **API logs** of the run: no `ERR`/`FTL` lines and no unhandled exceptions.
* **`checks/<scenario>.sql`**, if there is one, run with the run's id. Every row it prints is a failure.

## What the first runs found

* **The API's connection pool could take all of Postgres' connections.** Npgsql's default pool size (100) equals
  Postgres' `max_connections`, so scenario 4's 100 simultaneous clients left the API holding every connection, idle,
  for the 5 minutes Npgsql keeps them. psql, and the migrations of a second API instance, were refused.
  `docker-compose.yml` now sets `Maximum Pool Size=50`.
* **nginx ran out of local ports above a few hundred requests a second.** It opened a new connection to the API for
  every request, and each closed one holds a port for a minute. In scenario 6, 69% of requests got 502
  (`connect() … failed (99: Address not available)`). `nginx.conf.template` now keeps connections to the API open and reuses them.

## Baseline

First runs on a 16-core Windows desktop (Docker Desktop, 12 GB for its VM), 2026-10-23. Compare later runs on the
same machine against these. Shared CI runners will be slower and vary more.

| # | Measure | Result |
| :--- | :--- | :--- |
| 4 | `POST /{token}/downloads` and the download, p95 | 93 ms |
| 4 | Most Postgres connections | 50 (the pool's limit) |
| 5 | Unlock requests, p95 | 195 ms (6 bcrypt checks at once) |
| 6 | Known bundle, p95 | 1.1 ms |
| 6 | Unknown token, p95 | 3.2 ms |
| 6 | Throughput through nginx | 1,250 requests/s, 0 errors |
| 6 | API heap growth over 168,000 unknown tokens | 2 MB (129 MB with the cache eviction removed on purpose) |
| 9 | Requests, p95 | 4 ms |

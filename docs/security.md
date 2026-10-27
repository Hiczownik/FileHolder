# 🔒 Security

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
  * **The UI pages** get theirs from nginx: a Content-Security-Policy, `X-Frame-Options`, `nosniff`, `Referrer-Policy: no-referrer` and a `Permissions-Policy` ([Networking & Rate Limits](development.md#networking--rate-limits)). In production, Caddy adds `Strict-Transport-Security`.
* **Error responses** use RFC 7807 `ProblemDetails`. Internal error messages are only shown in Development.
* **Logs** name the route (`/api/v1/files/{shareToken}`), never the request path, since a share token opens a bundle without a password. File names and titles stay out of them too: a rejected request's message, which can name a file, is only logged at `Debug`. nginx's access log shows `[token]` in place of the token, leaves out query strings, and records **no client address** (`-`, unless `NGINX_LOG_CLIENT_ADDRESS=masked` is switched on while investigating abuse). Its error log only takes critical errors for requests: an ordinary one, such as the API being unreachable during a deploy, would carry the full address and request line in a format that can't be changed. **FileHolder stores no IP addresses**: the rate limits use them in memory only ([Production](operations.md#production), `/privacy`).
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

**[Threat model](threat-model.md):** what each party can see and do, the protections with their code, the known gaps and the accepted risks.

**Found a vulnerability?** Please don't open a public issue; see [`SECURITY.md`](../SECURITY.md).

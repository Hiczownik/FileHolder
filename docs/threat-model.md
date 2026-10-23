# FileHolder threat model

What FileHolder protects, from whom, how, and what it doesn't protect. Every claim points to the code or to an issue. If a change makes any of this untrue, update this file in the same PR (see [Keeping it current](#7-keeping-it-current)).

*Last reviewed: 2026-10-23, against `main` with PR #131 (title of locked bundles) merged.*

---

## 1. Scope and assumptions

- **Today:** FileHolder runs locally and in CI only (`docker-compose.yml`).
  - Plain HTTP locally. HTTPS only through a tunnel, for phone testing (README, *Testing from a Phone*).
  - One operator, no accounts. Anyone who can reach the UI can upload.
- **Planned:** a public deployment, tracked in #82.
  - Where the answer changes once deployed, a **When deployed** note says so: HTTPS, a real operator, backups, abuse of anonymous uploads.
- **Kinds of bundle:**
  - **Normal:** files stored as uploaded. An optional password guards them.
  - **Encrypted, link-only:** the browser encrypts the files. The key is in the share link's fragment (`/f/{token}#k={linkKey}`), so **the link is the secret**.
  - **Encrypted, link + passkey:** the link alone can't open the files. The recipient also needs a passkey that the uploader sends separately.

## 2. What's protected

| Asset | Why it matters |
| :--- | :--- |
| **File contents** | The point of the app. |
| **File names and titles** | They often say as much as the contents ("Tax return 2026"). |
| **Passwords and passkeys** | They open bundles; people reuse passwords. |
| **Link keys** (encrypted bundles) | 32 random bytes in the link fragment (`cryptoUtils.ts`, `LINK_KEY_BYTES`). Anyone who has one can open a link-only bundle. |
| **Share tokens** | 8 characters from 62 ≈ 47.6 bits (`CryptoUtils.GenerateShortToken`). With one, anyone can open a normal bundle without a password. Elsewhere they reveal that a bundle exists, plus its metadata. |
| **Upload tokens** | 128-bit GUIDs (`CreatePresignedUploadUrlAsync`). Whoever holds one can confirm the upload. |
| **Presigned URLs** | Temporary credentials, valid for anyone holding them: 5 min for downloads (`DownloadTimings.PresignedUrlLifetime`), 15 min for single uploads (`UploadTimings.SinglePutUrlLifetime`). |
| **The download limit and expiry** | The promise that a bundle opens at most N times and is then gone. |
| **Storage and database credentials** | They give access to everything. |

## 3. Who might attack, and what each party sees today

| Party | Normal bundle | Encrypted, link-only | Encrypted, link + passkey |
| :--- | :--- | :--- | :--- |
| **Anyone with the share token only** (no fragment, no password; e.g. from a log or a link with the fragment cut off) | Without a password: **everything**. With a password: file count, expiry, downloads left. Title, names and sizes are hidden (`GetGroupMetadataByTokenAsync`, locked branch). **410** once expired or used up | File count, key mode, `keySalt`, expiry, downloads left. Never the title (#65), names or contents | Same as link-only |
| **Anyone with the full link** | Same as the row above | **Everything** (by design: the link is the secret) | Same as the share token only. The passkey is still needed |
| **Anyone with the link and the password or passkey** | Everything | Everything | Everything |
| **Whoever runs the server, or has database or volume access** | **Everything**, contents included, until the purge. After the purge, a tombstone holds only the share token and timestamps for 7 days (`PurgeTimings.PurgedGroupRetention`, `ScrubPurgedGroupsAsync`) | File count, encrypted sizes (≈ plaintext sizes), timings, `kAuth` at unlock. **Never contents, names or the title.** No offline guessing either: the 256-bit link key is never sent to the server | Same as link-only. **Offline passkey guessing also needs the link key**, which the server never has |
| **The network** (between browser and server or storage) | Everything over HTTP (local only, by design). Protected by HTTPS when tunnelled or deployed | Only encrypted data and metadata. The fragment is never sent in requests | Same as link-only |
| **Wherever the link travels** (chat apps, email, link previews, the clipboard) | The share token | **The link key: everything** | The link key, but not the passkey if it's sent separately |
| **A malicious uploader** | Blocked file types are refused by the server (`FileSecurityUtils.IsExtensionForbidden`). Can upload 5 GB per bundle anonymously, rate-limited per IP only | Writes the manifest, so can try malicious names (checked in the recipient's browser) or extreme chunk settings (bounded by `parseStreamParams`) | Same as link-only |
| **A malicious recipient** | Uses up the download limit for others. Triggers the lockout to block others (capped at 1 h: `PasswordLockout.MaxLockout`) | Uses up the download limit | Same as normal |
| **Another website** | **Can frame the UI pages:** nginx sends no `X-Frame-Options` or CSP (#130) | Same | Same |
| **Whoever controls the served JavaScript** (a compromised server, nginx or build) | n/a: the server sees everything anyway | **Can serve code that leaks link keys and contents.** Accepted risk, see §6 | Same, passkeys included |

**When deployed:** the network row assumes HTTPS everywhere (#82). Backups of the database or storage volume extend the operator row past the purge (§5).

## 4. Protections in place

### Storage
- **The bucket is private; all access is through presigned URLs.**
  - `minio-init` runs `mc anonymous set none` (`docker-compose.yml`).
  - CI step "Verify Storage Bucket Rejects Anonymous Access" (`.github/workflows/ci.yml`).
- **Single-file uploads are served from a copy**, so the presigned PUT can't overwrite the object after it has been checked. The copy's size is re-checked in storage (`ConfirmAndPersistFileGroupAsync`, `CopyObjectAsync` + `GetObjectSizeAsync`).
- **Confirm only accepts files approved at presign** (`PendingUploads`), and claims the upload token first, so a second confirm can't race it (#37).
- **Nothing outlives the app's limits:**
  - the purge worker runs every 30 min (`PurgeTimings.CheckInterval`);
  - a bucket lifecycle rule backs it up (`StorageLifecycleInitializer`, `StorageSafetyNet`, #69);
  - storage aborts stale multipart uploads (`MINIO_API_STALE_UPLOADS_EXPIRY`);
  - the health check reports a stuck purge (#80).
- **Purged bundles become tombstones** (#77): file rows are deleted, and every title, hash, salt, envelope and manifest is cleared. The tombstone itself is deleted after 7 days (`StoragePurgeService.ScrubPurgedGroupsAsync`).

### File names and headers
- **File names are sanitized and blocked extensions refused on both sides.** Server: `FileSecurityUtils` (trailing dots and spaces stripped, #92). Browser: `fileNameSafety.ts`, applied to decrypted manifest names in `bundleDecryptionService.ts`. Shared test vectors keep the two copies in step (`tests/vectors/file-names.json`).
- **`Content-Type` must match a strict media-type pattern** (`BundleRules.MustBeValidContentType`). **`Content-Disposition` is always plain ASCII** (`ContentDispositionUtils`).

### Access control
- **Locked bundles show only file count, expiry and downloads left.** Title, names and sizes appear only after unlocking (`GetGroupMetadataByTokenAsync`, PR #131).
- **Passwords are stored as bcrypt** (work factor 11) **over SHA-256**, so passwords longer than 72 bytes aren't silently cut short (`CryptoUtils.HashPassword`, #53).
- **Per-bundle password lockout:**
  - 5 free attempts, then 1, 2, 4 … minutes, up to 1 h;
  - a verification hold, so parallel guesses can't be checked side by side (`PasswordLockout`).
- **Per-IP rate limits** (`RateLimitPolicies`):
  - presign 10/min, multipart 300/min, confirm 10/min, unlock and download 30/min, metadata 60/min;
  - IPv6 is grouped per /64;
  - `X-Forwarded-For` is trusted only from nginx (`ForwardedHeaders:KnownProxies`), and nginx overwrites it rather than appending.
- **Download counting is one conditional `UPDATE`** (`DownloadSessionService`), so the limit holds however many recipients try at once.
- **Expiry is checked before the password**, so a used-up bundle never uses up guesses (#43).

### Encryption (`streamCipher.ts`, `cryptoUtils.ts`)
- **AES-256-GCM in 4 MiB chunks** (the STREAM construction):
  - each nonce holds a random prefix, the chunk index and a last-chunk flag, which stops reordering, truncation and extension;
  - every chunk authenticates the format version and chunk size;
  - chunk sizes read from a manifest are bounded (1 KiB–16 MiB).
- **Keys:**
  - each bundle gets a random master key, and each file a key derived from it with HKDF;
  - the manifest and the title (#65) are encrypted with the master key;
  - the master key is wrapped with `kWrap`.
- **`kAuth` and `kWrap` both come from the link key, or the link key plus the passkey, via HKDF with separate labels** (`splitKeys`, `deriveLinkKeys`). The server only ever receives `kAuth`, and can't derive `kWrap` from it.
  - The passkey is stretched with Argon2id, 64 MiB, 3 passes, 1 lane by default (`kdfParams.ts`, `argon2.ts`, in a worker), after NFC normalisation. Each guess at a passkey costs that much memory, which slows GPU guessing far more than PBKDF2 did (#78).
  - The settings are stored with each bundle (`KdfParams`), so later uploads can use stronger ones. The uploader chooses them and the recipient's browser runs them, so both sides accept only Argon2id 1.3 with 16–256 MiB, 1–10 passes and 1–4 lanes, in one canonical spelling (`KeyDerivationParams`, `parseKdfParams`, shared cases in `tests/vectors/kdf-params.json`). A bundle can't make a recipient's browser run costly settings.
  - Generated passkeys are unbiased (#48): 12 characters from 35 ≈ 61.5 bits (`passkey.ts`).
- **The link key never leaves the browser:**
  - it lives in the fragment, which isn't sent in requests or in `Referer` (`shareLink.ts`);
  - the download page removes it from the address with `replaceState` and keeps it in `sessionStorage` for that tab only (`useFileDownload.ts`, `linkKeyStore.ts`).

### Responses, logs and infrastructure
- **Security headers on API responses:** `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, CSP (`SecurityHeadersMiddleware`). The UI pages don't have them yet (§5).
- **Errors are RFC 7807 `ProblemDetails`.** Internal messages are shown only in Development.
- **Share tokens stay out of logs:**
  - the API logs route templates, not paths (Serilog override in `Program.cs`);
  - nginx's access log writes `[token]` and drops query strings (`nginx.conf`).
  - File names and titles are logged only at `Debug`.
- **Ports:** storage, database, API, Prometheus and Grafana are bound to loopback. Metrics are only on an unpublished port (9464). Grafana needs a password from `.env`.
- **Supply chain** (#74):
  - images are pinned by digest, actions by SHA, and NuGet versions are exact;
  - Dependabot proposes updates;
  - NuGet audit, npm audit and Trivy gate CI;
  - Semgrep and gitleaks run in `security.yml`.

> **Note (2026-10-22):** GitHub Actions are turned off for now (minute limit). The CI checks named above exist, but they aren't running. PRs are verified locally until Actions are back on.

## 5. Known gaps

| Gap | Tracked in |
| :--- | :--- |
| **No security headers on UI pages.** nginx sends no CSP, `X-Frame-Options`, `nosniff` or `Referrer-Policy`, so the pages can be framed and nothing limits script sources. | #130 (deployment blocker) |
| **Weak secrets are allowed:** passwords need only 4 characters (`BundleRules`); a typed passkey can be a single character, which Argon2id can't make safe. The lockout limits online guessing. Offline guessing of a passkey also needs the link key. | #78 (part 3: a 10-character passkey minimum) |
| **Link keys and `kAuth` sit in `sessionStorage`**, so any script running on the origin can read them. That makes the CSP in #130 important. | #130 |
| **Rate limits are per IP.** Changing IP sidesteps them. On Docker Desktop all clients share one partition (README). The lockout protects passwords, but nothing limits anonymous uploads beyond the per-IP limit. | #82 (upload abuse) |
| **Committed default credentials** (Postgres password, `minioadmin`), and **the API uses the storage root credentials**. | #82 |
| **No HTTPS** outside tunnels, and `X-Forwarded-Proto` trust and HSTS are undecided. | #82 |
| **nginx's error log** shows the full request, share token included, when it can't reach the API (its format can't be changed). | README, *Logs* |
| **Backups** (once there are any) would keep files and rows past the purge. | #82 |
| **A share token can be issued again** once the old bundle's tombstone is deleted (7 days after the purge), because uniqueness only covers live bundles. An old link would then open a new bundle. The chance is negligible (≈ 47.6 bits per token). | (accepted, see §6) |

## 6. Accepted risks

- **The server serves the code that encrypts.** As with every browser-based encryption app, a compromised server, nginx or build could serve JavaScript that sends keys or contents elsewhere, and users couldn't tell. Mitigations:
  - a strict CSP (#130);
  - the command-line client as an independent way to encrypt and decrypt (#66);
  - later, Subresource Integrity on built assets, and reproducible UI builds with published hashes.
- **For link-only bundles, the link is the secret.** Wherever the link goes (chat history, email, link-preview services), the key goes too. The upload form says so and offers "Also require a passkey".
- **Storage CORS is `*`** (`MINIO_API_CORS_ALLOW_ORIGINS`). Presigned signatures control access, not the origin.
- **Default credentials are fine locally only.** They're a deployment blocker (#82).
- **For encrypted bundles, the server sees metadata:** file count, approximate sizes (≈ plaintext sizes) and timings. Padding sizes would be a separate idea.
- **Used-up or expired bundles reveal for 7 days that they existed** (410 rather than 404), via the tombstone.
- **Share-token reuse after tombstone deletion** (see §5): too unlikely to matter.

## 7. Keeping it current

- **Any PR that changes who can see or do what updates this file.** The PR template asks (`.github/pull_request_template.md`).
- Changes coming that will need an update:
  - #78 part 3: the passkey minimum, and SHA-256 instead of bcrypt for `kAuth`;
  - #66: the command-line client;
  - the manage link (a second bearer secret);
  - request-files (public-key encryption);
  - the deployment (#82).
- **Review the whole document before deploying,** and refresh *Last reviewed* at the top.

See also [`SECURITY.md`](../SECURITY.md) for how to report a vulnerability.

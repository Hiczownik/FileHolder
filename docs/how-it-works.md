# 🚀 How It Works

```
                 /api/v1/files/...
  Browser ───────────────────────▶ nginx (ui) ───▶ API (.NET 10) ───▶ PostgreSQL
     │                                               │
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
| In-memory saving (browsers without streaming saves) | 1 GB | see [Encrypted Downloads](#-encrypted-downloads) |

The UI reads the upload limits from `GET /api/v1/files/limits` when the page loads, so its size check, expiry choices and texts follow the server's configuration. If that request fails, it uses the defaults above, and the server still enforces its own limits.

## 🔐 Encrypted Downloads
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

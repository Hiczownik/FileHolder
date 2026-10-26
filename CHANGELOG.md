# Changelog

Releases from 0.9.0 on are written by [release-please](https://github.com/googleapis/release-please) from the
commit messages (README, *Versions and Releases*). 1.0.0 will be the first public deployment.

## 0.9.0 (2026-10-26)

The first numbered release: everything up to here, summed up. The full story is in the merged pull requests and
the [commit history](https://github.com/Hiczownik/FileHolder/commits/v0.9.0).

### Features

* **Self-destructing bundles:** up to 50 files shared as one link that expires after a set time or number of
  downloads, uploaded straight to S3-compatible storage with presigned (multipart) URLs, and downloaded per file or as
  a ZIP streamed on the fly.
* **End-to-end encryption in the browser:** chunked AES-GCM, streamed in both directions so file size doesn't depend
  on memory; the key travels in the link's fragment (#61), optionally with a passkey stretched with Argon2id (#78).
* **Privacy by default:** photo metadata removed before upload (#62); titles of encrypted bundles encrypted too (#65);
  purged bundles reduced to tombstones (#77).
* **Safety nets:** a purge worker plus a storage lifecycle rule so no file outlives its limits (#69), rate limits and
  a password lockout, upload limits and a global storage quota (#148).
* **Operations:** health checks (#80), Prometheus metrics, OpenTelemetry traces in Tempo with redaction (#72),
  security headers on the API and the UI (#130), Cloudflare R2 support (#151).
* **Owner's controls:** maintenance modes, takedown and abuse reports (#155, #156, #157); the build version
  everywhere (#158).
* **UI:** a redesigned, calm interface with light and dark themes (#126), a QR code for the share link, and
  progress for encrypted downloads.

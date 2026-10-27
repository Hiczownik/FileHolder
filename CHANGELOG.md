# Changelog

Releases from 0.9.0 on are written by [release-please](https://github.com/googleapis/release-please) from the
commit messages (README, *Versions and Releases*). 1.0.0 will be the first public deployment.

## [1.0.0](https://github.com/Hiczownik/FileHolder/compare/v0.9.0...v1.0.0) (2026-10-27)


### Features

* a public sample bundle at /sample, kept alive by a keeper service ([#82](https://github.com/Hiczownik/FileHolder/issues/82)) ([3233e78](https://github.com/Hiczownik/FileHolder/commit/3233e7875feebee33c5a0664f7e9997459bffb62))
* a public sample bundle at /sample, kept alive by a keeper service ([#82](https://github.com/Hiczownik/FileHolder/issues/82)) ([589bdcd](https://github.com/Hiczownik/FileHolder/commit/589bdcddb070914eee80839338b48c6231d4d296))
* **api:** tiered access codes: small limits without a code, the full ones with one ([#169](https://github.com/Hiczownik/FileHolder/issues/169)) ([e53b2ed](https://github.com/Hiczownik/FileHolder/commit/e53b2ed14a7b07b6afd0e8a337e3a9a1f70eb1b6))
* **api:** tiered access codes: small limits without a code, the full ones with one ([#169](https://github.com/Hiczownik/FileHolder/issues/169)) ([31aba0a](https://github.com/Hiczownik/FileHolder/commit/31aba0a0efcd0701ee08618538ce31c0ec7f6ba9))
* Caddy and the production compose setup, hardened, with a local test mode ([6294cff](https://github.com/Hiczownik/FileHolder/commit/6294cff40d2b7470a1de1a9dfb29e3a54322e9e7))
* Caddy and the production compose setup, hardened, with a local test mode ([9e501c1](https://github.com/Hiczownik/FileHolder/commit/9e501c1adfb234810578e1411f2de767397d092d))
* **deploy:** scripts/deploy.ps1, build here and deploy over SSH with automatic rollback ([9e2fae3](https://github.com/Hiczownik/FileHolder/commit/9e2fae3036f626ccb997316cdb2b3fc154a099e8))
* **deploy:** scripts/deploy.ps1, build here and deploy over SSH with automatic rollback ([53c8d4a](https://github.com/Hiczownik/FileHolder/commit/53c8d4ae143bb3fae66afa8e8878ead0f6f9c4d2))
* **sample:** add the sample bundle's photo ([#82](https://github.com/Hiczownik/FileHolder/issues/82)) ([2372cf8](https://github.com/Hiczownik/FileHolder/commit/2372cf847cd38addd00a6ec0e4f84b29290bd88d))
* **sample:** add the sample bundle's photo ([#82](https://github.com/Hiczownik/FileHolder/issues/82)) ([c1fc2e1](https://github.com/Hiczownik/FileHolder/commit/c1fc2e1b38fd0371efca11f12fd208f946e3edf0))
* scripts/pre-deploy-check.ps1; HTTP/2 off in Caddy and Postgres's gosu findings accepted ([72022c0](https://github.com/Hiczownik/FileHolder/commit/72022c0f2317421afa51d65d8a533ab6ba4d7fd3))
* scripts/pre-deploy-check.ps1; HTTP/2 off in Caddy and Postgres's gosu findings accepted ([b0e2d97](https://github.com/Hiczownik/FileHolder/commit/b0e2d97e9f223d5e693ad9952a4912e4d6eb8ac7))
* terms and privacy pages; FileHolder stores no IP addresses ([645c15a](https://github.com/Hiczownik/FileHolder/commit/645c15a7a7f5efabd2cf4739a01ffa9ef95bed39))
* terms and privacy pages; FileHolder stores no IP addresses ([7d7143e](https://github.com/Hiczownik/FileHolder/commit/7d7143e0c3794e8e0ac3ca753808dc413eeadfcc))
* trust a proxy in front of nginx, let deploys finish running downloads, fix Grafana start-up ([4ba83f2](https://github.com/Hiczownik/FileHolder/commit/4ba83f258664dfc9083bbd6231b70dccdc31b523))
* trust a proxy in front of nginx, let deploys finish running downloads, fix Grafana start-up ([d21c0e2](https://github.com/Hiczownik/FileHolder/commit/d21c0e29c97048f22f1c7a691253358cddad0e6d))
* **ui:** access codes: personal link, code field and the limits a code unlocks ([#169](https://github.com/Hiczownik/FileHolder/issues/169)) ([332b18f](https://github.com/Hiczownik/FileHolder/commit/332b18f6055c3fe471ab6b5ea26aa8e0a902176d))
* **ui:** access codes: personal link, code field and the limits a code unlocks ([#169](https://github.com/Hiczownik/FileHolder/issues/169)) ([e625d24](https://github.com/Hiczownik/FileHolder/commit/e625d24bcf9c96ec9a5ada47daa4b9e9952cc004))


### Bug Fixes

* **api:** validation patterns end with \z, so a trailing newline is refused ([976c009](https://github.com/Hiczownik/FileHolder/commit/976c009897b891d8ba4b362a66fcca84d022af5b))
* **api:** validation patterns end with \z, so a trailing newline is refused ([c7a0326](https://github.com/Hiczownik/FileHolder/commit/c7a0326126a0dee672b9d04c232344a595bf537f))
* findings of the pre-deploy check (UI image packages, two flaky e2e tests, zod) ([2e26631](https://github.com/Hiczownik/FileHolder/commit/2e26631db7c7bcb53292d8f744fb363d7840cb49))
* findings of the pre-deploy check (UI image packages, two flaky e2e tests, zod) ([fb0782b](https://github.com/Hiczownik/FileHolder/commit/fb0782b1bc74ae387a818dcbfe4f8131f988db72))
* **scripts:** build the sample image for its scan when the browser tests run ([#82](https://github.com/Hiczownik/FileHolder/issues/82)) ([7e06a48](https://github.com/Hiczownik/FileHolder/commit/7e06a4839fb9d7bbf1bd17dc4378b56f558ebb92))
* **scripts:** build the sample image for its scan when the browser tests run ([#82](https://github.com/Hiczownik/FileHolder/issues/82)) ([396c982](https://github.com/Hiczownik/FileHolder/commit/396c9823805f16c5d15fb67d9791e33ab7516d41))
* **ui:** send a Permissions-Policy on the UI pages ([245674e](https://github.com/Hiczownik/FileHolder/commit/245674ecaecc844f296320f5dd06676d0a394073))
* **ui:** send a Permissions-Policy on the UI pages ([9300c90](https://github.com/Hiczownik/FileHolder/commit/9300c903141ce0873f4f69adf32fc4f636ccf682))


### Documentation

* a README for strangers, with the details moved to docs/ ([#82](https://github.com/Hiczownik/FileHolder/issues/82)) ([e317d7f](https://github.com/Hiczownik/FileHolder/commit/e317d7f9929c5a8017ca151ec63d2d57d771e1c6))
* a README for strangers, with the details moved to docs/ ([#82](https://github.com/Hiczownik/FileHolder/issues/82)) ([3efbbc8](https://github.com/Hiczownik/FileHolder/commit/3efbbc8d2d6d3bfde9eb6897c76ff553f84240a3))
* **threat-model:** the trusted chain for client addresses ([fd520fd](https://github.com/Hiczownik/FileHolder/commit/fd520fd42e0af0d60b14fdeebff73419f19fb07f))

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

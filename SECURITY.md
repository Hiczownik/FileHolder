# Security policy

## Reporting a vulnerability

**Please don't report vulnerabilities in public issues, pull requests or discussions.**

Email **security@fileholder.app** with "FileHolder security" in the subject. Please include:

- what you found, and what an attacker could do with it;
- steps to reproduce it (requests, files or a short script);
- the commit or date of `main` you tested;
- whether you'd like to be credited, and under what name.

## What to expect

FileHolder is a personal project, so responses are **best effort**. I aim to:

- acknowledge a report within a week;
- share an assessment and a plan once I've reproduced it;
- credit you in the fix, unless you'd rather not be named.

Please give a reasonable time to fix the issue before disclosing it.

## Scope

**In scope:** the code in this repository on `main`: the API, the web UI, the encryption format, and the compose and CI configuration.

**Out of scope:**

- **Plain HTTP in the local stack**, while FileHolder isn't deployed. HTTPS (Caddy) is tracked as a deployment blocker in #82.
- **Gaps already listed** in [`docs/threat-model.md`](docs/threat-model.md) §5, and the accepted risks in §6. A new way to exploit one of them is still welcome.
- Problems in third-party services or dependencies with no FileHolder-specific impact. Please report those upstream.
- Denial of service by sheer volume of traffic.

## How FileHolder is meant to be secure

[`docs/threat-model.md`](docs/threat-model.md) describes what is protected, from whom, and how, along with the known gaps and the risks accepted on purpose.

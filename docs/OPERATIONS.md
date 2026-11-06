# Operations

## Network boundary

Run exactly **one process/replica** per data directory, and use each sender number with only this gateway session. Do not share its session directory with the WhatsApp AI Bot or another installation. SQLite quotas are durable for this installation, not a cross-installation abuse control.

The application has no public registration or arbitrary message-send route. First-run owner setup requires the private `SETUP_TOKEN`. Admin sessions expire after eight hours. `/docs/` and `/openapi.json` require owner login. Application requests use separately revocable bearer API keys.

Compose listens on host loopback only. Use a TLS reverse proxy such as Caddy/nginx for remote access. Set the exact external origin in `PUBLIC_URL`; dashboard mutations otherwise fail with `ORIGIN_REJECTED`. Only local development origins can use plain HTTP. No CORS wildcard, insecure remote HTTP or subpath deployment is supported.

`TRUST_PROXY=false` is the default. Arbitrary `X-Forwarded-For` cannot evade IP limits. If a trusted proxy reaches Node from **loopback**, `TRUST_PROXY=loopback` allows that proxy's forwarding headers. A Docker bridge proxy is not loopback; in that configuration clients may share a single IP bucket. Do not enable broad proxy trust to make limits disappear. Apply edge request/body/connection limits, correct client-IP handling and TLS at your ingress. Do not expose Node directly around the trusted proxy.

## Configuration

| Variable | Default | Allowed range / meaning |
| --- | --- | --- |
| `SETUP_TOKEN` | required | Unique random secret, at least 32 characters; first-owner setup only |
| `PUBLIC_URL` | `http://localhost:3000` | Exact external origin; HTTPS except local development |
| `PORT` | 3000 | 1–65535; Compose pins container port to 3000 |
| `HOST` | `0.0.0.0` | Bind interface; Compose pins this inside its loopback-published container |
| `DATA_DIR` | `.data` | Private persistent store; Compose uses `/app/.data` |
| `MAX_DEVICES` | 5 | 1–20 sending numbers |
| `OTP_TTL_SECONDS` | 300 | 60–600 |
| `OTP_MAX_ATTEMPTS` | 5 | 1–10 |
| `OTP_COOLDOWN_SECONDS` | 60 | 30–3600, global per recipient |
| `OTP_APP_PER_MINUTE` | 10 | 1–100 reserved sends per application |
| `OTP_APP_PER_DAY` | 100 | 1–10000 reserved sends per application per 24h window |
| `OTP_RECIPIENT_PER_HOUR` | 5 | 1–20, global per recipient |
| `OTP_IP_PER_MINUTE` | 20 | 1–100 OTP request calls per observed client IP |
| `OTP_DEVICE_PER_MINUTE` | 10 | 1–60 reserved sends per sending number |
| `TRUST_PROXY` | false | Only `loopback` opts into trusted proxy handling |

Counters use fixed windows anchored at the first request, not calendar-day quotas or a perfect rolling window. Requests near a reset boundary can burst. Login/setup/password-change endpoints have additional throttles; all `/api/*` and `/v1/*` calls share a 120/minute observed-IP guard. A reserved send consumes quota even if transport later becomes uncertain. Exceeding a limit returns `429` plus `Retry-After`. Dashboard settings are read-only reflections of host configuration; edit `.env` and restart to change them.

There can be 20 active API keys. Create a replacement, update the application securely, then revoke the old key. Keys can access all configured sender numbers in this **single-owner** installation; there are no tenant/device-level scopes.

## Storage, backup and upgrades

Persist the **whole** private data directory/volume:

- `gateway.sqlite` plus any SQLite WAL/SHM files: owner hash, sessions, device registrations, API-key hashes, OTP HMACs and short-lived request metadata.
- `hmac.key`: cryptographic verifier key. Losing or replacing it invalidates pending OTPs.
- `auth/<device UUID>/`: linked-device WhatsApp credentials and cryptographic key state.

The app sets restrictive directory/file permissions. This is not application-level encryption: the host operator and a compromised host can access the data. Use encrypted storage, encrypted private backups and appropriate host access controls. Filesystem deletion does not guarantee removal from database free pages, WAL, snapshots or backups.

Before an upgrade: stop ingress/new requests, stop the container cleanly (Compose allows 40s), take a consistent encrypted backup of the entire volume, then rebuild/start one instance. Never copy a live SQLite database file alone or run two restored copies of a WhatsApp session. Do not use `docker compose down -v` unless you deliberately intend to erase all state. Test restoration privately; backups themselves grant session access.

This release creates the initial schema on startup. It does not promise automatic future schema upgrades. Read future release notes before deploying a new version.

Session reconnection is best effort. Codes waiting in memory are not queued for retry: a challenge still marked `sending` at startup is made `delivery_unknown`. Its code may already have reached the phone. No new message is sent automatically. Pending code verifiers and durable attempt/limit counters survive restart; already-expired verifiers are cleared at startup/minute cleanup.

## Number lifecycle

Use the same phone number for registration and pairing. The adapter checks the linked account identity; a mismatch is logged out locally and the UI reports the mismatch. Remove/re-add to start again. Sessions revoked on the phone, replaced elsewhere or rejected by WhatsApp require re-pairing.

QR/pairing codes are private credentials, returned only to the authenticated owner with `no-store`. Do not publish dashboard screenshots containing them. Removing a device attempts logout, ends the socket and removes its local auth directory. If the network was unavailable, manually unlink the gateway on the phone as well. Historical requests can remain visible until retention cleanup even after a device is removed.

## Owner-operated real WhatsApp smoke test (not automated)

1. Use an isolated installation and a spare number. Do not reuse the AI Bot's session or primary account.
2. Add the sender, pair from its phone and confirm the actual account matches and the dashboard becomes `connected`.
3. Request one code to a consenting test recipient. Independently inspect the recipient phone; HTTP `202`/`accepted` alone is not delivery proof.
4. Verify that exact code once, then confirm reuse is rejected. Do not publish the code or recipient number.
5. Confirm resend cooldown and wrong-attempt lockout using a small, controlled number of requests. Avoid unnecessary repeated WhatsApp sends.
6. Restart the gateway without erasing its volume. Verify owner access/session reconnection. Never replay an uncertain in-flight send.
7. Revoke the test API key; verify further calls are rejected. Remove the test linked device when finished.

Record only non-sensitive pass/fail observations, not OTP values, full phone numbers, pairing details or WhatsApp session files. No live transport test, ban resistance or production uptime follows from automated checks.

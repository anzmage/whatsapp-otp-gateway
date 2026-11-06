# Security model and limitations

## Protections

- One owner, setup-token-gated registration. No public multi-tenant signup.
- Salted scrypt password hashing, persistent hashed random session tokens, HttpOnly/SameSite=Strict cookies (Secure on HTTPS), eight-hour expiry and origin enforcement on dashboard writes.
- Random 256-bit bearer API keys, hashed at rest, revocable, shown once. Admin-cookie authentication cannot authorize `/v1/*`; application keys cannot read the admin APIs.
- Six-digit codes from `crypto.randomInt`, never caller-chosen. HMAC-SHA256 keyed with a separately stored random secret binds each verifier to its request ID. A database-only leak does not permit offline brute-forcing the million-code space without the HMAC secret. A whole-volume/host compromise still exposes that secret.
- `BEGIN IMMEDIATE` transactions reserve requests and atomically consume/lock codes. Verification attempts persist. A new request supersedes older active codes for that app/recipient. One app cannot inspect/verify another app's requests.
- Durable idempotency plus no automatic send retries. Ambiguous acknowledgements and interrupted sends stay visibly uncertain.
- Recipient cooldown, app/device/recipient/IP quotas and login throttles. Rate-limit identifiers for recipients and IPs are HMAC-protected.
- Strict bounded JSON schemas, 8 KiB request bodies, no caller-supplied text/template/URLs, no CORS wildcard, CSP, anti-framing, no-store and noindex headers. UI renders labels/data as text, not HTML.
- No request-body logging or Baileys debug logs; no raw keys/codes in activity responses or browser storage.
- The owner dashboard has a strict self-only script/style CSP. Swagger retains self/hash-restricted scripts but allows inline CSS only on its own routes because the interactive authorization/response UI injects styles. External validators are disabled.

## Residual risks / not implemented

- **Unofficial transport**: WhatsApp can disconnect, change behavior or ban the number. No delivery/SLA guarantee, official API integration, retry queue or SMS/email fallback is implemented.
- Possession of a WhatsApp account is not phishing-resistant authentication. SIM/account takeover, linked-device compromise and malicious clients remain possible. Do not use this alone for high-risk access or financial transactions.
- Recipient permission is the integrator's responsibility. `consent=true` is only an assertion. A stolen application key can spend that key's quota and send codes to numbers the attacker supplies. Put keys only on trusted servers; add app-specific bot protection and recipient abuse controls.
- The integrating app must bind a request ID to its own user/session, recipient and intended action. A gateway `verified=true` response alone does not create a secure login flow or prove a person's legal identity.
- **Single owner/process only**: no multi-tenant isolation, key-level device scopes, HA, distributed locks, global multi-installation quota, WAF or production load certification. Do not run multiple replicas or two session writers on one sender.
- Phone numbers are masked in UI/API, but full recipient numbers exist in short-lived database metadata (approximately 24h). Sender account details, owner email, credentials and hashes persist. Deleted SQLite data can remain in WAL/free pages/backups. Storage is not encrypted by the app. Secure host disks/backups and define your retention obligations.
- Whole-host compromise exposes sessions, signing material and message access. Session credentials grant access to a linked WhatsApp account. Disk permissions are not a substitute for host hardening.
- Process health is not WhatsApp health. Missing read/delivery receipts are inconclusive. Errors after a send may mean the message arrived, so never assume automatic retry is safe.
- Login throttles deliberately favor safety and can be used for temporary denial of service. Proxy/IP configuration and edge DDoS controls need deployment-specific review.
- Password change revokes sessions but not application keys. Revoke keys separately after an incident. There is no email-based password recovery, MFA, role system, or automated backup facility in this release.
- Tests and a clean dependency audit are not a security certification, provider-policy approval or legal-compliance claim.

Report vulnerabilities privately through GitHub's security reporting facilities when available. Never post session files, API keys, OTP values, full recipient numbers or private logs in public issues.

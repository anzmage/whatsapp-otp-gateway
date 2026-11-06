# WhatsApp OTP Gateway

A self-hosted, single-owner WhatsApp OTP gateway by **ZaidanLab**. Includes an admin dashboard, multiple sending numbers, real Baileys pairing/sending, API keys, one-time code verification and interactive OpenAPI documentation.

**Status: functional experimental MVP.** Automated tests use a fake WhatsApp transport. Real-number pairing, WhatsApp delivery and recovery against the live service still require an owner-operated smoke test. This is not a production authentication SLA or a guaranteed delivery service.

> Baileys is an unofficial WhatsApp Web library, not the WhatsApp Business Platform. Automation can violate WhatsApp's terms and the number may be banned. Use a spare number and only send codes the recipient requested. Do not use this as the only login/recovery channel for important services. For supported production messaging, use the official WhatsApp Business Platform with authentication templates and follow Meta's current requirements.

## Included

- First-run **owner registration** protected by an installation setup token; no public multi-tenant signup.
- Password login, expiring server-side sessions, origin checks and password rotation that revokes all sessions.
- Add existing WhatsApp numbers, activate with **QR or pairing code**, reconnect, remove and view session status.
- Create/revoke API keys; plaintext keys are shown once, never returned in listings.
- Real request, status and verify endpoints with cryptographic six-digit codes and HMAC-only verifier storage.
- Atomic single-use verification, attempt lockouts, expiry, supersession and recipient resend cooldown.
- Persistent per-application, per-device, per-recipient and per-IP limits.
- Durable idempotency, explicit uncertain-send state, and no automatic OTP retries.
- Best-effort WhatsApp delivery/read receipts, clearly separated from send acknowledgement.
- Owner-only **Swagger UI at `/docs/`**, OpenAPI 3.1 at `/openapi.json`.
- Responsive English UI, integration playground and recent activity with masked numbers and no OTP values.
- Docker Compose, SQLite persistence and a non-root container.

Adding a number registers it with **this gateway**, not with WhatsApp. The WhatsApp account must already exist. Sender sessions are separate from the ZaidanLab WhatsApp AI Bot.

## Quick start — Docker

```sh
cp .env.example .env
# Edit .env: replace SETUP_TOKEN with a unique value from: openssl rand -hex 32
# Keep that token private; you will enter it in the first-run dashboard.
docker compose up -d --build
```

Open **http://localhost:3000**. Register the owner using `SETUP_TOKEN`, then sign in.

1. Add your existing **spare** WhatsApp number in E.164 format, e.g. `+6281234567890`.
2. Choose **Pair QR** or **Pair code**. On the registered phone, open WhatsApp → Linked devices → Link a device. For a code, select “Link with phone number instead”.
3. Wait for **connected**. The actual linked account must match the registered sender number.
4. Create an API key for your application. Save it immediately; it will not be displayed again.
5. Copy the sending device ID. Open `/docs/`, click **Authorize**, and paste the key.
6. Test with your own consenting recipient. **Try it out and the dashboard playground send real messages.**

The provided `.env.example` placeholder token is rejected. Both owner setup and login require `PUBLIC_URL` to match the browser's exact origin. Use `localhost:3000` consistently rather than switching to `127.0.0.1`.

## Local Node.js

Requires **Node.js 22.13+ within Node 22** (uses `node:sqlite`; Node may emit an experimental SQLite warning).

```sh
npm ci
cp .env.example .env
# Configure a unique SETUP_TOKEN.
npm start
```

`npm run dev` enables Node's watcher. No LLM, Cloudflare account or paid API credential is needed for the Baileys adapter.

## API

All `/v1/*` endpoints require `Authorization: Bearer wotp_…`. Keys belong on your **application server**, never in public browser/mobile code. The dashboard playground is an operator-only diagnostic exception: its key is held only in that page's memory, not local/session storage.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/devices` | List configured sending numbers and current status |
| POST | `/v1/otp/request` | Create a code and send a real WhatsApp message |
| GET | `/v1/otp/{requestId}` | Inspect verification and best-effort delivery status |
| POST | `/v1/otp/verify` | Verify and atomically consume a code |

Full schemas, error codes, security and descriptions are served in Swagger from the same route definitions used for validation. Sign into the dashboard before opening `/docs/` or downloading `/openapi.json`; the downloaded spec can be imported into Postman.

```sh
# Set OTP_API_KEY and DEVICE_ID securely on your application server.
# Use a NEW idempotency key per logical OTP request; retain it for timeout retries.
curl http://localhost:3000/v1/otp/request \
  -H "Authorization: Bearer $OTP_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 79bbf712-d601-4b36-984a-6886414dcbb7' \
  -d "{\"deviceId\":\"$DEVICE_ID\",\"phone\":\"+6281234567890\",\"consent\":true}"
```

Example response (IDs are illustrative):

```json
{
  "requestId": "c7723f42-373c-4865-998a-45b41089ece7",
  "deviceId": "76341cab-9996-4ac5-9a69-af02fb6b127d",
  "recipient": "+62••••••7890",
  "state": "active",
  "delivery": "accepted",
  "expiresAt": "2026-11-05T12:05:00.000Z",
  "attemptsRemaining": 5
}
```

```sh
curl http://localhost:3000/v1/otp/verify \
  -H "Authorization: Bearer $OTP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"c7723f42-373c-4865-998a-45b41089ece7","code":"123456"}'
```

Successful verification returns `{"verified":true,"requestId":"…"}` and removes the verifier. The same code cannot be consumed twice. Bind the gateway's `requestId` on your own server to the correct user/session, recipient and intended action. **Never accept a client-selected request ID as proof for an arbitrary account.** This gateway does not issue your application's login/access tokens.

### Delivery, timeout and retry semantics

- **sending**: durably reserved; waiting on the transport.
- **accepted**: Baileys returned a message ID. Not evidence that the recipient received it.
- **delivered / read**: a matching best-effort WhatsApp receipt was observed. Receipts may be absent or missed; not an SLA.
- **delivery_unknown**: send failed or timed out without conclusive acknowledgement, or the server restarted during send. The message **may still arrive**. Never blindly retry it. Verification still works if the correct code arrives before expiry.
- **failed**: the device became unavailable before sending. The challenge is unusable.

Reuse the **same** `Idempotency-Key` with the same body after an HTTP/network timeout. It returns the existing request, without sending again. Different request data with the same key is a conflict. Idempotency records are retained for approximately **24 hours**, not forever. Do not retry an old logical request after that window. A new OTP supersedes prior active codes for the same application and recipient.

`consent=true` is the caller's attestation, not independently verified consent. The integrator must implement recipient permission, anti-abuse controls and any applicable policy requirements.

## Deployment & data

See [docs/OPERATIONS.md](docs/OPERATIONS.md) and [docs/SECURITY.md](docs/SECURITY.md). A [native systemd deployment template](deploy/systemd/README.md) is also available for shared Linux servers, with a dedicated user/runtime, resource caps and SSH-tunnel-only initial access; Docker is optional. Provider risks are documented here rather than repeated as dashboard banners.

- One owner, **one process/replica**, one SQLite store and one writer per WhatsApp number. Multi-tenant SaaS, billing, HA and distributed queues are not implemented.
- Compose binds only `127.0.0.1:3000`. For remote access put an HTTPS reverse proxy in front and set `PUBLIC_URL=https://your-host.example`. No subpath hosting.
- `gateway-data` contains the database, HMAC key and WhatsApp sessions. Keep the entire volume private and persistent; it is **not encrypted by this app**. Use encrypted disks/backups as appropriate.
- Gateway OTP metadata, including full recipient numbers, is retained for up to approximately 24h; the dashboard/API mask them. Expired verifier material is cleared at least every minute. Owner details, device registrations, API-key hashes and session credentials persist until removed. Revoked key records remain.
- Removing a number attempts remote logout and deletes the local session. If remote logout cannot be confirmed, manually remove the linked device from the phone.
- Existing sessions reconnect on restart, subject to WhatsApp's behavior. Restored sending attempts are never replayed automatically.
- The default HTTP access logger is disabled; raw request bodies, OTP values, credentials, recipient numbers, pairing data and Baileys debug logs are not logged. Your reverse proxy must follow the same policy.
- `/health` is process health, **not** proof that any WhatsApp number is connected or a message can be delivered.

## Tests

```sh
npm ci
npm run check
npm test
npm audit --omit=dev
# Optional isolated container smoke test; uses synthetic data and deletes its own volume:
docker build -t whatsapp-otp-gateway:dev .
npm run test:docker
# Use installed Chrome, or install the Playwright Chromium runtime first:
npx playwright install chromium
npm run test:browser
# Optional: CHROME_PATH=/path/to/chrome npm run test:browser
```

Node tests cover auth/origin protection, key isolation/revocation, password rotation, limits, durable HMAC storage, expiry, single use, idempotency/concurrency, uncertain ACKs and OpenAPI. The real-browser workflow runs the real HTTP API/UI against a **fake transport**, including owner registration, pairing UI, key issuance, request/verify, and Swagger authorization / Try it out at mobile/desktop widths. The Docker smoke checks a non-root, read-only container plus owner/session/API-key persistence across restart, without configuring any WhatsApp number. Tests do **not** connect to WhatsApp or prove actual delivery, ban resistance, production scalability or legal compliance.

No live credential, WhatsApp session, recipient data or OTP log should ever be committed. License: [MIT](LICENSE).

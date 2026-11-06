# WhatsApp OTP Gateway

An experimental ZaidanLab portfolio project for a WhatsApp OTP API gateway.

**Status:** planning / initial repository setup. No gateway or working OTP delivery is implemented yet.

## Planned MVP

- Node.js API with application API-key authentication.
- Request and verify OTP endpoints.
- A Baileys provider adapter, separate from the WhatsApp AI Bot process and session.
- Cryptographically generated codes, HMAC-protected storage, expiration and single-use verification.
- Attempt limits, resend cooldowns and rate limits per application, recipient and IP.
- Connection status and delivery-event visibility without logging OTP values or credentials.
- A sample integration and API documentation.

## Boundaries

Baileys is an unofficial WhatsApp Web library. Connections can fail and numbers may be blocked. This project is intended as an experimental showcase, not a production authentication service or an availability guarantee. Only send codes requested by the recipient; no unsolicited messaging or public unauthenticated sending endpoint.

A successful send call does not prove delivery. A production provider adapter should use the official WhatsApp Business Platform authentication templates and follow the provider's current requirements.

Never commit credentials, WhatsApp session files, OTP values, recipient data or delivery logs.

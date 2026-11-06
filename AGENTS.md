# WhatsApp OTP Gateway

Read README.md, docs/SECURITY.md and docs/OPERATIONS.md before changing behavior.

- Conversation: Bahasa Indonesia. Public UI/docs: English. Company: ZaidanLab; never publish operator/client identities.
- Independent repo from ../Zlab and ../whatsapp-mcp. Never reuse their WhatsApp auth state or change their remotes/deployments.
- One owner, one process/replica, persistent SQLite; no public signup or unrestricted message-send endpoint.
- Production entrypoint always uses the real Baileys adapter. Fake transports exist only in tests and the loopback browser fixture. Never claim those tests prove live WhatsApp pairing or delivery.
- Do not start a live WhatsApp session or send real messages without owner-directed testing. Do not read/print .env, database contents, session credentials, phone numbers, OTP codes or pairing details from live/private storage.
- OTPs: crypto RNG, keyed HMAC only, TTL/attempt limits/single use, per-key isolation, cooldown, durable quotas/idempotency. Never retry an uncertain send automatically. accepted != delivered.
- API keys are server-side secrets, shown once, hashed at rest. Dashboard writes require exact-origin checks and owner sessions. Protect docs and spec downloads. Never add wildcard CORS or broad proxy trust.
- Check git status and HEAD before editing. Preserve existing work. Stage explicit intended paths, never git add -A.
- Validate: npm run check; npm test; npm run test:browser; npm audit --omit=dev; git diff --check. Docker build/smoke when available. No external project browsers/tools required.
- Never publish generated screenshots with real OTP values, full phone numbers, keys or pairing information. test-results/ stays ignored.
- Zlab portfolio publication is separate work. Do not add a live demo claim or sitemap entry for a gateway that is not publicly deployed.

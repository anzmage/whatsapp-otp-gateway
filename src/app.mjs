import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import staticFiles from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openStore } from './db.mjs';
import { WhatsApp } from './whatsapp.mjs';
import { createOtp } from './otp.mjs';
import { HttpError, canonicalPhone, equal, hash, mac, passwordHash, passwordMatches, token, maskPhone } from './security.mjs';
import { object, text, uuid, phone, idParams, errors, challenge } from './schemas.mjs';

export async function createApp({ config, store = openStore(config.dataDir), adapter, logger = true } = {}) {
  const app = Fastify({
    logger, logController: new LogController({ disableRequestLogging: true }), trustProxy: config.trustProxy,
    bodyLimit: 8192, requestTimeout: 35_000, connectionTimeout: 40_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const whatsapp = adapter || new WhatsApp({ config, store, logger: app.log });
  const otp = createOtp({ store, config, whatsapp });
  app.decorate('store', store);
  app.decorate('whatsapp', whatsapp);
  const sessionOptions = { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookie, maxAge: 8 * 3600 };
  const hidden = { hide: true };
  const admin = async (request) => {
    const raw = request.cookies['wotp-session'];
    if (!raw || !store.get('SELECT hash FROM sessions WHERE hash=? AND expires>?', hash(raw), Date.now())) throw new HttpError(401, 'UNAUTHORIZED', 'Log in to the dashboard first.');
  };
  const apiAuth = async (request) => {
    const raw = request.headers.authorization?.match(/^Bearer (wotp_[a-f0-9]{64})$/)?.[1];
    const key = raw && store.get('SELECT id FROM api_keys WHERE hash=? AND revoked IS NULL', hash(raw));
    if (!key) throw new HttpError(401, 'INVALID_API_KEY', 'Provide a valid API key as Authorization: Bearer <key>.');
    request.apiKeyId = key.id;
  };
  const ipBucket = (request) => mac(store.secret, request.ip);
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
      baseUri: ["'none'"], formAction: ["'self'"], upgradeInsecureRequests: config.secureCookie ? [] : null,
    } },
    referrerPolicy: { policy: 'no-referrer' },
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    const path = request.routeOptions.url || request.url.split('?')[0];
    if (path === '/docs' || path.startsWith('/docs/') || path === '/openapi.json') await admin(request);
    if (path.startsWith('/api/') || path.startsWith('/v1/')) {
      store.limit(`http:${ipBucket(request)}`, 120, 60_000);
    }
    if (!path.startsWith('/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers.origin !== config.origin) throw new HttpError(403, 'ORIGIN_REJECTED', 'Dashboard mutations require the configured PUBLIC_URL origin.');
    }
  });
  app.setErrorHandler((err, request, reply) => {
    const status = err.validation ? 400 : (err.statusCode >= 400 && err.statusCode <= 599 ? err.statusCode : 500);
    if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter));
    if (status >= 500) app.log.error({ code: err.code || 'INTERNAL_ERROR' }, 'Request failed');
    return reply.code(status).send({
      error: err.validation ? 'VALIDATION_ERROR' : (err instanceof HttpError ? err.code : status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED'),
      message: err.validation ? 'Request does not match the documented schema.' : err instanceof HttpError ? err.message : status === 500 ? 'An internal error occurred.' : 'Request rejected.',
    });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'NOT_FOUND', message: 'Endpoint not found.' }));
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'WhatsApp OTP Gateway', version: '0.1.0',
        description: 'Self-hosted WhatsApp OTP gateway. Try it out performs REAL operations and can send WhatsApp messages. Use only recipient-requested codes. API keys belong on your application server, never in browser/mobile bundles. Request metadata/idempotency is retained for 24 hours; reuse an Idempotency-Key within that period to avoid duplicate sends. Send acknowledgement is distinct from delivery. Unknown acknowledgements are never automatically retried. See the project README for deployment considerations and provider risks.',
      },
      servers: [{ url: config.origin }],
      tags: [{ name: 'OTP', description: 'Request, inspect and verify real one-time codes.' }, { name: 'Devices', description: 'Connected sending numbers configured by the owner.' }],
      components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'wotp_...', description: 'Create a key in the dashboard. Paste the entire wotp_… value.' } } },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs', staticCSP: true,
    // Swagger's interactive authorization/response UI injects styles. Only docs allow inline CSS;
    // scripts stay self/hash-restricted, and the admin dashboard keeps its strict CSP.
    transformStaticCSP: (header) => header
      .replace('upgrade-insecure-requests;', config.secureCookie ? 'upgrade-insecure-requests;' : '')
      .replace("frame-ancestors 'self'", "frame-ancestors 'none'")
      .replace(/style-src [^;]+;/, "style-src 'self' 'unsafe-inline';")
      .replace('font-src \'self\' https: data:', 'font-src \'self\' data:')
      .replace('validator.swagger.io', ''),
    uiConfig: { docExpansion: 'list', persistAuthorization: false, validatorUrl: null, supportedSubmitMethods: ['get', 'post'] },
    uiHooks: { onRequest: admin },
  });
  app.get('/openapi.json', { schema: hidden, onRequest: admin }, async () => app.swagger());
  app.get('/health', { schema: hidden }, async () => ({ status: 'ok', version: '0.1.0', experimental: true }));
  app.get('/api/bootstrap', { schema: hidden }, async (request) => ({
    setupRequired: !store.get('SELECT id FROM owners WHERE id=1'),
    authenticated: !!(request.cookies['wotp-session'] && store.get('SELECT hash FROM sessions WHERE hash=? AND expires>?', hash(request.cookies['wotp-session']), Date.now())),
  }));
  app.post('/api/setup', { schema: { ...hidden, body: object({ email: { type: 'string', format: 'email', maxLength: 254 }, password: text(128, 12), setupToken: text(256, 32) }) } }, async (request, reply) => {
    store.limit(`setup:${ipBucket(request)}`, 5, 15 * 60_000);
    if (store.get('SELECT id FROM owners WHERE id=1')) throw new HttpError(409, 'ALREADY_CONFIGURED', 'An owner already exists.');
    if (!equal(request.body.setupToken, config.setupToken)) throw new HttpError(403, 'INVALID_SETUP_TOKEN', 'Setup token is incorrect.');
    const digest = await passwordHash(request.body.password);
    const result = store.run('INSERT OR IGNORE INTO owners(id,email,password) VALUES(1,?,?)', request.body.email.toLowerCase(), digest);
    if (!result.changes) throw new HttpError(409, 'ALREADY_CONFIGURED', 'An owner already exists.');
    reply.code(201);
    return { ok: true };
  });
  app.post('/api/login', { schema: { ...hidden, body: object({ email: text(254), password: text(128) }) } }, async (request, reply) => {
    store.limit(`login:${ipBucket(request)}`, 5, 15 * 60_000);
    // Installation-wide limit also slows distributed password guessing.
    store.limit('login-global', 30, 15 * 60_000);
    const owner = store.get('SELECT * FROM owners WHERE id=1');
    if (!owner || !(await passwordMatches(request.body.password, owner.password)) || owner.email !== request.body.email.toLowerCase()) throw new HttpError(401, 'LOGIN_FAILED', 'Incorrect email or password.');
    const raw = token();
    store.run('DELETE FROM sessions WHERE expires <= ?', Date.now());
    store.run('INSERT INTO sessions(hash,expires) VALUES(?,?)', hash(raw), Date.now() + 8 * 3600_000);
    reply.setCookie('wotp-session', raw, sessionOptions);
    return { ok: true };
  });
  app.post('/api/logout', { schema: hidden, preHandler: admin }, async (request, reply) => {
    store.run('DELETE FROM sessions WHERE hash=?', hash(request.cookies['wotp-session']));
    reply.clearCookie('wotp-session', sessionOptions);
    return { ok: true };
  });
  app.post('/api/admin/password', { schema: { ...hidden, body: object({ currentPassword: text(128), newPassword: text(128, 12) }) }, preHandler: admin }, async (request, reply) => {
    store.limit(`password:${ipBucket(request)}`, 5, 15 * 60_000);
    const owner = store.get('SELECT * FROM owners WHERE id=1');
    if (!(await passwordMatches(request.body.currentPassword, owner.password))) throw new HttpError(403, 'PASSWORD_REJECTED', 'Current password is incorrect.');
    const digest = await passwordHash(request.body.newPassword);
    store.transaction(() => {
      store.run('UPDATE owners SET password=? WHERE id=1', digest);
      store.run('DELETE FROM sessions');
    });
    reply.clearCookie('wotp-session', sessionOptions);
    return { ok: true };
  });
  app.get('/api/admin/overview', { schema: hidden, preHandler: admin }, async () => ({
    devices: store.all('SELECT * FROM devices ORDER BY created DESC').map((d) => whatsapp.view(d)),
    apiKeys: store.all('SELECT id,name,prefix,created,revoked FROM api_keys ORDER BY created DESC'),
    requests: store.all('SELECT * FROM challenges ORDER BY created DESC LIMIT 100').map(otp.view),
    settings: { otpTtlSeconds: config.ttl, maxAttempts: config.maxAttempts, resendCooldownSeconds: config.cooldown, appPerMinute: config.appPerMinute, appPerDay: config.appPerDay, recipientPerHour: config.recipientPerHour, devicePerMinute: config.devicePerMinute, metadataRetentionHours: 24 },
  }));
  app.post('/api/admin/devices', { schema: { ...hidden, body: object({ label: text(60), phone }) }, preHandler: admin }, async (request, reply) => {
    if (store.get('SELECT count(*) AS n FROM devices').n >= config.maxDevices) throw new HttpError(409, 'DEVICE_LIMIT', 'Maximum number of sending devices reached.');
    const digits = canonicalPhone(request.body.phone);
    if (store.get('SELECT id FROM devices WHERE phone=?', digits)) throw new HttpError(409, 'DEVICE_EXISTS', 'This number is already registered.');
    const device = { id: randomUUID(), label: request.body.label, phone: digits, created: Date.now() };
    store.run('INSERT INTO devices(id,label,phone,created) VALUES(?,?,?,?)', device.id, device.label, device.phone, device.created);
    return reply.code(201).send(whatsapp.view(device));
  });
  app.post('/api/admin/devices/:id/connect', { schema: { ...hidden, params: idParams, body: object({ mode: { type: 'string', enum: ['qr', 'code'] } }) }, preHandler: admin }, async (request) => {
    store.limit('connect-global', 10, 60_000);
    const device = store.get('SELECT * FROM devices WHERE id=?', request.params.id);
    if (!device) throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Sending number not found.');
    return whatsapp.connect(device, request.body.mode);
  });
  app.delete('/api/admin/devices/:id', { schema: { ...hidden, params: idParams }, preHandler: admin }, async (request) => {
    if (!store.get('SELECT id FROM devices WHERE id=?', request.params.id)) throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Sending number not found.');
    await whatsapp.remove(request.params.id);
    store.run('DELETE FROM devices WHERE id=?', request.params.id);
    return { ok: true };
  });
  app.post('/api/admin/keys', { schema: { ...hidden, body: object({ name: text(60) }) }, preHandler: admin }, async (request, reply) => {
    if (store.get('SELECT count(*) AS n FROM api_keys WHERE revoked IS NULL').n >= 20) throw new HttpError(409, 'KEY_LIMIT', 'Revoke unused keys before creating more.');
    const raw = `wotp_${token()}`;
    const id = randomUUID();
    store.run('INSERT INTO api_keys(id,name,hash,prefix,created) VALUES(?,?,?,?,?)', id, request.body.name, hash(raw), raw.slice(0, 13), Date.now());
    return reply.code(201).send({ id, key: raw, message: 'Save this key securely. It is shown only once.' });
  });
  app.delete('/api/admin/keys/:id', { schema: { ...hidden, params: idParams }, preHandler: admin }, async (request) => {
    store.run('UPDATE api_keys SET revoked=? WHERE id=? AND revoked IS NULL', Date.now(), request.params.id);
    return { ok: true };
  });
  const api = { preHandler: apiAuth };
  const security = [{ apiKey: [] }];
  app.get('/v1/devices', { ...api, schema: {
    tags: ['Devices'], summary: 'List sending numbers', security,
    response: { 200: { type: 'array', items: object({ id: uuid, label: text(60), phone: { type: 'string' }, status: { type: 'string' } }) }, ...errors },
  } }, async () => store.all('SELECT * FROM devices').map((d) => ({ id: d.id, label: d.label, phone: maskPhone(d.phone), status: whatsapp.view(d).status })));
  app.post('/v1/otp/request', { ...api, schema: {
    tags: ['OTP'], summary: 'Generate and send a real OTP', security,
    description: 'Sends a WhatsApp message. consent=true attests that the recipient requested the code; it is not independent proof of consent. Use one Idempotency-Key per logical request; reuse it on HTTP timeout to inspect the same request without resending. Cooldown and quotas apply across relevant recipients/devices. A delivery_unknown response may still reach the phone. Do not automatically resend. Accepted is not proof of delivery.',
    headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$', description: 'A fresh UUID is recommended. Retained for 24 hours.' } } },
    body: object({ deviceId: uuid, phone, consent: { type: 'boolean', const: true, description: 'Recipient explicitly requested this verification code.' } }),
    response: { 202: challenge, ...errors },
  } }, async (request, reply) => {
    store.limit(`otp-ip:${ipBucket(request)}`, config.ipPerMinute, 60_000);
    return reply.code(202).send(await otp.request(request.apiKeyId, request.body, request.headers['idempotency-key']));
  });
  app.post('/v1/otp/verify', { ...api, schema: {
    tags: ['OTP'], summary: 'Verify and consume a code', security,
    description: 'Successful verification consumes the code atomically. Incorrect attempts are persisted; reaching the maximum locks the code. Your application must bind requestId to its own user/session and intended action; verified=true is not a login token. Do not let the client choose an arbitrary requestId for another account.',
    body: object({ requestId: uuid, code: { type: 'string', pattern: '^\\d{6}$', description: 'Six-digit code supplied by the recipient.' } }),
    response: { 200: object({ verified: { type: 'boolean' }, requestId: uuid }), ...errors },
  } }, async (request) => {
    store.limit(`verify:${request.apiKeyId}`, 60, 60_000);
    return otp.verify(request.apiKeyId, request.body.requestId, request.body.code);
  });
  app.get('/v1/otp/:id', { ...api, schema: {
    tags: ['OTP'], summary: 'Inspect request and best-effort delivery status', security, params: idParams,
    response: { 200: challenge, ...errors },
  } }, async (request) => otp.status(request.apiKeyId, request.params.id));

  await app.register(staticFiles, { root: fileURLToPath(new URL('../public/', import.meta.url)), prefix: '/assets/', decorateReply: false, dotfiles: 'deny', index: false, list: false });
  const html = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
  app.get('/', { schema: hidden }, async (request, reply) => reply.type('text/html; charset=utf-8').send(html));
  store.cleanup();
  const cleanup = setInterval(() => store.cleanup(), 60_000);
  cleanup.unref();
  app.addHook('onClose', async () => {
    clearInterval(cleanup);
    await whatsapp.close();
    store.close();
  });
  await app.ready();
  return app;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { passwordHash, passwordMatches, equal, canonicalPhone } from '../src/security.mjs';
import { harness, credentials, setupToken } from './helpers.mjs';

const base = { SETUP_TOKEN: setupToken };
test('configuration rejects missing setup secret, insecure public origins and invalid limits', () => {
  for (const env of [{}, { ...base, PUBLIC_URL: 'http://gateway.example.com' }, { ...base, PUBLIC_URL: 'https://user:pass@gateway.example.com' }, { ...base, PUBLIC_URL: 'https://gateway.example.com/subpath' }, { ...base, OTP_TTL_SECONDS: '0' }, { ...base, OTP_MAX_ATTEMPTS: '999' }]) assert.throws(() => loadConfig(env));
  assert.equal(loadConfig({ ...base, PUBLIC_URL: 'https://gateway.example.com' }).secureCookie, true);
  assert.equal(loadConfig(base).trustProxy, false);
});
test('passwords use salted scrypt; comparisons and E.164 validation', async () => {
  const a = await passwordHash('a long test password'); const b = await passwordHash('a long test password');
  assert.notEqual(a, b); assert.equal(await passwordMatches('a long test password', a), true); assert.equal(await passwordMatches('wrong', a), false);
  assert.equal(equal('abc', 'abc'), true); assert.equal(equal('abc', 'abcd'), false);
  assert.equal(canonicalPhone('+628123451234'), '628123451234');
  for (const value of ['0812345', '+00012345678', '+62 8123451234', '628123451234']) assert.throws(() => canonicalPhone(value));
});
test('single-owner setup requires correct token and same origin', async (t) => {
  const h = await harness(t);
  assert.equal((await h.inject('GET', '/api/bootstrap')).json().setupRequired, true);
  assert.equal((await h.inject('POST', '/api/setup', { ...credentials, setupToken: 'x'.repeat(32) })).statusCode, 403);
  assert.equal((await h.inject('POST', '/api/setup', { ...credentials, setupToken }, { headers: { origin: 'https://evil.example' } })).statusCode, 403);
  await h.owner();
  assert.equal((await h.inject('GET', '/api/bootstrap')).json().setupRequired, false);
  assert.equal((await h.inject('POST', '/api/setup', { ...credentials, setupToken })).statusCode, 409);
  const saved = h.app.store.get('SELECT * FROM owners');
  assert.notEqual(saved.password, credentials.password);
});
test('admin API, Swagger assets and specs require a session', async (t) => {
  const h = await harness(t);
  for (const url of ['/api/admin/overview', '/docs/', '/docs/json', '/docs/yaml', '/docs/static/swagger-ui.css', '/openapi.json']) assert.equal((await h.inject('GET', url)).statusCode, 401, url);
  const cookie = await h.owner();
  for (const url of ['/docs/', '/docs/json', '/docs/static/swagger-ui.css', '/openapi.json']) assert.equal((await h.inject('GET', url, undefined, { headers: { cookie } })).statusCode, 200, url);
  assert.equal((await h.inject('GET', '/api/admin/overview', undefined, { headers: { cookie: 'wotp-session=fake' } })).statusCode, 401);
});
test('cookie flags, hashed session and logout invalidate access', async (t) => {
  const h = await harness(t);
  const cookie = await h.owner();
  const login = await h.inject('POST', '/api/login', credentials);
  assert.match(login.headers['set-cookie'], /HttpOnly/); assert.match(login.headers['set-cookie'], /SameSite=Strict/i);
  assert.notEqual(h.app.store.get('SELECT hash FROM sessions').hash, cookie.split('=')[1]);
  assert.equal((await h.inject('POST', '/api/logout', undefined, { headers: { cookie } })).statusCode, 200);
  assert.equal((await h.inject('GET', '/api/admin/overview', undefined, { headers: { cookie } })).statusCode, 401);
});
test('dashboard mutations reject missing or hostile origins and reject unknown fields', async (t) => {
  const h = await harness(t); const cookie = await h.owner();
  for (const origin of [undefined, 'null', 'https://evil.example']) assert.equal((await h.inject('POST', '/api/admin/keys', { name: 'Nope' }, { headers: { cookie, origin } })).statusCode, 403);
  assert.equal((await h.inject('POST', '/api/admin/keys', { name: 'Nope', role: 'superadmin' }, { headers: { cookie } })).statusCode, 400);
});
test('API keys are shown once, stored hashed, revoked and isolated from session auth', async (t) => {
  const h = await harness(t); const cookie = await h.owner(); const key = await h.createKey(cookie);
  const overview = await h.inject('GET', '/api/admin/overview', undefined, { headers: { cookie } });
  assert.equal(overview.body.includes(key.key), false);
  assert.notEqual(h.app.store.get('SELECT hash FROM api_keys').hash, key.key);
  assert.equal((await h.inject('GET', '/v1/devices', undefined, { headers: { cookie } })).statusCode, 401);
  assert.equal((await h.inject('GET', '/v1/devices', undefined, { headers: { authorization: `Bearer ${key.key}`, origin: undefined } })).statusCode, 200);
  await h.inject('DELETE', `/api/admin/keys/${key.id}`, undefined, { headers: { cookie } });
  assert.equal((await h.inject('GET', '/v1/devices', undefined, { headers: { authorization: `Bearer ${key.key}` } })).statusCode, 401);
});
test('failed login attempts are persistently throttled and forwarding headers are not trusted', async (t) => {
  const h = await harness(t); await h.owner();
  for (let i = 0; i < 4; i++) assert.equal((await h.inject('POST', '/api/login', { ...credentials, password: 'wrong' }, { headers: { 'x-forwarded-for': `10.0.0.${i}` } })).statusCode, 401);
  const blocked = await h.inject('POST', '/api/login', credentials);
  assert.equal(blocked.statusCode, 429); assert.ok(Number(blocked.headers['retry-after']) > 0);
});
test('password rotation revokes all sessions and requires the old password', async (t) => {
  const h = await harness(t); const cookie = await h.owner();
  const request = (currentPassword) => h.inject('POST', '/api/admin/password', { currentPassword, newPassword: 'brand-new-password-2026' }, { headers: { cookie } });
  assert.equal((await request('wrong')).statusCode, 403); assert.equal((await request(credentials.password)).statusCode, 200);
  assert.equal((await h.inject('GET', '/api/admin/overview', undefined, { headers: { cookie } })).statusCode, 401);
  assert.equal((await h.inject('POST', '/api/login', { ...credentials, password: 'brand-new-password-2026' })).statusCode, 200);
});
test('private storage permissions and HTTP security headers', async (t) => {
  const h = await harness(t);
  assert.equal(statSync(h.dir).mode & 0o777, 0o700);
  assert.equal(statSync(`${h.dir}/hmac.key`).mode & 0o777, 0o600);
  assert.equal(statSync(`${h.dir}/gateway.sqlite`).mode & 0o777, 0o600);
  const r = await h.inject('GET', '/');
  assert.equal(r.statusCode, 200); assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(readFileSync(`${h.dir}/hmac.key`).length, 32);
  assert.equal((await h.inject('GET', '/assets/../.env')).statusCode, 404);
});
test('HTTPS deployments issue Secure cookies', async (t) => {
  const h = await harness(t, { PUBLIC_URL: 'https://otp.example.test' });
  await h.owner(); const r = await h.inject('POST', '/api/login', credentials);
  assert.match(r.headers['set-cookie'], /Secure/);
});

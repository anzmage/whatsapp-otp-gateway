import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness } from './helpers.mjs';
import { createOtp } from '../src/otp.mjs';
import { openStore } from '../src/db.mjs';

async function ready(t, env = {}) {
  const h = await harness(t, env); const cookie = await h.owner(); const key = await h.createKey(cookie); const device = await h.createDevice(cookie);
  const headers = { authorization: `Bearer ${key.key}`, origin: undefined };
  const payload = { deviceId: device.id, phone: '+628987654321', consent: true };
  const request = (body = payload, idempotency = randomUUID()) => h.inject('POST', '/v1/otp/request', body, { headers: { ...headers, 'idempotency-key': idempotency } });
  const verify = (requestId, code, auth = headers) => h.inject('POST', '/v1/otp/verify', { requestId, code }, { headers: auth });
  const code = () => h.adapter.sent.at(-1).text.match(/code is (\d{6})/)[1];
  return { ...h, cookie, key, device, headers, payload, request, verify, code };
}
test('request sends a six-digit code only to the adapter; verify consumes it exactly once', async (t) => {
  const h = await ready(t); const response = await h.request(); const data = response.json();
  assert.equal(response.statusCode, 202); assert.equal(data.delivery, 'accepted'); assert.equal(data.state, 'active');
  assert.equal(h.adapter.sent.length, 1); assert.equal(h.adapter.sent[0].phone, '628987654321');
  const code = h.code(); assert.match(code, /^\d{6}$/); assert.equal(response.body.includes(`"${code}"`), false);
  const stored = h.app.store.get('SELECT * FROM challenges'); assert.notEqual(stored.code_mac, code); assert.equal(stored.code_mac.length, 64);
  assert.equal((await h.verify(data.requestId, code)).json().verified, true);
  assert.equal((await h.verify(data.requestId, code)).statusCode, 409);
  assert.equal(h.app.store.get('SELECT code_mac FROM challenges').code_mac, null);
});
test('idempotent retries never send twice; changing the recipient conflicts', async (t) => {
  const h = await ready(t); const idempotency = randomUUID();
  const first = await h.request(h.payload, idempotency); const second = await h.request(h.payload, idempotency);
  assert.equal(first.json().requestId, second.json().requestId); assert.equal(h.adapter.sent.length, 1);
  assert.equal((await h.request({ ...h.payload, phone: '+628999999999' }, idempotency)).statusCode, 409);
});
test('concurrent duplicate requests have one durable reservation and one send', async (t) => {
  const h = await ready(t); const idempotency = randomUUID();
  let finish; h.adapter.send = async (...args) => { h.adapter.sent.push(args); await new Promise((resolve) => { finish = resolve; }); return { messageId: 'one-id' }; };
  const first = h.request(h.payload, idempotency);
  // inject returns a lazy thenable; start it before querying the duplicate.
  const running = Promise.resolve(first);
  while (!finish) await new Promise((r) => setTimeout(r, 1));
  const duplicate = await h.request(h.payload, idempotency);
  assert.equal(duplicate.statusCode, 202); assert.equal(duplicate.json().delivery, 'sending');
  finish(); assert.equal((await running).statusCode, 202); assert.equal(h.adapter.sent.length, 1);
});
test('resend cooldown is global across applications for a recipient', async (t) => {
  const h = await ready(t); await h.request();
  const blocked = await h.request(); assert.equal(blocked.statusCode, 429); assert.equal(blocked.json().error, 'RESEND_COOLDOWN'); assert.ok(Number(blocked.headers['retry-after']) > 0);
  const other = await h.createKey(h.cookie, 'Other app');
  assert.equal((await h.inject('POST', '/v1/otp/request', h.payload, { headers: { authorization: `Bearer ${other.key}`, 'idempotency-key': randomUUID() } })).statusCode, 429);
});
test('wrong attempts persist and lock code; correct code cannot bypass lock', async (t) => {
  const h = await ready(t, { OTP_MAX_ATTEMPTS: '3' }); const id = (await h.request()).json().requestId;
  const real = h.code(); const wrong = real === '000000' ? '000001' : '000000';
  for (let i = 0; i < 3; i++) assert.equal((await h.verify(id, wrong)).statusCode, 400);
  assert.equal((await h.verify(id, real)).statusCode, 409);
  const row = h.app.store.get('SELECT * FROM challenges'); assert.equal(row.attempts, 3); assert.equal(row.state, 'locked'); assert.equal(row.code_mac, null);
});
test('expired OTP cannot verify and verifier material is removed', async (t) => {
  const h = await ready(t); const id = (await h.request()).json().requestId; const code = h.code();
  h.app.store.run('UPDATE challenges SET expires=? WHERE id=?', Date.now() - 1, id);
  assert.equal((await h.verify(id, code)).statusCode, 410);
  assert.equal(h.app.store.get('SELECT code_mac FROM challenges').code_mac, null);
});
test('an application cannot inspect or verify another application’s request', async (t) => {
  const h = await ready(t); const id = (await h.request()).json().requestId;
  const other = await h.createKey(h.cookie, 'Other app'); const headers = { authorization: `Bearer ${other.key}` };
  assert.equal((await h.inject('GET', `/v1/otp/${id}`, undefined, { headers })).statusCode, 404);
  assert.equal((await h.verify(id, h.code(), headers)).statusCode, 404);
  assert.equal((await h.inject('GET', `/v1/otp/${id}`, undefined, { headers: h.headers })).statusCode, 200);
});
test('unknown ACK is recorded without blind retry; received code can still verify', async (t) => {
  const h = await ready(t); h.adapter.fail = true; const idem = randomUUID();
  const result = (await h.request(h.payload, idem)).json(); assert.equal(result.delivery, 'delivery_unknown');
  await h.request(h.payload, idem); assert.equal(h.adapter.sent.length, 1);
  assert.equal((await h.verify(result.requestId, h.code())).statusCode, 200);
});
test('offline numbers are rejected without creating an OTP', async (t) => {
  const h = await ready(t); h.adapter.offline = true;
  assert.equal((await h.request()).statusCode, 503); assert.equal(h.adapter.sent.length, 0); assert.equal(h.app.store.get('SELECT count(*) AS n FROM challenges').n, 0);
});
test('request validation requires E.164, explicit consent, UUID and idempotency', async (t) => {
  const h = await ready(t);
  for (const patch of [{ consent: false }, { consent: 'true' }, { consent: undefined }, { phone: '08123456789' }, { deviceId: 'no' }, { code: 'chosen-by-caller' }]) assert.equal((await h.request({ ...h.payload, ...patch })).statusCode, 400);
  assert.equal((await h.inject('POST', '/v1/otp/request', h.payload, { headers: h.headers })).statusCode, 400);
  assert.equal(h.adapter.sent.length, 0);
});
test('daily application quota and per-IP request limits are enforced', async (t) => {
  const h = await ready(t, { OTP_APP_PER_DAY: '1', OTP_IP_PER_MINUTE: '3' });
  assert.equal((await h.request()).statusCode, 202);
  const daily = await h.request({ ...h.payload, phone: '+628111111111' }); assert.equal(daily.statusCode, 429);
  await h.request({ ...h.payload, phone: '+628222222222' });
  const ip = await h.request({ ...h.payload, phone: '+628333333333' }); assert.equal(ip.statusCode, 429);
  assert.equal(h.adapter.sent.length, 1);
});
test('recipient and device quotas are enforced with controllable time', async (t) => {
  const h = await ready(t, { OTP_RECIPIENT_PER_HOUR: '2', OTP_DEVICE_PER_MINUTE: '1' });
  let now = Date.now();
  const service = createOtp({ store: h.app.store, config: h.config, whatsapp: h.adapter, now: () => now });
  await service.request(h.key.id, h.payload, randomUUID());
  await assert.rejects(service.request(h.key.id, { ...h.payload, phone: '+628444444444' }, randomUUID()), (e) => e.statusCode === 429);
  now += 61_000;
  await service.request(h.key.id, h.payload, randomUUID());
  now += 61_000;
  await assert.rejects(service.request(h.key.id, h.payload, randomUUID()), (e) => e.statusCode === 429);
});
test('a new code supersedes old codes and metadata cleanup removes records after 24h', async (t) => {
  const h = await ready(t); let now = Date.now();
  const service = createOtp({ store: h.app.store, config: h.config, whatsapp: h.adapter, now: () => now });
  const first = await service.request(h.key.id, h.payload, randomUUID()); const firstCode = h.code();
  now += 61_000;
  const second = await service.request(h.key.id, h.payload, randomUUID());
  assert.equal(service.status(h.key.id, first.requestId).state, 'superseded');
  assert.throws(() => service.verify(h.key.id, first.requestId, firstCode), (e) => e.statusCode === 409);
  assert.notEqual(first.requestId, second.requestId);
  h.app.store.cleanup(now + 86400_001); assert.equal(h.app.store.get('SELECT count(*) AS n FROM challenges').n, 0);
});
test('state, limits, HMAC key and ambiguous sends survive a database reopen', async (t) => {
  const h = await ready(t); const result = (await h.request()).json(); const code = h.code();
  h.app.store.run("UPDATE challenges SET delivery='sending' WHERE id=?", result.requestId);
  // A second connection represents restart recovery while preserving the real store on disk.
  const reopened = openStore(h.dir);
  assert.equal(reopened.get('SELECT delivery FROM challenges').delivery, 'delivery_unknown');
  assert.deepEqual(reopened.secret, h.app.store.secret);
  assert.throws(() => reopened.limit(`app-day:${h.key.id}`, 1, 86400_000), (e) => e.statusCode === 429);
  const service = createOtp({ store: reopened, config: h.config, whatsapp: h.adapter });
  assert.equal(service.verify(h.key.id, result.requestId, code).verified, true);
  reopened.close();
});
test('OpenAPI 3.1 exposes documented API schemas, security and errors, not admin routes', async (t) => {
  const h = await ready(t);
  const response = await h.inject('GET', '/openapi.json', undefined, { headers: { cookie: h.cookie } }); const spec = response.json();
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/v1/devices', '/v1/otp/request', '/v1/otp/verify', '/v1/otp/{id}']);
  assert.equal(spec.components.securitySchemes.apiKey.scheme, 'bearer');
  assert.ok(spec.paths['/v1/otp/request'].post.parameters.some((p) => p.name === 'idempotency-key' && p.required));
  assert.ok(spec.paths['/v1/otp/verify'].post.responses['410']);
  assert.equal(JSON.stringify(spec).includes(h.key.key), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WhatsApp } from '../src/whatsapp.mjs';
import { harness } from './helpers.mjs';

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(check) { for (let i = 0; i < 200 && !check(); i++) await tick(); assert.ok(check()); }
async function setup(t, options = {}) {
  const h = await harness(t); const cookie = await h.owner(); const d = await h.createDevice(cookie);
  const device = h.app.store.get('SELECT * FROM devices WHERE id=?', d.id);
  const sockets = [];
  const gateway = new WhatsApp({ store: h.app.store, config: h.config, logger: h.app.log, sendTimeout: 15,
    authFactory: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
    socketFactory: () => {
      const socket = { ev: new EventEmitter(), user: { id: `${device.phone}:1@s.whatsapp.net` }, sent: [], pairCalls: 0,
        async sendMessage(jid, message) { this.sent.push({ jid, message }); return { key: { id: 'test-message-id' } }; },
        async requestPairingCode(phone) { this.pairCalls++; this.pairPhone = phone; return 'TEST-CODE'; },
        async logout() { this.loggedOut = true; }, end() { this.ended = true; },
      };
      sockets.push(socket); return socket;
    }, ...options });
  t.after(() => gateway.close());
  return { ...h, cookie, gateway, sockets, device };
}
test('adapter pairs by QR and validates the registered account before enabling sends', async (t) => {
  const h = await setup(t); await h.gateway.connect(h.device, 'qr'); const socket = h.sockets[0];
  assert.equal(h.gateway.connected(h.device.id), false);
  socket.ev.emit('connection.update', { qr: 'TEST-ONLY-QR-NOT-A-REAL-SESSION' });
  await until(() => h.gateway.view(h.device).qr);
  assert.match(h.gateway.view(h.device).qr, /^data:image\/png;base64,/);
  socket.ev.emit('connection.update', { connection: 'open' });
  assert.equal(h.gateway.connected(h.device.id), true); assert.equal(h.gateway.view(h.device).qr, null);
  assert.deepEqual(await h.gateway.send(h.device.id, '628999999999', 'test message, not an OTP'), { messageId: 'test-message-id' });
  assert.equal(socket.sent[0].jid, '628999999999@s.whatsapp.net');
  await h.gateway.connect(h.device, 'qr'); assert.equal(h.sockets.length, 1);
});
test('pairing code requested once for the registered phone', async (t) => {
  const h = await setup(t); await h.gateway.connect(h.device, 'code'); const socket = h.sockets[0];
  socket.ev.emit('connection.update', { qr: 'a' }); socket.ev.emit('connection.update', { qr: 'b' });
  await until(() => !!h.gateway.view(h.device).pairingCode);
  assert.equal(socket.pairCalls, 1); assert.equal(socket.pairPhone, h.device.phone); assert.equal(h.gateway.view(h.device).qr, null);
});
test('wrong-account pairing is stopped and its local credentials are removed', async (t) => {
  const h = await setup(t); await h.gateway.connect(h.device); const socket = h.sockets[0]; socket.user.id = '628000000000:1@s.whatsapp.net';
  socket.ev.emit('connection.update', { connection: 'open' });
  await until(() => h.gateway.view(h.device).status === 'wrong_number' && !h.gateway.removing.has(h.device.id));
  assert.equal(h.gateway.connected(h.device.id), false); assert.equal(socket.loggedOut, true); assert.equal(socket.ended, true);
  assert.equal(existsSync(`${h.config.dataDir}/auth/${h.device.id}`), false);
  await assert.rejects(h.gateway.connect(h.device), (e) => e.code === 'PAIRING_RESET_REQUIRED');
});
test('send timeouts are uncertain and never automatically retried', async (t) => {
  const h = await setup(t); await h.gateway.connect(h.device); const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' }); let calls = 0;
  socket.sendMessage = () => { calls++; return new Promise(() => {}); };
  await assert.rejects(h.gateway.send(h.device.id, '628999999999', 'test'), (e) => e.code === 'DELIVERY_UNKNOWN');
  assert.equal(calls, 1);
});
test('unlinked sessions block sends; removal stops stale reconnection and receipts', async (t) => {
  const h = await setup(t); await h.gateway.connect(h.device); const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(h.gateway.view(h.device).status, 'logged_out');
  await assert.rejects(h.gateway.send(h.device.id, '628999999999', 'test'), (e) => e.code === 'DEVICE_OFFLINE');
  await h.gateway.remove(h.device.id);
  socket.ev.emit('connection.update', { connection: 'open' });
  assert.equal(h.gateway.connected(h.device.id), false); assert.equal(socket.ended, true);
  assert.equal(existsSync(`${h.config.dataDir}/auth/${h.device.id}`), false);
});
test('receipts update only matching outgoing IDs and cannot downgrade a read status', async (t) => {
  const h = await setup(t); const key = await h.createKey(h.cookie); const requestId = randomUUID();
  h.app.store.run("INSERT INTO challenges(id,key_id,device_id,phone,idempotency,created,expires,message_id,delivery) VALUES(?,?,?,?,?,?,?,?,?)", requestId, key.id, h.device.id, '628999999999', 'test', Date.now(), Date.now() + 60_000, 'test-message-id', 'accepted');
  await h.gateway.connect(h.device); const socket = h.sockets[0]; socket.ev.emit('connection.update', { connection: 'open' });
  const receipt = (id, status, fromMe = true) => socket.ev.emit('messages.update', [{ key: { id, fromMe }, update: { status } }]);
  const delivery = () => h.app.store.get('SELECT delivery FROM challenges WHERE id=?', requestId).delivery;
  receipt('wrong-message-id', 4); receipt('test-message-id', 4, false); assert.equal(delivery(), 'accepted');
  receipt('test-message-id', 3); assert.equal(delivery(), 'delivered');
  receipt('test-message-id', 4); assert.equal(delivery(), 'read');
  receipt('test-message-id', 3); assert.equal(delivery(), 'read');
});
test('a failed initial socket can be retried instead of staying stuck connecting', async (t) => {
  const h = await setup(t, { socketFactory: () => { throw new Error('Test socket construction failure'); } });
  await assert.rejects(h.gateway.connect(h.device), (e) => e.code === 'CONNECTION_FAILED');
  assert.equal(h.gateway.view(h.device).status, 'disconnected');
  await assert.rejects(h.gateway.connect(h.device), (e) => e.code === 'CONNECTION_FAILED');
});

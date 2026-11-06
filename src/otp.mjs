import { randomInt, randomUUID } from 'node:crypto';
import { HttpError, canonicalPhone, equal, hash, mac, maskPhone } from './security.mjs';

export function createOtp({ store, config, whatsapp, now = Date.now }) {
  const view = (row) => ({
    requestId: row.id, deviceId: row.device_id, recipient: maskPhone(row.phone),
    state: row.state === 'active' && row.expires <= now() ? 'expired' : row.state,
    delivery: row.delivery, expiresAt: new Date(row.expires).toISOString(),
    attemptsRemaining: Math.max(0, config.maxAttempts - row.attempts),
  });
  const owned = (keyId, id) => {
    const row = store.get('SELECT * FROM challenges WHERE id=? AND key_id=?', id, keyId);
    if (!row) throw new HttpError(404, 'REQUEST_NOT_FOUND', 'OTP request not found.');
    return row;
  };
  const status = (keyId, id) => view(owned(keyId, id));
  async function request(keyId, { deviceId, phone: input, consent }, idempotency) {
    if (consent !== true) throw new HttpError(400, 'CONSENT_REQUIRED', 'Only request a code with the recipient’s permission.');
    const phone = canonicalPhone(input);
    const idempotencyHash = hash(idempotency);
    const previous = store.get('SELECT * FROM challenges WHERE key_id=? AND idempotency=?', keyId, idempotencyHash);
    if (previous) {
      if (previous.device_id !== deviceId || previous.phone !== phone) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for different request data.');
      return view(previous);
    }
    if (!store.get('SELECT id FROM devices WHERE id=?', deviceId)) throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Sending number not found.');
    if (!whatsapp.connected(deviceId)) throw new HttpError(503, 'DEVICE_OFFLINE', 'Connect the sending number in the dashboard first.');
    const time = now();
    const id = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    store.transaction(() => {
      const recent = store.get('SELECT created FROM challenges WHERE phone=? ORDER BY created DESC LIMIT 1', phone);
      if (recent && time - recent.created < config.cooldown * 1000) throw new HttpError(429, 'RESEND_COOLDOWN', 'Wait before requesting another code for this recipient.', Math.ceil((recent.created + config.cooldown * 1000 - time) / 1000));
      store.limit(`app-minute:${keyId}`, config.appPerMinute, 60_000, time);
      store.limit(`app-day:${keyId}`, config.appPerDay, 86400_000, time);
      // HMAC identifiers avoid putting raw recipient numbers in rate-limit keys.
      store.limit(`phone:${mac(store.secret, phone)}`, config.recipientPerHour, 3600_000, time);
      store.limit(`device:${deviceId}`, config.devicePerMinute, 60_000, time);
      // A new code replaces all older active codes for this app and recipient.
      store.run("UPDATE challenges SET state='superseded', code_mac=NULL WHERE key_id=? AND phone=? AND state='active'", keyId, phone);
      store.run('INSERT INTO challenges(id,key_id,device_id,phone,idempotency,code_mac,created,expires) VALUES(?,?,?,?,?,?,?,?)',
        id, keyId, deviceId, phone, idempotencyHash, mac(store.secret, `${id}:${code}`), time, time + config.ttl * 1000);
    });
    try {
      const result = await whatsapp.send(deviceId, phone, `Your verification code is ${code}.\nExpires in ${Math.ceil(config.ttl / 60)} minutes. Do not share this code.\nIf you did not request it, ignore this message.`);
      store.run("UPDATE challenges SET delivery='accepted', message_id=? WHERE id=?", result.messageId, id);
    } catch (err) {
      if (err.code === 'DEVICE_OFFLINE') store.run("UPDATE challenges SET state='failed', delivery='failed', code_mac=NULL WHERE id=?", id);
      else store.run("UPDATE challenges SET delivery='delivery_unknown' WHERE id=?", id);
    }
    return status(keyId, id);
  }
  function verify(keyId, id, code) {
    // All verification outcomes commit attempt/expiry changes before returning an error.
    const result = store.transaction(() => {
      const row = owned(keyId, id);
      if (row.state !== 'active') return new HttpError(409, 'OTP_INACTIVE', 'OTP is already used, replaced, locked or unavailable.');
      if (row.expires <= now()) {
        store.run("UPDATE challenges SET state='expired', code_mac=NULL WHERE id=?", id);
        return new HttpError(410, 'OTP_EXPIRED', 'OTP has expired.');
      }
      const attempts = row.attempts + 1;
      if (!equal(mac(store.secret, `${id}:${code}`), row.code_mac || '')) {
        store.run("UPDATE challenges SET attempts=?, state=?, code_mac=CASE WHEN ? THEN NULL ELSE code_mac END WHERE id=?", attempts, attempts >= config.maxAttempts ? 'locked' : 'active', attempts >= config.maxAttempts ? 1 : 0, id);
        return new HttpError(400, 'INVALID_OTP', 'OTP is incorrect.');
      }
      store.run("UPDATE challenges SET state='verified', code_mac=NULL, attempts=? WHERE id=?", attempts, id);
      return { verified: true, requestId: id };
    });
    if (result instanceof Error) throw result;
    return result;
  }
  return { request, verify, status, view };
}

import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { maskPhone, HttpError } from './security.mjs';

// One process owns the SQLite database and every WhatsApp session. No cluster/multi-replica mode.
export class WhatsApp {
  constructor({ store, config, logger, socketFactory = makeWASocket, authFactory = useMultiFileAuthState, sendTimeout = 25_000 }) {
    Object.assign(this, { store, config, logger, socketFactory, authFactory, sendTimeout });
    this.slots = new Map();
    this.removing = new Set();
    this.stopped = false;
  }
  view(device) {
    const s = this.slots.get(device.id);
    return { id: device.id, label: device.label, phone: maskPhone(device.phone), createdAt: new Date(device.created).toISOString(),
      status: s?.status || 'disconnected', qr: s?.qr || null, pairingCode: s?.pairingCode || null, error: s?.error || null };
  }
  connected(id) { return this.slots.get(id)?.status === 'connected'; }
  async restore() {
    for (const device of this.store.all('SELECT * FROM devices')) {
      try { await access(join(this.config.dataDir, 'auth', device.id, 'creds.json')); }
      catch { continue; }
      this.connect(device, 'qr').catch(() => this.logger.warn('WhatsApp restore failed; reconnect in dashboard'));
    }
  }
  async connect(device, mode = 'qr') {
    if (this.stopped) throw new HttpError(503, 'SHUTTING_DOWN', 'Service is shutting down.');
    if (this.removing.has(device.id)) throw new HttpError(409, 'DEVICE_REMOVING', 'Wait for number removal to finish.');
    let slot = this.slots.get(device.id);
    if (['logged_out', 'wrong_number'].includes(slot?.status)) throw new HttpError(409, 'PAIRING_RESET_REQUIRED', 'Remove and re-add this number to pair again.');
    if (slot && ['connecting', 'awaiting_pairing', 'connected', 'reconnecting'].includes(slot.status)) return this.view(device);
    if (slot?.timer) clearTimeout(slot.timer);
    slot = { status: 'connecting', qr: null, pairingCode: null, error: null, tries: 0, writes: Promise.resolve() };
    this.slots.set(device.id, slot);
    try { await this.open(device, slot, mode); }
    catch {
      slot.status = 'disconnected'; slot.error = 'Connection failed. Check network and storage, then reconnect.';
      throw new HttpError(503, 'CONNECTION_FAILED', slot.error);
    }
    return this.view(device);
  }
  async open(device, slot, mode) {
    if (this.stopped || this.slots.get(device.id) !== slot) return;
    const dir = join(this.config.dataDir, 'auth', device.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await this.authFactory(dir);
    if (this.stopped || this.slots.get(device.id) !== slot) return;
    const sock = this.socketFactory({
      auth: state,
      // Baileys diagnostic logs can contain phone/session data; do not expose them in app logs.
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
      browser: ['OTP Gateway', 'Chrome', '1.0.0'],
    });
    slot.sock = sock;
    let closed = false;
    const current = () => !closed && !this.stopped && this.slots.get(device.id) === slot && slot.sock === sock;
    let requestedCode = false;
    sock.ev.on('creds.update', () => {
      if (current()) slot.writes = slot.writes.then(saveCreds).catch(() => { slot.error = 'Session save failed; check disk permissions.'; });
    });
    sock.ev.on('connection.update', (event) => {
      (async () => {
        if (!current()) return;
        const { connection, lastDisconnect, qr } = event;
        if (qr) {
          slot.status = 'awaiting_pairing';
          if (mode === 'code') {
            if (!requestedCode) {
              requestedCode = true;
              const code = await sock.requestPairingCode(device.phone);
              if (current()) slot.pairingCode = code;
            }
          } else {
            const image = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
            if (current()) slot.qr = image;
          }
        }
        if (connection === 'open') {
          const actual = sock.user?.id?.split('@')[0]?.split(':')[0];
          if (actual !== device.phone) {
            slot.status = 'wrong_number'; slot.error = 'Paired number does not match the registered number. Remove it and add the correct number.';
            slot.qr = null; slot.pairingCode = null;
            closed = true;
            this.removing.add(device.id);
            try {
              await this.endSocket(slot, true);
              await rm(dir, { recursive: true, force: true });
            } finally { this.removing.delete(device.id); }
            return;
          }
          slot.status = 'connected'; slot.qr = null; slot.pairingCode = null; slot.error = null; slot.tries = 0;
        }
        if (connection === 'close') {
          closed = true;
          slot.qr = null; slot.pairingCode = null;
          const code = lastDisconnect?.error?.output?.statusCode;
          if ([DisconnectReason.loggedOut, DisconnectReason.connectionReplaced, DisconnectReason.forbidden].includes(code)) {
            slot.status = 'logged_out'; slot.error = 'Session ended or was replaced. Remove and re-add this number to pair again.';
            return;
          }
          if (slot.tries++ >= 8) {
            slot.status = 'disconnected'; slot.error = 'Reconnect attempts exhausted. Reconnect manually.'; return;
          }
          slot.status = 'reconnecting';
          slot.timer = setTimeout(() => {
            this.open(device, slot, mode).catch(() => { slot.status = 'disconnected'; slot.error = 'Connection failed. Try reconnecting.'; });
          }, Math.min(30_000, 1500 * 2 ** slot.tries));
          slot.timer.unref?.();
        }
      })().catch(() => {
        if (current()) { slot.error = 'Pairing failed. Remove and re-add this number to retry.'; }
      });
    });
    sock.ev.on('messages.update', (updates) => {
      if (!current()) return;
      for (const { key, update } of updates) {
        if (!key.fromMe || !key.id || !update.status) continue;
        if (update.status >= 3) {
          const delivery = update.status >= 4 ? 'read' : 'delivered';
          this.store.run("UPDATE challenges SET delivery=? WHERE message_id=? AND device_id=? AND delivery IN ('accepted','delivered','delivery_unknown') AND delivery!='read'", delivery, key.id, device.id);
        }
      }
    });
  }
  async send(id, phone, text) {
    const slot = this.slots.get(id);
    if (slot?.status !== 'connected') throw new HttpError(503, 'DEVICE_OFFLINE', 'The sending number is not connected.');
    // Do not retry on an uncertain ACK. A timeout may still have sent the message.
    let timer;
    try {
      const result = await Promise.race([
        slot.sock.sendMessage(`${phone}@s.whatsapp.net`, { text }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Send timeout')), this.sendTimeout); }),
      ]);
      if (!result?.key?.id) throw new Error('Missing message acknowledgement');
      return { messageId: result.key.id };
    } catch {
      throw new HttpError(502, 'DELIVERY_UNKNOWN', 'Send acknowledgement is uncertain. Check request status; do not blindly resend.');
    } finally { clearTimeout(timer); }
  }
  async endSocket(slot, unlink = false) {
    if (slot?.sock) {
      let timer;
      try {
        if (unlink) await Promise.race([
          slot.sock.logout(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Logout timeout')), 3000); }),
        ]);
      } catch { /* Remote logout is best effort; the owner must also check the phone. */ }
      finally { clearTimeout(timer); }
      try { slot.sock.end(new Error('Session ended by gateway')); } catch { /* Already closed. */ }
    }
    await slot?.writes;
  }
  async remove(id) {
    if (this.removing.has(id)) throw new HttpError(409, 'DEVICE_REMOVING', 'Wait for number removal to finish.');
    this.removing.add(id);
    const slot = this.slots.get(id);
    this.slots.delete(id);
    clearTimeout(slot?.timer);
    try {
      await this.endSocket(slot, true);
      await rm(join(this.config.dataDir, 'auth', id), { recursive: true, force: true });
    } finally { this.removing.delete(id); }
  }
  async close() {
    this.stopped = true;
    for (const slot of this.slots.values()) {
      clearTimeout(slot.timer);
      await this.endSocket(slot);
    }
    this.slots.clear();
  }
}

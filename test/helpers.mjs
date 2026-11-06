import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';

export const setupToken = 'test-only-setup-token-not-for-production';
export const credentials = { email: 'owner@example.test', password: 'correct-horse-battery-staple' };
export function fakeWhatsApp() {
  const statuses = new Map();
  return {
    sent: [], statuses, fail: false, offline: false,
    connected() { return !this.offline; },
    view(d) { return { id: d.id, label: d.label, phone: '+62••••1234', createdAt: new Date(d.created).toISOString(), status: statuses.get(d.id) || 'disconnected', qr: null, pairingCode: null, error: null }; },
    async connect(d, mode) { statuses.set(d.id, 'connected'); this.mode = mode; return this.view(d); },
    async send(deviceId, phone, text) {
      this.sent.push({ deviceId, phone, text });
      if (this.fail) throw new Error('Unknown acknowledgement');
      return { messageId: randomUUID() };
    },
    async remove(id) { statuses.delete(id); }, async close() {},
  };
}
export async function harness(t, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'otp-test-'));
  const config = loadConfig({ SETUP_TOKEN: setupToken, DATA_DIR: dir, ...env });
  const adapter = fakeWhatsApp();
  const app = await createApp({ config, adapter, logger: false });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const inject = (method, url, payload, options = {}) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers: Object.fromEntries(Object.entries({ origin: config.origin, ...options.headers }).filter(([, value]) => value !== undefined)), ...Object.fromEntries(Object.entries(options).filter(([k]) => k !== 'headers')) });
  const owner = async () => {
    const result = await inject('POST', '/api/setup', { ...credentials, setupToken });
    if (result.statusCode !== 201) throw new Error(result.body);
    const login = await inject('POST', '/api/login', credentials);
    return login.headers['set-cookie'].split(';')[0];
  };
  const createKey = async (cookie, name = 'Test app') => {
    const response = await inject('POST', '/api/admin/keys', { name }, { headers: { cookie } });
    if (response.statusCode !== 201) throw new Error(response.body);
    return response.json();
  };
  const createDevice = async (cookie) => {
    const response = await inject('POST', '/api/admin/devices', { label: 'Test sender', phone: '+628123451234' }, { headers: { cookie } });
    if (response.statusCode !== 201) throw new Error(response.body);
    return response.json();
  };
  return { app, config, adapter, dir, inject, owner, createKey, createDevice };
}

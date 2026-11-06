// Isolated container smoke: synthetic owner/key only, no WhatsApp number or messages.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const suffix = randomBytes(6).toString('hex');
const name = `wotp-smoke-${suffix}`;
const volume = `${name}-data`;
const dir = mkdtempSync(join(tmpdir(), 'wotp-docker-'));
const setupToken = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex');
const envPath = join(dir, 'env');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
writeFileSync(envPath, `SETUP_TOKEN=${setupToken}\nPUBLIC_URL=http://localhost:3000\n`, { mode: 0o600 });
let key;
try {
  docker('volume', 'create', volume);
  docker('run', '-d', '--name', name, '--init', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount', `type=volume,source=${volume},target=/app/.data`, '--env-file', envPath, '-p', '127.0.0.1::3000', process.env.OTP_DOCKER_IMAGE || 'whatsapp-otp-gateway:dev');
  const getBase = () => `http://127.0.0.1:${docker('port', name, '3000/tcp').split(':').at(-1)}`;
  let base = getBase();
  async function ready() {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Container did not become ready');
  }
  await ready();
  assert.equal(docker('exec', name, 'id', '-u'), '1000');
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/docs/`)).status, 401);
  assert.equal((await fetch(`${base}/api/bootstrap`).then((r) => r.json())).setupRequired, true);
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/setup', { email: 'docker-test@example.test', password, setupToken })).status, 201);
  const login = await post('/api/login', { email: 'docker-test@example.test', password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const issued = await post('/api/admin/keys', { name: 'Container smoke' }, { Cookie: cookie });
  assert.equal(issued.status, 201); key = (await issued.json()).key;
  docker('restart', '-t', '40', name);
  base = getBase();
  await ready();
  assert.equal((await fetch(`${base}/api/bootstrap`).then((r) => r.json())).setupRequired, false);
  assert.equal((await fetch(`${base}/api/admin/overview`, { headers: { Cookie: cookie } })).status, 200);
  const devices = await fetch(`${base}/v1/devices`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(devices.status, 200); assert.deepEqual(await devices.json(), []);
  const logs = docker('logs', name);
  for (const secret of [setupToken, password, key]) assert.equal(logs.includes(secret), false, 'Secret leaked to container logs');
  console.log('Docker smoke passed: non-root/read-only container, owner setup/login, private docs, API key and session persistence across restart. No WhatsApp connection or send.');
} finally {
  try { docker('rm', '-f', name); } catch {}
  try { docker('volume', 'rm', volume); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

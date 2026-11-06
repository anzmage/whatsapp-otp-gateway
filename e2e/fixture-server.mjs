// TEST ONLY: fake WhatsApp transport, bound to loopback, isolated temporary storage.
// No production entrypoint imports this file or supports a mock-provider switch.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { fakeWhatsApp, setupToken } from '../test/helpers.mjs';

const dir = mkdtempSync(join(tmpdir(), 'otp-browser-'));
const config = loadConfig({ SETUP_TOKEN: setupToken, DATA_DIR: dir });
const adapter = fakeWhatsApp();
const send = adapter.send.bind(adapter);
adapter.send = async (...args) => {
  const result = await send(...args);
  process.send({ type: 'sent', message: adapter.sent.at(-1) });
  return result;
};
const app = await createApp({ config, adapter, logger: false });
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${app.server.address().port}`;
config.origin = origin;
app.swagger().servers[0].url = origin;
process.send({ type: 'ready', origin });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0);
}
process.on('message', (message) => { if (message === 'stop') close(); });
process.on('disconnect', close);
process.on('SIGTERM', close);

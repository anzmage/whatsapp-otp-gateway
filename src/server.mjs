import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';

process.umask(0o077);
let app;
try {
  const config = loadConfig();
  app = await createApp({ config });
  await app.listen({ port: config.port, host: config.host });
  await app.whatsapp.restore();
  app.log.info({ dashboard: config.origin }, 'Experimental OTP gateway ready. Pair a spare number in the dashboard.');
} catch (err) {
  console.error('Startup failed:', err.code || (app ? 'INTERNAL_ERROR' : err.message));
  if (app) await app.close();
  process.exitCode = 1;
}
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    try { await app?.close(); }
    catch { process.exitCode = 1; }
  });
}

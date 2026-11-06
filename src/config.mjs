import { resolve } from 'node:path';

export function loadConfig(env = process.env) {
  const number = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const publicUrl = new URL(env.PUBLIC_URL || 'http://localhost:3000');
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new Error('PUBLIC_URL must be an origin');
  if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname))) throw new Error('PUBLIC_URL requires HTTPS except on localhost');
  const setupToken = env.SETUP_TOKEN || '';
  if (setupToken.length < 32 || setupToken.startsWith('REPLACE_')) throw new Error('SETUP_TOKEN must contain at least 32 characters; generate with: openssl rand -hex 32');
  return {
    port: number('PORT', 3000, 1, 65535),
    host: env.HOST || '0.0.0.0',
    dataDir: resolve(env.DATA_DIR || '.data'),
    origin: publicUrl.origin,
    secureCookie: publicUrl.protocol === 'https:',
    setupToken,
    ttl: number('OTP_TTL_SECONDS', 300, 60, 600),
    maxAttempts: number('OTP_MAX_ATTEMPTS', 5, 1, 10),
    cooldown: number('OTP_COOLDOWN_SECONDS', 60, 30, 3600),
    appPerMinute: number('OTP_APP_PER_MINUTE', 10, 1, 100),
    appPerDay: number('OTP_APP_PER_DAY', 100, 1, 10000),
    recipientPerHour: number('OTP_RECIPIENT_PER_HOUR', 5, 1, 20),
    ipPerMinute: number('OTP_IP_PER_MINUTE', 20, 1, 100),
    devicePerMinute: number('OTP_DEVICE_PER_MINUTE', 10, 1, 60),
    maxDevices: number('MAX_DEVICES', 5, 1, 20),
    // Never trust arbitrary forwarding headers. Opt in only behind a trusted local proxy.
    trustProxy: env.TRUST_PROXY === 'loopback' ? 'loopback' : false,
  };
}

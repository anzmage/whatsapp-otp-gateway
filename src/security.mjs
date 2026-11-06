import { randomBytes, createHash, createHmac, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);

export const token = () => randomBytes(32).toString('hex');
export const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
export const mac = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');
export function equal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const digest = await scrypt(password, salt, 64);
  return `${salt}:${digest.toString('hex')}`;
}
export async function passwordMatches(password, saved) {
  const [salt, digest] = saved.split(':');
  return equal((await scrypt(password, salt, 64)).toString('hex'), digest);
}
export class HttpError extends Error {
  constructor(statusCode, code, message, retryAfter) {
    super(message);
    Object.assign(this, { statusCode, code, retryAfter });
  }
}
export const maskPhone = (phone) => `+${phone.slice(0, 2)}${'•'.repeat(Math.max(0, phone.length - 6))}${phone.slice(-4)}`;
export const canonicalPhone = (input) => {
  // Deliberately no guesswork for local numbers: callers must supply E.164 country code.
  if (!/^\+[1-9]\d{7,14}$/.test(input)) throw new HttpError(400, 'INVALID_PHONE', 'Use international E.164 format, for example +6281234567890.');
  return input.slice(1);
};

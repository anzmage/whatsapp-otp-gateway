export const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
export const text = (maxLength = 100, minLength = 1) => ({ type: 'string', minLength, maxLength });
export const uuid = { type: 'string', format: 'uuid' };
export const phone = { type: 'string', pattern: '^\\+[1-9]\\d{7,14}$', description: 'International E.164 phone number, including + and country code.', examples: ['+6281234567890'] };
export const idParams = object({ id: uuid });
export const error = object({ error: { type: 'string' }, message: { type: 'string' } });
export const errors = Object.fromEntries([400, 401, 403, 404, 409, 410, 429, 500, 503].map((status) => [status, error]));
export const challenge = object({
  requestId: uuid, deviceId: uuid, recipient: { type: 'string', description: 'Masked destination number.' },
  state: { type: 'string', enum: ['active', 'verified', 'expired', 'locked', 'superseded', 'failed'] },
  delivery: { type: 'string', enum: ['sending', 'accepted', 'delivered', 'read', 'failed', 'delivery_unknown'], description: 'accepted only means Baileys returned a message ID; it does NOT prove delivery. Receipts are best effort.' },
  expiresAt: { type: 'string', format: 'date-time' }, attemptsRemaining: { type: 'integer' },
});

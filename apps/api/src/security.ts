import { randomBytes, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
export function hashPassword(password: string): string { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(password, salt, 64).toString('hex'); }
export function checkPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':'); if (!salt || !hash) return false;
  const actual = scryptSync(password, salt, 64), expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function key(): Buffer {
  const value = process.env.DATA_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('DATA_KEY must be 32 random bytes encoded as hex');
  return Buffer.from(value, 'hex');
}
export function encrypt(value: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  return [iv.toString('hex'), Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('hex'), cipher.getAuthTag().toString('hex')].filter(Boolean).join('.');
}
export function decrypt(value: string): string {
  const [iv, data, tag] = value.split('.'), cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'hex'));
  cipher.setAuthTag(Buffer.from(tag, 'hex')); return Buffer.concat([cipher.update(Buffer.from(data, 'hex')), cipher.final()]).toString('utf8');
}

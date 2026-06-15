import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/** scrypt password hash, stored as `salt:key` hex. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const key = Buffer.from(keyHex, 'hex');
  const derived = scryptSync(password, salt, key.length);
  return key.length === derived.length && timingSafeEqual(key, derived);
}

/** Opaque, URL-safe random token (enrollment tokens, runner credentials). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

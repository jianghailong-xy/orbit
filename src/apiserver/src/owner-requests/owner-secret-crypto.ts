import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

/**
 * The cipher for owner-entered secrets (design docs/design/owner-request-secrets.md §3.3): AES-256-GCM, as provider
 * keys use (providers/provider-crypto.ts), under a key of its own and bound to the row it was written for.
 *
 *   - key = HKDF-SHA-256 of PROVIDER_SECRET_KEY with the domain `orbit:owner-secret:v1`, so no new deployment secret,
 *     and a provider-key ciphertext cannot be decrypted as an owner secret or the other way round;
 *   - associated data names the row (`grant id | owner id | runner id`, or `secret id | owner id` for a saved one), so
 *     a ciphertext copied to another row — another runner's — fails authentication instead of being delivered.
 */
const DOMAIN = 'orbit:owner-secret:v1';

/** Filing or submitting a secret is refused with this code when PROVIDER_SECRET_KEY is not set. */
export const SECRET_STORE_UNAVAILABLE = 'SECRET_STORE_UNAVAILABLE';

export function ownerSecretStoreAvailable(): boolean {
  return Boolean(process.env.PROVIDER_SECRET_KEY);
}

function key(): Buffer {
  const secret = process.env.PROVIDER_SECRET_KEY;
  if (!secret) throw new Error('PROVIDER_SECRET_KEY is required to store or read an owner secret');
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(DOMAIN, 'utf8'), 32));
}

/** The associated data of a grant. */
export function grantAad(grantId: string, ownerId: string, runnerId: string): string {
  return `grant|${grantId}|${ownerId}|${runnerId}`;
}

/** The associated data of a saved account secret. */
export function savedSecretAad(secretId: string, ownerId: string): string {
  return `saved|${secretId}|${ownerId}`;
}

/** "iv:tag:ct", each base64. */
export function sealOwnerSecret(plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join(':');
}

/** Throws when the ciphertext was written for another row, under another key, or was tampered with. */
export function openOwnerSecret(stored: string, aad: string): string {
  const [ivB64, tagB64, ctB64] = stored.split(':');
  if (!ivB64 || !tagB64 || ctB64 === undefined) throw new Error('malformed owner secret ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

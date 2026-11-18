import { createHash } from 'node:crypto';

/** APNs refuses an `apns-collapse-id` over 64 bytes with 400 InvalidCollapseId, and drops the push. */
export const APNS_COLLAPSE_ID_MAX_BYTES = 64;

/**
 * A collapse id every channel accepts: one within APNs's 64 bytes is returned as it is, a longer one becomes the
 * 64-hex sha256 of it, so the same id still collapses with itself. Feishu's collapse_key (at most 200 characters)
 * and Android's notificationKey take the same value.
 */
export function fitCollapseId(id: string): string {
  if (Buffer.byteLength(id, 'utf8') <= APNS_COLLAPSE_ID_MAX_BYTES) return id;
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

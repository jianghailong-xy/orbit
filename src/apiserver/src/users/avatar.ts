import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { toBytes, UploadedFile } from '../attachments/attachments.media';

/**
 * The largest profile photo kept. Clients crop to a square and scale to 512px before sending, which
 * comes to well under 200KB as a JPEG; this leaves room for a PNG of the same without admitting a
 * camera original. Also multer's buffering cap for the upload, so nothing bigger is held in memory.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** The kinds of image a profile photo may be (user_avatar_mime_type_check). */
export type AvatarMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * What the bytes are, read off their first bytes — never the type the client declared, which is the
 * one every client is then told to draw. Null for anything that is not a JPEG, PNG or WebP image.
 */
export function sniffAvatarType(data: Uint8Array): AvatarMimeType | null {
  const has = (bytes: number[], at = 0) =>
    data.length >= at + bytes.length && bytes.every((b, i) => data[at + i] === b);
  if (has([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** An uploaded photo as it is stored, or the HTTP refusal for one that is missing, too big or not an
 *  image. */
export function readAvatar(file: UploadedFile | undefined): { mimeType: AvatarMimeType; data: Uint8Array<ArrayBuffer> } {
  if (!file || file.size <= 0) throw new BadRequestException('a photo is required');
  if (file.size > AVATAR_MAX_BYTES) {
    throw new PayloadTooLargeException(`the photo exceeds ${AVATAR_MAX_BYTES} bytes`);
  }
  const mimeType = sniffAvatarType(file.buffer);
  if (!mimeType) throw new BadRequestException('the photo must be a JPEG, PNG or WebP image');
  return { mimeType, data: toBytes(file.buffer) };
}

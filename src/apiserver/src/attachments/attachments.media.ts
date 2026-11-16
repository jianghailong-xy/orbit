import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/**
 * Hard cap on a single upload. Bounds the stored file (and the inbox payload that later
 * references it), the temporary file an upload is written to, and — for an uploaded file the
 * runner writes to the worktree — the disk it can consume. Kept in sync with the nginx
 * `client_max_body_size` in front of the API.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The subset of a multer memory-storage file an upload held in memory reads (the profile photo;
 * attachments stream to disk, files/file-upload-storage.ts). Declared locally so we don't depend
 * on @types/multer (not installed) just for this shape.
 */
export interface UploadedFile {
  mimetype: string;
  size: number;
  buffer: Buffer;
  /** Original client filename; used to name a non-image upload written to the worktree. */
  originalname: string;
}

/**
 * Re-view a Node `Buffer` as the `Uint8Array<ArrayBuffer>` Prisma 7 types a `Bytes` column
 * as. A `Buffer` already *is* a `Uint8Array`, but it is typed over `ArrayBufferLike`, which
 * TypeScript will not narrow on its own. The view shares the bytes — no copy.
 */
export function toBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * Validate an incoming upload, throwing the HTTP-mapped exception on rejection. Any MIME
 * type is accepted — the runner dispatches on it (image/PDF inlined as content blocks,
 * everything else written to the worktree). Pure (no I/O, no DI) so it can be unit-tested
 * without booting Nest or a database.
 */
export function assertValidUpload(
  file: Pick<UploadedFile, 'size'> | undefined,
): void {
  if (!file) throw new BadRequestException('file is required');
  if (file.size <= 0) throw new BadRequestException('empty file');
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeException(`file exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }
}

/**
 * The images a composer sends as inline pictures, and their cap: the owner's composers check these before an upload
 * (web WorkspaceView ALLOWED_IMAGE_TYPES / MAX_IMAGE_BYTES), and the guest door holds a guest's upload to them
 * (session-guests.service.ts uploadImage), so a guest's image is what an owner's could be.
 */
export const COMPOSER_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_COMPOSER_IMAGE_BYTES = 5 * 1024 * 1024;
export const GUEST_IMAGE_TYPE_REFUSED = 'A guest can attach PNG, JPEG, WebP or GIF images only.';
export const GUEST_IMAGE_TOO_LARGE = 'Image exceeds the 5MB limit';

/** Whether the first bytes of a file are what `type`, one of COMPOSER_IMAGE_TYPES, begins with. */
export function imageBytesMatch(type: string, head: Uint8Array): boolean {
  const at = (offset: number, ascii: string) =>
    [...ascii].every((ch, i) => head[offset + i] === ch.charCodeAt(0));
  switch (type) {
    case 'image/png':
      return head[0] === 0x89 && at(1, 'PNG\r\n\x1a\n');
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/gif':
      return at(0, 'GIF87a') || at(0, 'GIF89a');
    case 'image/webp':
      return at(0, 'RIFF') && at(8, 'WEBP');
    default:
      return false;
  }
}

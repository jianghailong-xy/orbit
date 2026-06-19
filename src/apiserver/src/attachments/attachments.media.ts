import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/**
 * Hard cap on a single upload. Pasted screenshots sit well under this; the limit keeps
 * the in-DB blob (and the inbox payload that later references it) bounded, and caps the
 * memory a single multipart request can buffer.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * MIME types we accept: the image formats Claude takes as content blocks and that a
 * browser realistically produces from a paste/upload. Anything else is rejected up front.
 */
export const ALLOWED_IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/**
 * The subset of a multer file the upload path reads. Declared locally so we don't depend
 * on @types/multer (not installed) just for a three-field shape.
 */
export interface UploadedFile {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Validate an incoming upload, throwing the HTTP-mapped exception on rejection. Pure (no
 * I/O, no DI) so the guard logic can be unit-tested without booting Nest or a database.
 */
export function assertValidImageUpload(
  file: Pick<UploadedFile, 'mimetype' | 'size'> | undefined,
): void {
  if (!file) throw new BadRequestException('file is required');
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    throw new BadRequestException(`unsupported image type: ${file.mimetype}`);
  }
  if (file.size <= 0) throw new BadRequestException('empty file');
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeException(`image exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }
}

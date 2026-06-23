import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/**
 * Hard cap on a single upload. Bounds the in-DB blob (and the inbox payload that later
 * references it), the memory a multipart request buffers, and — for an uploaded file the
 * runner writes to the worktree — the disk it can consume. Kept in sync with the nginx
 * `client_max_body_size` in front of the API.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The subset of a multer file the upload path reads. Declared locally so we don't depend
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

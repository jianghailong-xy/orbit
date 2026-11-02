import type { Readable } from 'node:stream';
import {
  filesDirFrom,
  removeTempFile,
  uploadTempDir,
  writeHashedTempFile,
  type HashedTempFile,
} from './file-store';

/**
 * An uploaded file as `FILE_UPLOAD_STORAGE` hands it to a route: written to a temporary file under the
 * files directory and hashed on the way, with the name and type the client gave it. Never a buffer.
 */
export interface FileUpload extends HashedTempFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
}

/** The part of multer's file object a storage engine is handed. */
interface IncomingFilePart {
  stream: Readable;
  path?: string;
}

/**
 * The multer storage engine of the attachment upload routes (`POST /attachments`, `POST
 * /runner/sessions/:id/attachments`), in place of multer's memory storage: each file part is streamed to a
 * temporary file in `<files dir>/tmp/` and hashed as it arrives (docs/orbit-files-design.md §2.1), so an
 * upload is never held in memory whole — the route then keeps it in the file store (FilesService.store)
 * or, on any refusal, removes it (FilesService.discard).
 *
 * The temporary directory is read per upload, from ORBIT_FILES_DIR, as FilesService reads it. multer's
 * `limits.fileSize` still bounds an upload: past it busboy ends the part, multer answers 413 and removes the
 * file through `_removeFile`. `onPath` sets `file.path` before the first byte is written, so a request
 * aborted mid-upload is cleaned up by multer as well as by the failed write.
 */
export function fileUploadStorage(tempDir: () => string = () => uploadTempDir(filesDirFrom())) {
  return {
    _handleFile(
      _request: unknown,
      file: IncomingFilePart,
      callback: (error: Error | null, info?: HashedTempFile) => void,
    ): void {
      writeHashedTempFile(file.stream, tempDir(), (tempPath) => {
        file.path = tempPath;
      }).then(
        (written) => callback(null, written),
        (error: Error) => callback(error),
      );
    },
    _removeFile(_request: unknown, file: { path?: string }, callback: (error: Error | null) => void): void {
      (file.path ? removeTempFile(file.path) : Promise.resolve()).then(() => callback(null), callback);
    },
  };
}

/** The one engine both upload routes use. */
export const FILE_UPLOAD_STORAGE = fileUploadStorage();

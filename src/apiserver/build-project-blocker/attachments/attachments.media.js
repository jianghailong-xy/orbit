"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_UPLOAD_BYTES = void 0;
exports.toBytes = toBytes;
exports.assertValidUpload = assertValidUpload;
const common_1 = require("@nestjs/common");
/**
 * Hard cap on a single upload. Bounds the in-DB blob (and the inbox payload that later
 * references it), the memory a multipart request buffers, and — for an uploaded file the
 * runner writes to the worktree — the disk it can consume. Kept in sync with the nginx
 * `client_max_body_size` in front of the API.
 */
exports.MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/**
 * Re-view a Node `Buffer` as the `Uint8Array<ArrayBuffer>` Prisma 7 types a `Bytes` column
 * as. A `Buffer` already *is* a `Uint8Array`, but it is typed over `ArrayBufferLike`, which
 * TypeScript will not narrow on its own. The view shares the bytes — no copy.
 */
function toBytes(buffer) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
/**
 * Validate an incoming upload, throwing the HTTP-mapped exception on rejection. Any MIME
 * type is accepted — the runner dispatches on it (image/PDF inlined as content blocks,
 * everything else written to the worktree). Pure (no I/O, no DI) so it can be unit-tested
 * without booting Nest or a database.
 */
function assertValidUpload(file) {
    if (!file)
        throw new common_1.BadRequestException('file is required');
    if (file.size <= 0)
        throw new common_1.BadRequestException('empty file');
    if (file.size > exports.MAX_UPLOAD_BYTES) {
        throw new common_1.PayloadTooLargeException(`file exceeds ${exports.MAX_UPLOAD_BYTES} bytes`);
    }
}
//# sourceMappingURL=attachments.media.js.map
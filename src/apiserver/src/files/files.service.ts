import { Inject, Injectable, Logger, NotFoundException, Optional, StreamableFile } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import {
  LocalFileStore,
  filesConfigFrom,
  removeTempFile,
  uploadTempDir,
  writeHashedTempFile,
  type FileStorage,
  type FileStore,
  type FilesConfig,
  type HashedTempFile,
} from './file-store';
import type { FileUpload } from './file-upload-storage';
import { S3FileStore } from './s3-file-store';
import { attachmentDisposition, inlineType } from './user-file-response';

/** A FilesConfig to use instead of the environment's; nothing provides one but a spec. */
export const FILES_CONFIG = Symbol('FILES_CONFIG');

/** An attachment's bytes, ready to be answered with. */
export interface OpenedFile {
  /** A stream from the file store, or the bytes of a row from before Orbit Files. */
  content: Readable | Buffer;
  mimeType: string;
  sizeBytes: number;
  fileName: string | null;
}

/**
 * Orbit Files' storage layer (docs/orbit-files-design.md §2.1): an attachment row describes a file, and
 * its bytes are kept once per content in a file store — the files directory, or an S3-compatible bucket —
 * under their sha256, with a `file_blob` row saying which. Every attachment upload is kept here; every read
 * of an attachment's bytes comes through `open`, which serves a row from before Orbit Files from its own
 * `data` column until those rows are moved.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  readonly config: FilesConfig;
  private readonly local: LocalFileStore;
  private readonly s3: S3FileStore | null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(FILES_CONFIG) config?: FilesConfig,
  ) {
    this.config = config ?? filesConfigFrom();
    this.local = new LocalFileStore(this.config.dir);
    this.s3 = this.config.s3 ? new S3FileStore(this.config.s3) : null;
  }

  /** The store new bytes go to. */
  private get target(): FileStore {
    return this.s3 ?? this.local;
  }

  private storeOf(storage: string): FileStore | null {
    if (storage === 'local') return this.local;
    if (storage === 's3') return this.s3;
    return null;
  }

  /**
   * Keep a hashed temporary file's bytes and return their sha256. When the same bytes are already kept,
   * the file is dropped and nothing is written but the file_blob row's `lastReferencedAt`; otherwise it
   * moves into the store new bytes go to. Either way the temporary file is gone afterwards, and the
   * file_blob row exists before the caller writes a row that names it.
   */
  async store(file: HashedTempFile): Promise<string> {
    const { sha256, size } = file;
    const known = await this.prisma.fileBlob.findUnique({ where: { sha256 }, select: { storage: true } });
    const holder = known ? this.storeOf(known.storage) : null;
    let storage: FileStorage;
    if (holder && (await holder.has(sha256))) {
      await removeTempFile(file.path);
      storage = holder.storage;
    } else {
      // New bytes, or bytes whose row outlived them (a files directory restored older than the database):
      // kept again, where new bytes go.
      await this.target.put(sha256, file.path, size);
      storage = this.target.storage;
    }
    const now = new Date();
    await this.prisma.fileBlob.upsert({
      where: { sha256 },
      create: { sha256, sizeBytes: size, storage, lastReferencedAt: now },
      update: { storage, lastReferencedAt: now },
    });
    return sha256;
  }

  /** Keep bytes a caller already holds (each caller's are bounded by MAX_UPLOAD_BYTES). */
  async storeBytes(data: Uint8Array): Promise<string> {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const temp = await writeHashedTempFile(Readable.from([bytes]), uploadTempDir(this.config.dir));
    try {
      return await this.store(temp);
    } finally {
      await removeTempFile(temp.path);
    }
  }

  /** A new attachment row for an upload the route has accepted: the bytes kept, then the row naming them. */
  async createAttachment(
    upload: FileUpload,
    scope: { ownerId: string; sessionId?: string | null; taskId?: string | null },
  ): Promise<{ id: string }> {
    const sha256 = await this.store(upload);
    return this.prisma.attachment.create({
      data: {
        ownerId: scope.ownerId,
        sessionId: scope.sessionId ?? null,
        taskId: scope.taskId ?? null,
        mimeType: upload.mimetype,
        sizeBytes: upload.size,
        fileName: upload.originalname || null,
        sha256,
      },
      select: { id: true },
    });
  }

  /**
   * The bytes of the attachment row `where` finds — `where` says whose it may be, which is the caller's
   * to decide — or null when it finds none. From the store the row's sha256 names, or, for a row whose bytes
   * are not in one, from its `data`.
   */
  async open(where: Prisma.AttachmentWhereInput): Promise<OpenedFile | null> {
    const row = await this.prisma.attachment.findFirst({
      where,
      select: {
        id: true,
        mimeType: true,
        fileName: true,
        sha256: true,
        blob: { select: { storage: true, sizeBytes: true } },
      },
    });
    if (!row) return null;
    const { mimeType, fileName } = row;
    if (row.sha256 && row.blob) {
      const content = await this.storeOf(row.blob.storage)?.open(row.sha256);
      if (content) return { content, mimeType, fileName, sizeBytes: row.blob.sizeBytes };
    }
    const legacy = await this.prisma.attachment.findUnique({ where: { id: row.id }, select: { data: true } });
    if (legacy?.data) {
      const data = Buffer.from(legacy.data);
      return { content: data, mimeType, fileName, sizeBytes: data.length };
    }
    this.logger.error(
      `attachment ${row.id} names bytes ${row.sha256} that the ${row.blob?.storage ?? 'configured'} file store does not hold`,
    );
    throw new NotFoundException('attachment bytes are missing');
  }

  /** The whole of an attachment's bytes, for a caller that hands them on in one piece. */
  async read(where: Prisma.AttachmentWhereInput): Promise<{ data: Buffer; mimeType: string } | null> {
    const file = await this.open(where);
    if (!file) return null;
    if (Buffer.isBuffer(file.content)) return { data: file.content, mimeType: file.mimeType };
    const chunks: Buffer[] = [];
    for await (const chunk of file.content) chunks.push(chunk as Buffer);
    return { data: Buffer.concat(chunks), mimeType: file.mimeType };
  }

  /**
   * The sha256 a copy of the attachment row `row` names, so that a copy is a row and never the bytes again:
   * the row's own, or — for a row whose bytes are still in `data` — that of those bytes once they are kept,
   * written onto the row so that the next copy reads it there.
   */
  async referenceOf(row: { id: string; sha256: string | null }): Promise<string> {
    if (row.sha256) return row.sha256;
    const legacy = await this.prisma.attachment.findUnique({ where: { id: row.id }, select: { data: true, sha256: true } });
    if (!legacy) throw new NotFoundException('attachment not found');
    if (legacy.sha256) return legacy.sha256;
    // attachment_bytes_present: a row that names no bytes in the store has them in `data`.
    const sha256 = await this.storeBytes(legacy.data as Uint8Array);
    await this.prisma.attachment.updateMany({ where: { id: row.id, sha256: null }, data: { sha256 } });
    return sha256;
  }
}

/**
 * An opened file as a download route answers it: typed and sized, inline only when its type may be shown
 * (UserFileResponseInterceptor) and otherwise saved under its own name. With the route's response, a
 * stream from the store is ended when the response closes, so a client that leaves early does not hold a
 * file or a connection to the bucket open.
 */
export function streamable(file: OpenedFile, response?: Pick<Response, 'once'>): StreamableFile {
  const { content } = file;
  const disposition = inlineType(file.mimeType) ? 'inline' : attachmentDisposition(file.fileName ?? 'attachment');
  const options = { type: file.mimeType, disposition, length: file.sizeBytes };
  if (Buffer.isBuffer(content)) return new StreamableFile(content, options);
  response?.once('close', () => content.destroy());
  return new StreamableFile(content, options);
}

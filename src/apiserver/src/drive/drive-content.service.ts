import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { DRIVE_ENTRY_NOT_FOUND, DRIVE_NOT_A_FILE, DRIVE_VERSION_NOT_FOUND } from './drive.service';

/** What the download route answers: the status, the headers and the bytes of the requested range. */
export interface DriveContent {
  status: 200 | 206 | 304 | 416;
  headers: Record<string, string>;
  stream: Readable | null;
}

type Span = { start: number; end: number };

/**
 * One `Range: bytes=…` header against a content of `size` bytes: the span to serve, `null` when the header names no
 * single range (absent, another unit, several ranges: the whole content is served, as RFC 9110 allows), or `'unsatisfiable'`.
 */
export function parseRange(header: string | undefined, size: number): Span | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (size === 0) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (!Number.isSafeInteger(start) || start >= size || end < start) return 'unsatisfiable';
  }
  return { start, end };
}

/**
 * The owner's downloads (docs/orbit-files-drive-technical-design.md §4.1): a file's current version, or one named
 * version, streamed chunk by chunk with `Range`, so no byte range is ever read whole into memory and no file whole to disk.
 */
@Injectable()
export class DriveContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  /** The current version of a live file of `ownerId`'s. The ETag is `"<versionId>.<seq>"`, which changes on an append too. */
  async ofEntry(ownerId: string, entryId: string, request: { range?: string; ifRange?: string; ifNoneMatch?: string }) {
    const entry = await this.prisma.driveEntry.findFirst({ where: { id: entryId, ownerId, trashedAt: null } });
    if (!entry) throw new HttpException({ code: DRIVE_ENTRY_NOT_FOUND, message: 'No such file or folder.' }, HttpStatus.NOT_FOUND);
    if (entry.kind !== 'FILE' || !entry.currentVersionId) {
      throw new HttpException({ code: DRIVE_NOT_A_FILE, message: 'A folder has no content to download.' }, HttpStatus.CONFLICT);
    }
    return this.serve(ownerId, entry.currentVersionId, `"${entry.currentVersionId}.${entry.seq}"`, entry.name, request);
  }

  /** One version of `ownerId`'s, current or replaced. */
  async ofVersion(ownerId: string, versionId: string, request: { range?: string; ifRange?: string; ifNoneMatch?: string }) {
    const version = await this.prisma.driveVersion.findFirst({ where: { id: versionId, ownerId }, include: { entry: { select: { name: true } } } });
    if (!version) throw new HttpException({ code: DRIVE_VERSION_NOT_FOUND, message: 'No such version.' }, HttpStatus.NOT_FOUND);
    return this.serve(ownerId, version.id, `"${version.id}"`, version.entry.name, request, version);
  }

  private async serve(
    ownerId: string,
    versionId: string,
    etag: string,
    name: string,
    request: { range?: string; ifRange?: string; ifNoneMatch?: string },
    loaded?: { sizeBytes: bigint },
  ): Promise<DriveContent> {
    const version = loaded ?? (await this.prisma.driveVersion.findFirstOrThrow({ where: { id: versionId, ownerId } }));
    const size = Number(version.sizeBytes);
    const base = {
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-cache',
    };
    if (request.ifNoneMatch && request.ifNoneMatch.split(',').some((t) => t.trim() === etag || t.trim() === '*')) {
      return { status: 304, headers: { ETag: etag }, stream: null };
    }
    const asked = request.ifRange && request.ifRange.trim() !== etag ? null : parseRange(request.range, size);
    if (asked === 'unsatisfiable') {
      return { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` }, stream: null };
    }
    const span = asked ?? { start: 0, end: size - 1 };
    const rows = size === 0 ? [] : await this.prisma.driveVersionChunk.findMany({
      where: { versionId, ownerId, offset: { lte: BigInt(span.end) } },
      orderBy: { idx: 'asc' },
    });
    const wanted = rows.filter((c) => Number(c.offset) + c.sizeBytes > span.start);
    const stream = Readable.from(this.read(wanted, span));
    const headers = { ...base, 'Content-Length': String(size === 0 ? 0 : span.end - span.start + 1) };
    if (asked) return { status: 206, headers: { ...headers, 'Content-Range': `bytes ${span.start}-${span.end}/${size}` }, stream };
    return { status: 200, headers, stream };
  }

  private async *read(chunks: Array<{ sha256: string; offset: bigint; sizeBytes: number }>, span: Span): AsyncGenerator<Buffer> {
    for (const chunk of chunks) {
      const offset = Number(chunk.offset);
      const start = Math.max(span.start, offset) - offset;
      const end = Math.min(span.end, offset + chunk.sizeBytes - 1) - offset;
      const blob = await this.prisma.fileBlob.findUnique({ where: { sha256: chunk.sha256 }, select: { storage: true } });
      const content = blob ? await this.files.storeOf(blob.storage)?.open(chunk.sha256, { start, end }) : null;
      if (!content) throw new Error(`the bytes of chunk ${chunk.sha256} are not kept`);
      for await (const part of content) yield part as Buffer;
    }
  }
}

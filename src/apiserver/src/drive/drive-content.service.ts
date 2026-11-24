import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { findCredentialInReads } from '../files/file-secret-scan';
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

/** How much of a version the share check reads (docs/drive-technical-design.md §9): the evidence scan's bound. */
export const SHARE_CHECK_MAX_BYTES = 25 * 1024 * 1024;
/** How long the share check may take before it answers with what it has read. */
export const SHARE_CHECK_MAX_MS = 20_000;

export interface ShareCheck {
  /** What looks like a credential, and where; empty when nothing did. The credential itself is never in here. */
  warnings: { kind: string; line: number }[];
  /** How many bytes were read. */
  checkedBytes: number;
  /** The version is longer than what was read, so the rest was not checked. */
  partial: boolean;
}

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
 * The owner's downloads (docs/drive-technical-design.md §4.1): a file's current version, or one named
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
    const stream = await this.streamOf(ownerId, versionId, size, span);
    const headers = { ...base, 'Content-Length': String(size === 0 ? 0 : span.end - span.start + 1) };
    if (asked) return { status: 206, headers: { ...headers, 'Content-Range': `bytes ${span.start}-${span.end}/${size}` }, stream };
    return { status: 200, headers, stream };
  }

  /** The bytes of `span` of a version of `size` bytes, chunk by chunk: the one path the owner's download and a share link read through. */
  private async streamOf(ownerId: string, versionId: string, size: number, span: Span): Promise<Readable> {
    const rows = size === 0 ? [] : await this.prisma.driveVersionChunk.findMany({
      where: { versionId, ownerId, offset: { lte: BigInt(span.end) } },
      orderBy: { idx: 'asc' },
    });
    const wanted = rows.filter((c) => Number(c.offset) + c.sizeBytes > span.start);
    return Readable.from(this.read(wanted, span));
  }

  /**
   * The bytes of `versionId` — `span` of them, inclusive, when given — for a caller that has already decided the
   * version may be read (a share link pinned to it, the share check). Another account's version is not found.
   */
  async open(ownerId: string, versionId: string, span?: Span): Promise<{ content: Readable; sizeBytes: number }> {
    const version = await this.prisma.driveVersion.findFirst({ where: { id: versionId, ownerId }, select: { sizeBytes: true } });
    if (!version) throw new HttpException({ code: DRIVE_VERSION_NOT_FOUND, message: 'No such version.' }, HttpStatus.NOT_FOUND);
    const sizeBytes = Number(version.sizeBytes);
    return { content: await this.streamOf(ownerId, versionId, sizeBytes, span ?? { start: 0, end: sizeBytes - 1 }), sizeBytes };
  }

  /**
   * The secret scan before sharing (§9): the shapes `file-secret-scan.ts` knows, over the first 25 MiB of the version for
   * at most 20 s, with an overlap carried between reads so a key that spans two is found. A binary file is not scanned. A
   * match is a warning naming the shape and the line; sharing is never refused by it.
   */
  async shareCheck(ownerId: string, versionId: string): Promise<ShareCheck> {
    const { content, sizeBytes } = await this.open(ownerId, versionId);
    const deadline = Date.now() + SHARE_CHECK_MAX_MS;
    const iterator = content[Symbol.asyncIterator]();
    let spare: Buffer = Buffer.alloc(0);
    let checkedBytes = 0;
    let timedOut = false;
    try {
      const found = await findCredentialInReads(async (window, at, length) => {
        const wanted = Math.min(length, SHARE_CHECK_MAX_BYTES - checkedBytes);
        let filled = 0;
        while (filled < wanted) {
          if (Date.now() > deadline) {
            timedOut = true;
            break;
          }
          if (spare.length === 0) {
            const next = await iterator.next();
            if (next.done) break;
            spare = next.value as Buffer;
          }
          const take = Math.min(spare.length, wanted - filled);
          spare.copy(window, at + filled, 0, take);
          spare = spare.subarray(take);
          filled += take;
        }
        checkedBytes += filled;
        return filled;
      });
      return { warnings: found ? [found] : [], checkedBytes, partial: timedOut || checkedBytes < sizeBytes };
    } finally {
      content.destroy();
    }
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

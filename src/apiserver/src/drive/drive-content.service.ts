import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { findCredentialInReads } from '../files/file-secret-scan';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { DRIVE_VERSION_NOT_FOUND } from './drive.service';

/** How much of a version the share check reads (docs/orbit-files-drive-technical-design.md §9): the evidence scan's bound. */
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

/** The bytes of one drive version, in order, and what is built on reading them. */
@Injectable()
export class DriveContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  /**
   * The bytes of `versionId` — `range` of them, inclusive, when given — read chunk by chunk from the file store, so no more
   * than one chunk is ever held. Another account's version is not found.
   */
  async open(ownerId: string, versionId: string, range?: { start: number; end: number }): Promise<{ content: Readable; sizeBytes: number }> {
    const version = await this.prisma.driveVersion.findFirst({
      where: { id: versionId, ownerId },
      select: {
        sizeBytes: true,
        chunks: { orderBy: { idx: 'asc' }, select: { offset: true, sizeBytes: true, sha256: true, blob: { select: { storage: true } } } },
      },
    });
    if (!version) throw new HttpException({ code: DRIVE_VERSION_NOT_FOUND, message: 'No such version.' }, HttpStatus.NOT_FOUND);
    const sizeBytes = Number(version.sizeBytes);
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? sizeBytes - 1, sizeBytes - 1);
    const files = this.files;
    async function* read(): AsyncGenerator<Buffer> {
      for (const chunk of version!.chunks) {
        const from = Number(chunk.offset);
        const to = from + chunk.sizeBytes - 1;
        if (to < start) continue;
        if (from > end) return;
        const piece = await files.storeOf(chunk.blob.storage)?.open(chunk.sha256, { start: Math.max(start, from) - from, end: Math.min(end, to) - from });
        if (!piece) throw new Error(`the bytes of drive chunk ${chunk.sha256} are not in the ${chunk.blob.storage} file store`);
        for await (const part of piece) yield part as Buffer;
      }
    }
    return { content: Readable.from(sizeBytes === 0 ? [] : read(), { objectMode: false }), sizeBytes };
  }

  /**
   * The secret scan before sharing (§9): the shapes `file-secret-scan.ts` knows, over the first 25 MiB of the version for at
   * most 20 s, with an overlap carried between reads so a key that spans two is found. A binary file is not scanned. A match
   * is a warning naming the shape and the line; sharing is never refused by it.
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
      return {
        warnings: found ? [found] : [],
        checkedBytes,
        partial: timedOut || checkedBytes < sizeBytes,
      };
    } finally {
      content.destroy();
    }
  }
}

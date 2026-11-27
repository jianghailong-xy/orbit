import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { DRIVE_CHUNK_MAX, DriveChunksService } from './drive-chunks.service';
import { assertDriveName, DriveService, OWNER_WRITER } from './drive.service';

export const DRIVE_UPLOAD_INCOMPLETE = 'DRIVE_UPLOAD_INCOMPLETE';
export const DRIVE_UPLOAD_INVALID = 'DRIVE_UPLOAD_INVALID';
/** The advisory-lock namespace that serialises the completes of one upload (key: the staging id). */
const UPLOAD_COMPLETE_LOCK_NAMESPACE = 4001329;
const UPLOAD_COMPLETE_TRANSACTION = { timeout: 120_000, maxWait: 10_000 };
const UPLOAD_NOT_FOUND = 'DRIVE_UPLOAD_NOT_FOUND';

function refusal(status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}): HttpException {
  return new HttpException({ code, message, ...extra }, status);
}
const notFound = () => refusal(HttpStatus.NOT_FOUND, UPLOAD_NOT_FOUND, 'No such upload in progress.');

/**
 * The owner's resumable upload (docs/drive-technical-design.md §4.1): open a staging, send its chunks one
 * request each (DriveChunksService.putChunk), ask which have arrived, and complete, which creates the file and commits it
 * through DriveService.commit, keyed by the staging id so a retry never makes a second file. Every call takes the owner
 * from the credential; another account's upload is not found.
 */
@Injectable()
export class DriveUploadsService {
  private readonly logger = new Logger(DriveUploadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly drive: DriveService,
    private readonly chunks: DriveChunksService,
  ) {}

  /**
   * Open an upload of `size` bytes named `name` into `parentId` (the root when absent). `relativePath` (a dropped file's
   * `Dir/sub/name`) places it in folders made as needed: the first folder of a drop is made once, with a suffix when its
   * name is taken, and the answer's `dropRootId` is what the rest of the drop sends back so they share it.
   */
  async open(
    ownerId: string,
    input: { parentId?: string | null; name: string; size: number; relativePath?: string | null; dropRootId?: string | null },
  ) {
    const name = assertDriveName(input.name);
    if (!Number.isSafeInteger(input.size) || input.size < 0) {
      throw refusal(HttpStatus.BAD_REQUEST, DRIVE_UPLOAD_INVALID, 'The size of an upload is a whole number of bytes, 0 or more.');
    }
    let parentId = input.parentId ?? null;
    let dropRootId: string | null = null;
    if (input.relativePath) {
      const folders = input.relativePath.split('/').filter((s) => s.length > 0).slice(0, -1);
      if (folders.length > 0) {
        folders.forEach(assertDriveName);
        if (input.dropRootId) {
          dropRootId = (await this.drive.ensureFolderPath(ownerId, input.dropRootId, [])).id;
        } else {
          dropRootId = (await this.drive.createFolder(ownerId, { parentId, name: folders[0], onClash: 'SUFFIX' })).id;
        }
        parentId = (await this.drive.ensureFolderPath(ownerId, dropRootId, folders.slice(1))).id;
      }
    }
    if (parentId === null) parentId = (await this.drive.ensureRoot(ownerId)).id;
    else await this.drive.ensureFolderPath(ownerId, parentId, []);
    const staging = await this.chunks.openStaging(ownerId, {
      source: 'OWNER_UPLOAD', parentId, name, relativePath: input.relativePath ?? null, declaredSize: input.size,
    });
    return { id: staging.id, chunkSize: DRIVE_CHUNK_MAX, parentId, name, dropRootId };
  }

  /** Which chunks have arrived: what makes an upload resumable after a reload or a lost connection. */
  async status(ownerId: string, id: string) {
    const staging = await this.find(ownerId, id);
    const done = await this.prisma.driveCommit.findUnique({ where: { ownerId_commitId: { ownerId, commitId: id } } });
    return {
      id: staging.id,
      name: staging.name,
      parentId: staging.parentId,
      size: Number(staging.declaredSize ?? 0),
      chunkSize: DRIVE_CHUNK_MAX,
      chunks: staging.chunks.map((c) => ({ idx: c.idx, sha256: c.sha256, sizeBytes: c.sizeBytes })),
      completed: done !== null,
      entryId: done?.entryId ?? null,
    };
  }

  /**
   * Create the file and commit the chunks. Sent again after it applied, it answers the same file. The completes of one
   * upload run one at a time: a transaction takes a per-upload advisory lock and holds it while the file is created and
   * committed on their own connections, so a second complete (a retry after a timeout, say) waits, then finds the
   * first's commit answer and returns its file.
   */
  async complete(ownerId: string, id: string) {
    await this.find(ownerId, id);
    return withTransactionRetry(this.prisma, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${UPLOAD_COMPLETE_LOCK_NAMESPACE}, hashtext(${id}))`;
      return this.completeLocked(ownerId, id);
    }, loggedRetry(this.logger, 'drive.completeUpload', { transaction: UPLOAD_COMPLETE_TRANSACTION }));
  }

  private async completeLocked(ownerId: string, id: string) {
    const staging = await this.find(ownerId, id);
    const answered = await this.prisma.driveCommit.findUnique({ where: { ownerId_commitId: { ownerId, commitId: id } } });
    if (answered) return this.drive.get(ownerId, answered.entryId);

    const size = Number(staging.declaredSize ?? 0);
    const expected = Math.ceil(size / DRIVE_CHUNK_MAX);
    const have = new Map(staging.chunks.map((c) => [c.idx, c]));
    const missing: number[] = [];
    for (let idx = 0; idx < expected; idx += 1) {
      const want = Math.min(DRIVE_CHUNK_MAX, size - idx * DRIVE_CHUNK_MAX);
      if (have.get(idx)?.sizeBytes !== want) missing.push(idx);
    }
    if (missing.length > 0 || staging.chunks.length !== expected) {
      throw refusal(
        HttpStatus.CONFLICT,
        DRIVE_UPLOAD_INCOMPLETE,
        `The upload is not complete: send chunks ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''} (of ${expected}, each ${DRIVE_CHUNK_MAX} bytes but the last), then complete it again.`,
        { missing: missing.slice(0, 100), expected },
      );
    }
    const existing = await this.prisma.driveVersion.findFirst({ where: { ownerId, handleId: id }, select: { id: true, entryId: true } });
    let entryId: string;
    let versionId: string;
    if (existing) {
      ({ entryId, id: versionId } = existing);
    } else {
      const created = await this.drive.createFile(ownerId, {
        parentId: staging.parentId, name: staging.name ?? 'upload', handleId: id, onClash: 'SUFFIX',
      });
      entryId = created.id;
      versionId = created.currentVersionId!;
    }
    await this.drive.commit(ownerId, {
      commitId: id,
      entryId,
      handleId: id,
      mode: 'CONTINUE',
      baseVersionId: versionId,
      chunks: staging.chunks.map((c) => ({ idx: c.idx, sha256: c.sha256, size: c.sizeBytes })),
      stagingId: id,
      writer: OWNER_WRITER,
    });
    return this.drive.get(ownerId, entryId);
  }

  /** The upload is this owner's, still open: the first thing a chunk request is asked, whatever else it carries. */
  async assertOpen(ownerId: string, id: string): Promise<void> {
    const found = await this.prisma.driveStaging.findFirst({ where: { id, ownerId, source: 'OWNER_UPLOAD', committedAt: null }, select: { id: true } });
    if (!found) throw notFound();
  }

  /** Abandon: the staging and its chunk rows go; the bytes go with the retention sweep. */
  async abandon(ownerId: string, id: string): Promise<{ deleted: true }> {
    await this.find(ownerId, id);
    await this.prisma.driveStaging.deleteMany({ where: { id, ownerId, source: 'OWNER_UPLOAD' } });
    return { deleted: true };
  }

  private async find(ownerId: string, id: string) {
    const staging = await this.prisma.driveStaging.findFirst({
      where: { id, ownerId, source: 'OWNER_UPLOAD' },
      include: { chunks: { orderBy: { idx: 'asc' } } },
    });
    if (!staging) throw notFound();
    return staging;
  }
}

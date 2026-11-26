import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  GoneException,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Runner } from '@prisma/client';
import type { Request, Response } from 'express';
import { PublicIdPipe } from '../common/public-id';
import { FilesService } from '../files/files.service';
import type { ManagedRunnerInstance } from '../managed-runners/managed-runner-instance';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentManagedRunnerInstance, CurrentRunner } from '../runner-api/current-runner.decorator';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { DriveChunksService } from './drive-chunks.service';
import { DriveChatTurnFull, type DriveChatTurn } from './drive-chat-change-record';
import { DriveChatChanges, type DriveChatHeldOp } from './drive-chat-changes';
import { AcceptsDriveMountCredential, CurrentDriveMount, fenceManagedInstance, type DriveMount } from './drive-mount-credential';
import { RUNNER_DRIVE_ROUTE_PREFIXES } from './drive-routes';
import { DriveEnabledGuard } from './drive-switch';
import { DRIVE_NAME_TAKEN, drivePathSegments, DriveService, type DriveEntryRow, type DriveWriter } from './drive.service';
import {
  RunnerDriveBatchDto,
  RunnerDriveCommitDto,
  RunnerDriveHeldDto,
  RunnerDriveCreateDto,
  RunnerDriveDeleteDto,
  RunnerDriveKeepaliveDto,
  RunnerDriveMkdirDto,
  RunnerDriveRenameDto,
  RunnerDriveStagingDto,
  RunnerDriveUtimensDto,
  type RunnerDriveWriterDto,
} from './runner-drive.dto';

/** A mount's deletes with no burst key of their own join one group while they come less than this far apart (§3.4). */
export const DRIVE_MOUNT_BURST_WINDOW_MS = 2_000;
/** The longest a change-feed poll is held open waiting for a change (§4.2). */
const CHANGES_WAIT_MAX_S = 25;
const CHANGES_POLL_MS = 1_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const DRIVE_PATH_OR_ID = 'DRIVE_PATH_OR_ID';
export const DRIVE_CHUNK_GONE = 'DRIVE_CHUNK_GONE';

function refusal(status: HttpStatus, code: string, message: string, extra: Record<string, unknown> = {}): HttpException {
  return new HttpException({ code, message, ...extra }, status);
}

/** A drive path's parent path and last name: `/Proj/r.md` is `/Proj` and `r.md`. The root has neither. */
function splitDrivePath(path: string): { parent: string; name: string } {
  const segments = drivePathSegments(path);
  if (!segments.length) throw refusal(HttpStatus.CONFLICT, 'DRIVE_ROOT', 'The root folder cannot be named here.');
  return { parent: '/' + segments.slice(0, -1).join('/'), name: segments[segments.length - 1] };
}

/** `bytes=a-b` of a chunk of `size` bytes, or undefined for the whole chunk; a range it cannot serve is 416. */
function rangeOf(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return undefined;
  let start: number;
  let end: number;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) {
    throw new HttpException({ code: 'DRIVE_RANGE_NOT_SATISFIABLE', message: `A chunk of ${size} bytes has no such range.` }, 416);
  }
  return { start, end };
}

/**
 * The runner drive door (docs/drive-technical-design.md §4.2, §4.3, §4.6): what the drive tools on every
 * runner, the runner itself (reply links, `file_upload` of a drive path) and the mount daemon on Orbit Cloud call.
 *
 *   - It takes the runner credential, with the managed-runner instance guard every runner door has, or the mount
 *     credential of one managed-runner generation (AcceptsDriveMountCredential), which no other route takes.
 *   - The owner is the credential's; another account's entry, staging, commit or chunk is not found.
 *   - It has no Trash route and no share route: agents cannot see Trash (D11) and only the owner shares (D18). A delete
 *     moves an entry to the owner's Trash, where only the owner's routes reach it.
 *   - A staging is the runner's that opened it. A managed runner's commit is fenced in its own transaction (§8.2).
 *   - A Drive chat's writes (drive-chat-changes.ts) are recorded into its turn's change group; past the turn's 200th
 *     change a new folder, a move, a rename or a move to Trash is held for the owner's Apply, and a move or rename onto a
 *     live file is refused with both files named, the owner asked Keep both or Replace.
 *
 * Every rule of a write is the name layer's (DriveService); this door only names entries by path and says who writes.
 * It answers at /runner/drive, and at /runner/documents for runners and mount daemons already deployed (drive-routes.ts).
 */
@UseGuards(RunnerAuthGuard, DriveEnabledGuard)
@AcceptsDriveMountCredential()
@Controller(RUNNER_DRIVE_ROUTE_PREFIXES)
export class RunnerDriveController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drive: DriveService,
    private readonly chunks: DriveChunksService,
    private readonly files: FilesService,
    private readonly chatChanges: DriveChatChanges,
  ) {}

  /** One live entry's attributes, `seq` and current version id. */
  @Get('stat')
  async stat(@CurrentRunner() runner: Runner, @Query('path') path?: string, @Query('id', PublicIdPipe) id?: string) {
    return this.drive.stat(runner.ownerId, await this.named(runner.ownerId, path, id));
  }

  /** A live folder's children with attributes, paged; a file of one chunk carries that chunk's sha256. */
  @Get('list')
  async list(
    @CurrentRunner() runner: Runner,
    @Query('path') path?: string,
    @Query('id', PublicIdPipe) id?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const folder = path === undefined && id === undefined
      ? await this.drive.liveAt(runner.ownerId, '/')
      : await this.named(runner.ownerId, path, id);
    return this.drive.listWithChunks(runner.ownerId, folder, {
      cursor,
      limit: limit === undefined ? undefined : Number.parseInt(limit, 10),
    });
  }

  /** A live file's current chunk list. */
  @Get('manifest')
  async manifest(@CurrentRunner() runner: Runner, @Query('path') path?: string, @Query('id', PublicIdPipe) id?: string) {
    return this.drive.manifest(runner.ownerId, await this.named(runner.ownerId, path, id));
  }

  /** One chunk's bytes, with `Range`: only a chunk this owner's versions or stagings name (§4.4). */
  @Get('chunks/:sha256')
  async chunk(
    @CurrentRunner() runner: Runner,
    @Param('sha256') sha256: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!SHA256_HEX.test(sha256) || !(await this.drive.namesChunk(runner.ownerId, sha256))) {
      throw refusal(HttpStatus.NOT_FOUND, 'DRIVE_CHUNK_NOT_FOUND', 'No such chunk.');
    }
    return this.serveBlob(sha256, range, res);
  }

  /** A new file at `path` in its live folder, with an empty first version the handle fills (§3.1). A taken name is 409. */
  @Post('create')
  async create(@CurrentRunner() runner: Runner, @Body() dto: RunnerDriveCreateDto) {
    const { parent, name } = splitDrivePath(dto.path);
    const folder = await this.drive.liveAt(runner.ownerId, parent);
    const created = await this.drive.createFile(runner.ownerId, {
      parentId: folder.id, name, handleId: dto.handleId ?? null, writer: this.writer(runner, dto.writer), onClash: 'REFUSE',
    });
    return this.drive.stat(runner.ownerId, await this.drive.liveById(runner.ownerId, created.id));
  }

  /** `mkdir`, or with `parents` `mkdir -p`. */
  @Post('mkdir')
  async mkdir(@CurrentRunner() runner: Runner, @Body() dto: RunnerDriveMkdirDto) {
    const writer = this.writer(runner, dto.writer);
    const turn = await this.chatChanges.turnOf(runner.ownerId, writer);
    // A `mkdir -p` of a folder already there changes nothing, so a full turn answers it rather than holding it.
    if (turn && dto.parents === true) {
      const there = await this.drive.liveAt(runner.ownerId, dto.path).catch(() => null);
      if (there?.kind === 'FOLDER') return this.drive.stat(runner.ownerId, there);
    }
    return this.chatWrite(turn, { op: 'MKDIR', path: dto.path, parents: dto.parents === true }, async () => {
      const made = await this.drive.mkdirPath(runner.ownerId, dto.path, { parents: dto.parents === true, writer });
      return this.drive.stat(runner.ownerId, await this.drive.liveById(runner.ownerId, made.id));
    });
  }

  /** A staging for one handle's or one tool call's write, held by this runner. */
  @Post('stagings')
  async openStaging(
    @CurrentRunner() runner: Runner,
    @CurrentDriveMount() mount: DriveMount | undefined,
    @Body() dto: RunnerDriveStagingDto,
    @CurrentManagedRunnerInstance() instance?: ManagedRunnerInstance,
  ) {
    // A batch's staging is bound to no entry: its chunks go to the files one batch makes (`batch`).
    if (!dto.entryId) {
      return this.chunks.openStaging(runner.ownerId, {
        source: mount ? 'MOUNT' : 'TOOL',
        entryId: null,
        runnerId: runner.id,
        generation: instance?.generation ?? null,
      });
    }
    const named = dto.entryId;
    let entryId: string | null = named;
    await this.drive.liveById(runner.ownerId, named).catch(async (error) => {
      // A handle bound to an entry in Trash still commits there (§3.1), so its staging opens too.
      const inTrash = await this.prisma.driveEntry.findFirst({ where: { id: named, ownerId: runner.ownerId }, select: { id: true } });
      if (inTrash) return;
      // So does one bound to a file a replacing rename removed (§3.2): its commit makes a new file in Trash, so the
      // staging is bound to no entry.
      const removed = await this.prisma.driveRemovedEntry.findUnique({
        where: { ownerId_entryId: { ownerId: runner.ownerId, entryId: named } }, select: { entryId: true },
      });
      if (!removed) throw error;
      entryId = null;
    });
    return this.chunks.openStaging(runner.ownerId, {
      source: mount ? 'MOUNT' : 'TOOL',
      entryId,
      runnerId: runner.id,
      generation: instance?.generation ?? null,
    });
  }

  /** One chunk of a staging, at most 8 MiB, with `X-Orbit-Chunk-Sha256`. Idempotent. */
  @Put('stagings/:id/chunks/:idx')
  async putChunk(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Param('idx', ParseIntPipe) idx: number,
    @Headers('x-orbit-chunk-sha256') sha256: string | undefined,
    @Req() req: Request,
  ) {
    try {
      await this.staging(runner, id);
    } catch (error) {
      req.resume();
      throw error;
    }
    return this.chunks.putChunk(runner.ownerId, id, idx, (sha256 ?? '').trim().toLowerCase(), req);
  }

  /** A chunk read back from a staging: what the mount's spool re-fetches after evicting it (§5.3). */
  @Get('stagings/:id/chunks/:idx')
  async readChunk(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Param('idx', ParseIntPipe) idx: number,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.staging(runner, id);
    const chunk = await this.prisma.driveStagingChunk.findFirst({ where: { stagingId: id, idx, ownerId: runner.ownerId } });
    if (!chunk) throw refusal(HttpStatus.NOT_FOUND, 'DRIVE_CHUNK_NOT_FOUND', `This staging has no chunk ${idx}.`);
    return this.serveBlob(chunk.sha256, range, res);
  }

  /** The handle is alive and, with `dirty`, holds bytes no commit has taken: what the sleep hold reads (§8.1). */
  @Post('stagings/:id/keepalive')
  @HttpCode(HttpStatus.OK)
  async keepalive(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string, @Body() dto: RunnerDriveKeepaliveDto) {
    await this.staging(runner, id);
    await this.prisma.driveStaging.updateMany({
      where: { id, ownerId: runner.ownerId, runnerId: runner.id, committedAt: null },
      data: { touchedAt: new Date(), dirty: dto.dirty === true },
    });
    return { ok: true };
  }

  /** One commit (§3.1, §3.2): a retried commit id is answered as the first and never applied twice. */
  @Post('commit')
  @HttpCode(HttpStatus.OK)
  async commit(
    @CurrentRunner() runner: Runner,
    @Body() dto: RunnerDriveCommitDto,
    @CurrentManagedRunnerInstance() instance?: ManagedRunnerInstance,
  ) {
    if (dto.stagingId) await this.staging(runner, dto.stagingId);
    return this.drive.commit(
      runner.ownerId,
      {
        commitId: dto.commitId,
        entryId: dto.entryId,
        handleId: dto.handleId ?? null,
        mode: dto.mode,
        baseVersionId: dto.baseVersionId ?? null,
        baseSize: dto.baseSize ?? null,
        chunks: dto.chunks,
        replaceTail: dto.replaceTail ?? null,
        stagingId: dto.stagingId ?? null,
        writer: this.writer(runner, dto.writer),
      },
      instance ? { fence: (tx) => fenceManagedInstance(tx, instance) } : {},
    );
  }

  /** Whether a commit applied, and its answer: what a writer asks after a commit it could not confirm (§5.7). */
  @Get('commits/:commitId')
  commitStatus(@CurrentRunner() runner: Runner, @Param('commitId') commitId: string) {
    return this.drive.commitStatus(runner.ownerId, commitId);
  }

  /**
   * Rename and/or move. Onto a live file it replaces it unless `noReplace` (§3.2): the target keeps its id and takes the
   * source's content as a new version, its previous one going to Trash; the answer is the target. The source is gone.
   * A Drive chat never replaces: onto a live file it is refused 409 DRIVE_CHAT_NO_OVERWRITE naming both files, and the
   * owner is asked Keep both or Replace (drive-chat-changes.ts).
   */
  @Post('rename')
  @HttpCode(HttpStatus.OK)
  async rename(@CurrentRunner() runner: Runner, @Body() dto: RunnerDriveRenameDto) {
    const source = await this.named(runner.ownerId, dto.from, dto.id);
    const { parent, name } = splitDrivePath(dto.to);
    const writer = this.writer(runner, dto.writer);
    const turn = await this.chatChanges.turnOf(runner.ownerId, writer);
    return this.chatWrite(turn, { op: 'RENAME', entryId: source.id, to: dto.to }, async () => {
      const folder = await this.drive.liveAt(runner.ownerId, parent);
      let view;
      try {
        view = await this.drive.rename(runner.ownerId, source.id, {
          name, parentId: folder.id, writer, replace: turn === null && dto.noReplace !== true,
        });
      } catch (error) {
        const code = error instanceof HttpException ? (error.getResponse() as { code?: string }).code : undefined;
        if (turn && code === DRIVE_NAME_TAKEN) {
          const asked = await this.chatChanges.overwriteRefusal(turn, source, folder, name);
          if (asked) throw asked;
        }
        throw error;
      }
      return this.drive.stat(runner.ownerId, await this.drive.liveById(runner.ownerId, view.id));
    });
  }

  /**
   * To the owner's Trash (§3.3, §3.4), a folder with everything in it. The answer names no Trash group: agents do not see
   * Trash. A mount's deletes that carry no burst key of their own are grouped by that mount, 2 s apart at most.
   */
  @Post('delete')
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentRunner() runner: Runner,
    @CurrentDriveMount() mount: DriveMount | undefined,
    @Body() dto: RunnerDriveDeleteDto,
  ) {
    const entry = await this.named(runner.ownerId, dto.path, dto.id);
    const own = dto.writer?.burstKey?.trim();
    const writer = this.writer(runner, dto.writer);
    const turn = await this.chatChanges.turnOf(runner.ownerId, writer);
    return this.chatWrite(turn, { op: 'TRASH', entryId: entry.id }, async () => {
      await this.drive.moveToTrash(runner.ownerId, entry.id, {
        writer,
        ...(own ? { burstKey: own } : mount ? { burstKey: `mount:${mount.credentialId}`, burstWindowMs: DRIVE_MOUNT_BURST_WINDOW_MS } : {}),
      });
      return { deleted: true, id: entry.id };
    });
  }

  /** `utimens`: a live entry's mtime. */
  /**
   * Which of these chunks this account already holds (docs/drive-directory-sync-design.md, "Sending what is not there
   * yet"): a writer sends only the others, and its commit names them all.
   */
  @Post('chunks/held')
  @HttpCode(HttpStatus.OK)
  async held(@CurrentRunner() runner: Runner, @Body() dto: RunnerDriveHeldDto) {
    return { held: await this.drive.heldChunks(runner.ownerId, dto.chunks) };
  }

  /**
   * Several files in one request (docs/drive-directory-sync-design.md, "Many small files"): each is made, or
   * overwritten keeping its previous version, from content the account holds, with its folders made first and its
   * modification time set. Each file is its own commit, idempotent by its commitId, and answered on its own: a file that
   * fails says why, and the others still land.
   */
  @Post('batch')
  @HttpCode(HttpStatus.OK)
  async batch(
    @CurrentRunner() runner: Runner,
    @Body() dto: RunnerDriveBatchDto,
    @CurrentManagedRunnerInstance() instance?: ManagedRunnerInstance,
  ) {
    if (dto.stagingId) await this.staging(runner, dto.stagingId);
    const writer = this.writer(runner, dto.writer);
    const results = [];
    for (const item of dto.items) {
      try {
        const { parent, name } = splitDrivePath(item.path);
        // Content the account does not hold fails this file before anything of it is made: no empty file, no folder.
        const holds = new Set(await this.drive.heldChunks(runner.ownerId, item.chunks));
        const missing = item.chunks.find((c) => !holds.has(c.sha256));
        if (missing) {
          throw refusal(HttpStatus.CONFLICT, 'DRIVE_CHUNK_NOT_HELD', `Chunk ${missing.idx} names content this account has not sent; send the chunk first.`, { idx: missing.idx });
        }
        if (parent !== '/') await this.drive.mkdirPath(runner.ownerId, parent, { parents: true, writer });
        let entry = await this.drive.liveAt(runner.ownerId, item.path).catch((error) => {
          if (error instanceof HttpException && error.getStatus() === HttpStatus.NOT_FOUND) return null;
          throw error;
        });
        let mode: 'OVERWRITE' | 'CONTINUE' = 'OVERWRITE';
        let handleId: string | null = null;
        if (!entry) {
          handleId = randomUUID();
          const folder = await this.drive.liveAt(runner.ownerId, parent);
          const created = await this.drive.createFile(runner.ownerId, { parentId: folder.id, name, handleId, writer, onClash: 'REFUSE' });
          entry = await this.drive.liveById(runner.ownerId, created.id);
          mode = 'CONTINUE';
        } else if (entry.kind !== 'FILE') {
          throw refusal(HttpStatus.CONFLICT, 'DRIVE_NOT_A_FILE', `${item.path} is a folder in Drive.`);
        }
        const committed = await this.drive.commit(
          runner.ownerId,
          {
            commitId: item.commitId,
            entryId: entry.id,
            handleId,
            mode,
            baseVersionId: mode === 'CONTINUE' ? entry.currentVersionId : null,
            baseSize: null,
            chunks: item.chunks,
            replaceTail: null,
            stagingId: null,
            writer,
          },
          instance ? { fence: (tx) => fenceManagedInstance(tx, instance) } : {},
        );
        if (item.mtime) await this.drive.setMtime(runner.ownerId, committed.entryId, new Date(item.mtime), writer);
        results.push({ path: item.path, ok: true, entryId: committed.entryId, versionId: committed.versionId, newVersion: committed.newVersion, sizeBytes: committed.sizeBytes });
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        const body = error.getResponse() as { code?: string; message?: string; idx?: number };
        results.push({ path: item.path, ok: false, status: error.getStatus(), code: body.code ?? null, message: body.message ?? error.message, idx: body.idx ?? null });
      }
    }
    return { results };
  }

  @Post('utimens')
  @HttpCode(HttpStatus.OK)
  async utimens(@CurrentRunner() runner: Runner, @Body() dto: RunnerDriveUtimensDto) {
    const entry = await this.named(runner.ownerId, dto.path, dto.id);
    return this.drive.setMtime(runner.ownerId, entry.id, new Date(dto.mtime), this.writer(runner, dto.writer));
  }

  /** The account's drive bytes, what the mount shows `df` as used (§5.6). */
  @Get('usage')
  usage(@CurrentRunner() runner: Runner) {
    return this.drive.usage(runner.ownerId);
  }

  /** The change feed (§5.4), held open up to `wait` seconds (at most 25) until something after `since` changed. */
  @Get('changes')
  async changes(@CurrentRunner() runner: Runner, @Query('since') since?: string, @Query('wait') wait?: string) {
    const seconds = Math.min(CHANGES_WAIT_MAX_S, Math.max(0, Number.parseInt(wait ?? '0', 10) || 0));
    const deadline = Date.now() + seconds * 1000;
    const after = Number(/^(\d+)/.exec(since ?? '')?.[1] ?? NaN);
    for (;;) {
      const answer = await this.drive.changes(runner.ownerId, since);
      const moved = answer.resync || answer.more || answer.changes.some((c) => c.seq > after);
      if (moved || Number.isNaN(after) || Date.now() + CHANGES_POLL_MS > deadline) return answer;
      await new Promise((resolve) => setTimeout(resolve, CHANGES_POLL_MS));
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────

  /**
   * A write of a Drive chat's turn (`turn`; null runs it as it is): once the turn takes no more changes — it made 200, or
   * already holds some — the write is held for the owner's Apply (`held`) and refused DRIVE_CHAT_HELD, nothing changed.
   * One the recorder finds over the limit inside its own transaction, rolled back, is held the same way.
   */
  private async chatWrite<T>(turn: DriveChatTurn | null, held: DriveChatHeldOp, write: () => Promise<T>): Promise<T> {
    if (!turn) return write();
    if (await this.chatChanges.isFull(turn)) return this.chatChanges.hold(turn, held);
    try {
      return await write();
    } catch (error) {
      if (error instanceof DriveChatTurnFull) return this.chatChanges.hold(turn, held);
      throw error;
    }
  }

  /** The live entry a request names by path or by id, exactly one of them. */
  private async named(ownerId: string, path: string | undefined, id: string | undefined): Promise<DriveEntryRow> {
    if ((path === undefined) === (id === undefined)) {
      throw refusal(HttpStatus.BAD_REQUEST, DRIVE_PATH_OR_ID, 'Name the entry by its path or by its id, one of the two.');
    }
    return id !== undefined ? this.drive.liveById(ownerId, id) : this.drive.liveAt(ownerId, path!);
  }

  /** A staging of this owner's that this runner opened and has not committed. */
  private async staging(runner: Runner, id: string) {
    const staging = await this.prisma.driveStaging.findFirst({
      where: { id, ownerId: runner.ownerId, runnerId: runner.id, committedAt: null },
      select: { id: true },
    });
    if (!staging) throw refusal(HttpStatus.NOT_FOUND, 'DRIVE_STAGING_NOT_FOUND', 'No such write in progress on this runner.');
    return staging;
  }

  /** An agent's write through this runner; the session is the name layer's to check (§3.6). */
  private writer(runner: Runner, writer?: RunnerDriveWriterDto): DriveWriter {
    return { kind: 'AGENT', runnerId: runner.id, sessionId: writer?.sessionId ?? null };
  }

  /** A blob's bytes, or `range` of them, from the store that keeps them. */
  private async serveBlob(sha256: string, rangeHeader: string | undefined, res: Response): Promise<StreamableFile> {
    const blob = await this.prisma.fileBlob.findUnique({ where: { sha256 }, select: { storage: true, sizeBytes: true, bytesDeletedAt: true } });
    if (!blob) throw new NotFoundException({ code: 'DRIVE_CHUNK_NOT_FOUND', message: 'No such chunk.' });
    const size = Number(blob.sizeBytes);
    const range = rangeOf(rangeHeader, size);
    const content = blob.bytesDeletedAt ? null : await this.files.storeOf(blob.storage)?.open(sha256, range);
    if (!content) throw new GoneException({ code: DRIVE_CHUNK_GONE, message: 'The bytes of this chunk are not kept any more.' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', `"${sha256}"`);
    if (range) {
      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
      res.setHeader('Content-Length', String(size));
    }
    return new StreamableFile(content);
  }
}

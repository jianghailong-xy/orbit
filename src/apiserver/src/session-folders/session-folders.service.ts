import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateSessionFolderDto, RenameSessionFolderDto } from './dto';

// The shape returned to clients — never leaks ownerId/timestamps.
const FOLDER_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
} satisfies Prisma.SessionFolderSelect;

/**
 * The owner's session folders (docs/session-folders-move-design.md §3). A folder lives in one
 * workspace and a session is in at most one; it is filing only, and nothing that runs a session
 * reads it. Which folder a session is in is written by SessionsService — at create and by
 * `POST /sessions/:id/move`, which check the folder against the session's workspace — never here.
 */
@Injectable()
export class SessionFoldersService {
  constructor(
    private readonly prisma: PrismaService,
    // @Global RealtimeModule. A folder belongs to the owner, not to a session, so every change to
    // one is pushed user-scoped and the owner's other clients re-read the folder list.
    private readonly realtime: RealtimeService,
  ) {}

  /** Every folder the owner has, in every workspace, by name. */
  async list(ownerId: string) {
    return this.prisma.sessionFolder.findMany({
      where: { ownerId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: FOLDER_SELECT,
    });
  }

  async create(ownerId: string, dto: CreateSessionFolderDto) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: dto.workspaceId, ownerId, deletedAt: null },
      select: { id: true },
    });
    if (!workspace) throw new ForbiddenException('workspace not found');
    try {
      const folder = await this.prisma.sessionFolder.create({
        data: { ownerId, workspaceId: workspace.id, name: dto.name },
        select: FOLDER_SELECT,
      });
      this.realtime.publishForUser(ownerId, RunEventType.FOLDER_CHANGED, folder.id);
      return folder;
    } catch (e) {
      throw this.refusal(e);
    }
  }

  /** Owner-scoped in the statement itself, so a folder that is not the caller's is a 404. */
  async rename(ownerId: string, id: string, dto: RenameSessionFolderDto) {
    try {
      const folder = await this.prisma.sessionFolder.update({
        where: { id, ownerId },
        data: { name: dto.name },
        select: FOLDER_SELECT,
      });
      this.realtime.publishForUser(ownerId, RunEventType.FOLDER_CHANGED, id);
      return folder;
    } catch (e) {
      throw this.refusal(e);
    }
  }

  /** Delete the folder and nothing else: `session.folder_id` is ON DELETE SET NULL, so the
   *  sessions that were in it go back to their workspace's list and none of them is deleted. */
  async remove(ownerId: string, id: string) {
    try {
      await this.prisma.sessionFolder.delete({ where: { id, ownerId } });
    } catch (e) {
      throw this.refusal(e);
    }
    this.realtime.publishForUser(ownerId, RunEventType.FOLDER_CHANGED, id);
    return { ok: true };
  }

  private refusal(e: unknown): Error {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      // UNIQUE (workspace_id, name).
      if (e.code === 'P2002') {
        return new ConflictException('a folder with that name already exists in this workspace');
      }
      // The keyed update/delete matched no row: not the caller's, or already gone.
      if (e.code === 'P2025') return new NotFoundException('folder not found');
    }
    return e as Error;
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertValidUpload, toBytes, UploadedFile } from './attachments.media';

@Injectable()
export class AttachmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist an uploaded file for `ownerId`, optionally scoped to a session OR a task. Validates
   * size, and — when a scope is given — that the row it names belongs to the caller, so an upload
   * can't be parked on another tenant's session or task. Returns the new id.
   *
   * The two scopes mean different things and cannot be combined. A session scope is a blob in a
   * CONVERSATION: it cascade-deletes with the session and is handed to the runner as part of a
   * turn. A task scope is an INPUT TO THE WORK — a design mock, a spec — which outlives every
   * session that runs the task, so it is never handed to a runner directly; each dispatch copies
   * it (`copyTaskAttachments`). Migration 0241's CHECK is the same rule where no writer can route
   * around it; this is the friendly refusal in front of it.
   */
  async create(
    ownerId: string,
    sessionId: string | undefined,
    file: UploadedFile | undefined,
    taskId?: string,
  ): Promise<{ id: string }> {
    assertValidUpload(file);
    const f = file as UploadedFile;
    if (sessionId && taskId) {
      throw new BadRequestException('an attachment is scoped to a session or a task, not both');
    }
    if (sessionId) {
      const session = await this.prisma.session.findFirst({
        where: { id: sessionId, ownerId },
        select: { id: true },
      });
      if (!session) throw new NotFoundException('session not found');
    }
    if (taskId) {
      const task = await this.prisma.task.findFirst({
        where: { id: taskId, ownerId },
        select: { id: true },
      });
      if (!task) throw new NotFoundException('task not found');
    }
    const row = await this.prisma.attachment.create({
      data: {
        ownerId,
        sessionId: sessionId ?? null,
        taskId: taskId ?? null,
        mimeType: f.mimetype,
        sizeBytes: f.size,
        fileName: f.originalname || null,
        data: toBytes(f.buffer),
      },
      select: { id: true },
    });
    return { id: row.id };
  }

  /**
   * Remove one of the caller's TASK inputs.
   *
   * Task-scoped only, and that is the rule rather than an oversight: a session- or turn-scoped row
   * is a picture in a message somebody already sent, and a transcript is a record — deleting from
   * it would rewrite history and blank an image the runner has already been handed. A task input
   * is the opposite: it is a file the work has not been done with yet, and removing one attached
   * by mistake is ordinary editing. Scoping the filter to `taskId: { not: null }` means a request
   * naming a transcript's image 404s exactly as a foreign id does — no existence leak either way.
   *
   * Runs already dispatched keep their own copies (`copyTaskAttachments`), so this changes what
   * FUTURE runs are given and never reaches into one that has started.
   */
  async removeTaskInput(ownerId: string, id: string): Promise<void> {
    const deleted = await this.prisma.attachment.deleteMany({
      where: { id, ownerId, taskId: { not: null } },
    });
    if (deleted.count === 0) throw new NotFoundException('attachment not found');
  }

  /**
   * Fetch an attachment's bytes for `ownerId`. Filtering by ownerId in the query means a
   * non-owner gets a 404 (no existence leak) — that is the tenant-isolation guarantee.
   */
  async getForOwner(
    ownerId: string,
    id: string,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const row = await this.prisma.attachment.findFirst({
      where: { id, ownerId },
      select: { data: true, mimeType: true },
    });
    if (!row) throw new NotFoundException('attachment not found');
    return { data: Buffer.from(row.data), mimeType: row.mimeType };
  }

  /**
   * Serve an attachment's bytes for a public shared transcript: only if it belongs to the
   * session shared under `token`. The share token is the capability (no ownerId check), so the
   * read-only shared page can render inline images without the bearer-guarded download route.
   */
  async getForSharedSession(
    token: string,
    id: string,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const session = await this.prisma.session.findFirst({
      where: { shareToken: token, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('attachment not found');
    const row = await this.prisma.attachment.findFirst({
      where: { id, sessionId: session.id },
      select: { data: true, mimeType: true },
    });
    if (!row) throw new NotFoundException('attachment not found');
    return { data: Buffer.from(row.data), mimeType: row.mimeType };
  }
}

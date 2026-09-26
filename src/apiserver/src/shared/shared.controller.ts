import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { AttachmentsService } from '../attachments/attachments.service';
import { SessionsService } from '../sessions/sessions.service';
import { parseMaxPayload } from '../sessions/truncate-payload';
import { linkNotFound, withoutToolOutput } from '../share-links/share-link';
import { type OpenLink, ShareLinksService } from '../share-links/share-links.service';
import { PublicSurfaceGuard } from './public-surface.guard';

const num = (s?: string): number | undefined => {
  const n = Number(s);
  return s !== undefined && s !== '' && Number.isFinite(n) ? n : undefined;
};

/**
 * Public, UNAUTHENTICATED read-only access to whatever a public link opens. There is deliberately
 * no JwtAuthGuard here: the unguessable token in the URL is the capability. Every route resolves
 * the token through ShareLinksService first, and a token that opens nothing — never issued, turned
 * off, expired, or a session in the trash — gets the same 404 on every route. Only what the link's
 * layers include is exposed — never ownership, billing, or runner internals. PublicSurfaceGuard
 * puts no-store / noindex on every answer and holds each visitor to a budget.
 */
@Controller('shared')
@UseGuards(PublicSurfaceGuard)
export class SharedController {
  constructor(
    private readonly links: ShareLinksService,
    private readonly sessions: SessionsService,
    private readonly attachments: AttachmentsService,
  ) {}

  /**
   * The link's root page: `kind`, `include` and `sharedAt`, then the root. A session root keeps the
   * shape its page has always read — title, workspace, status, the tail page of its events and
   * `hasMore` (`limit` / `maxPayload` as on the events page below). A task root is the task as its
   * layers show it (share-links/public-task.ts); a project root is the project's seven blocks
   * (share-links/public-project.ts) and `scope`, what the link opens besides it. The one request
   * that counts as a view — unless it is the owner's Preview (`preview=1`), which is them looking,
   * not a visitor. The count is information, not a boundary, so the flag is taken at its word.
   */
  @Get(':token')
  async get(
    @Param('token') token: string,
    @Query('limit') limit?: string,
    @Query('maxPayload') maxPayload?: string,
    @Query('preview') preview?: string,
  ) {
    const link = await this.links.resolve(token);
    const head = { kind: link.kind, include: link.include, sharedAt: link.sharedAt };
    const body = link.sessionId
      ? await this.sessions
          .getSharedTranscript(link.sessionId, { limit: num(limit), maxPayload: parseMaxPayload(maxPayload) })
          .then((transcript) => ({ ...head, ...transcript, events: shown(link, transcript.events) }))
      : link.kind === 'TASK'
        ? { ...head, root: await this.links.taskPage(link) }
        : { ...head, ...(await this.links.projectPage(link)) };
    if (preview !== '1') await this.links.recordView(link.id);
    return body;
  }

  /**
   * One of a project link's tasks, as a task link's root page shows its task (`root`), with the
   * link's `include` and `scope`. Only with Task pages, and only a task filed under the project;
   * anything else — another project's task, a layer that is off — is the one 404. Not a view.
   */
  @Get(':token/tasks/:taskId')
  async task(@Param('token') token: string, @Param('taskId', PublicIdPipe) taskId: string) {
    const link = await this.links.resolve(token);
    return this.links.projectTask(link, taskId);
  }

  /** A page of the shared transcript: the newest `limit` (≤ 500, default 200) events, or those
   *  just older than `before`; `maxPayload` trims bulky tool bodies and marks them `truncated`. */
  @Get(':token/events')
  async events(
    @Param('token') token: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
    @Query('maxPayload') maxPayload?: string,
  ) {
    const link = await this.sessionLink(token);
    const page = await this.sessions.getSharedEventPage(link.sessionId, {
      before: num(before),
      limit: num(limit),
      maxPayload: parseMaxPayload(maxPayload),
    });
    return { ...page, events: shown(link, page.events) };
  }

  /** One event's untrimmed payload — what an expanded `truncated` card fetches. */
  @Get(':token/events/:seq')
  async event(@Param('token') token: string, @Param('seq') seq: string) {
    const n = Number(seq);
    if (!Number.isFinite(n)) throw new BadRequestException('seq must be a number');
    const link = await this.sessionLink(token);
    const [event] = shown(link, [await this.sessions.getSharedEventFull(link.sessionId, Math.trunc(n))]);
    return event;
  }

  /**
   * One conversation the link shares besides its root, with Conversations: for a task link one of
   * the task's runs, for a project link one of its tasks' runs or its coordinator. The shape of a
   * session root's page, plus what its page needs around it — `task`, the task it is a run of and
   * that task's runs a visitor may open (null for a project's coordinator); on a project link also
   * `project` and the link's `scope` — for the breadcrumb and links. Anything else, including a run
   * in the Trash, is the one 404.
   */
  @Get(':token/sessions/:sessionId')
  async conversation(
    @Param('token') token: string,
    @Param('sessionId', PublicIdPipe) sessionId: string,
    @Query('limit') limit?: string,
    @Query('maxPayload') maxPayload?: string,
  ) {
    const link = await this.links.resolve(token);
    const context = await this.links.conversation(link, sessionId);
    const transcript = await this.sessions.getSharedTranscript(sessionId, {
      limit: num(limit),
      maxPayload: parseMaxPayload(maxPayload),
    });
    return { ...transcript, events: shown(link, transcript.events), ...context };
  }

  /** A page of one of those conversations, as `:token/events` pages the root's. */
  @Get(':token/sessions/:sessionId/events')
  async conversationEvents(
    @Param('token') token: string,
    @Param('sessionId', PublicIdPipe) sessionId: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
    @Query('maxPayload') maxPayload?: string,
  ) {
    const link = await this.links.resolve(token);
    await this.links.openConversation(link, sessionId);
    const page = await this.sessions.getSharedEventPage(sessionId, {
      before: num(before),
      limit: num(limit),
      maxPayload: parseMaxPayload(maxPayload),
    });
    return { ...page, events: shown(link, page.events) };
  }

  /** One event of one of those conversations, whole. */
  @Get(':token/sessions/:sessionId/events/:seq')
  async conversationEvent(
    @Param('token') token: string,
    @Param('sessionId', PublicIdPipe) sessionId: string,
    @Param('seq') seq: string,
  ) {
    const n = Number(seq);
    if (!Number.isFinite(n)) throw new BadRequestException('seq must be a number');
    const link = await this.links.resolve(token);
    await this.links.openConversation(link, sessionId);
    const [event] = shown(link, [await this.sessions.getSharedEventFull(sessionId, Math.trunc(n))]);
    return event;
  }

  /** Bytes of an inline image/file the link shares: one in the shared session's transcript, or — on a
   *  task or project link — one of its tasks' input files or of the conversations it opens, as its
   *  layers allow. */
  @Get(':token/attachments/:id')
  async attachment(
    @Param('token') token: string,
    @Param('id', PublicIdPipe) id: string,
  ): Promise<StreamableFile> {
    const link = await this.links.resolve(token);
    const { data, mimeType } = link.sessionId
      ? await this.attachments.getForSharedSession(link.sessionId, id)
      : await this.links.rootAttachment(link, id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline', length: data.length });
  }

  /** A legacy runner-local artifact path from the shared transcript — only once its bytes are
   *  stored (see SessionsService.getLegacyArtifactForShared). */
  @Get(':token/artifacts')
  async artifact(
    @Param('token') token: string,
    @Query('path') artifactPath?: string,
  ): Promise<StreamableFile> {
    const link = await this.sessionLink(token);
    const { data, mimeType, disposition } = await this.sessions.getLegacyArtifactForShared(link.sessionId, artifactPath);
    return new StreamableFile(data, { type: mimeType, disposition, length: data.length });
  }

  /** The transcript routes serve a session root only; on any other link they are not there. */
  private async sessionLink(token: string): Promise<OpenLink & { sessionId: string }> {
    const link = await this.links.resolve(token);
    if (!link.sessionId) throw linkNotFound();
    return link as OpenLink & { sessionId: string };
  }
}

/** The events as the link shows them: whole, or — Tool output off — with only the tools' names. */
function shown<E extends { type: string; payload: unknown; truncated?: true }>(link: OpenLink, events: E[]): E[] {
  return link.include.toolOutput ? events : events.map(withoutToolOutput);
}

import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Headers,
  MessageEvent,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  Sse,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { PublicIdPipe } from '../common/public-id';
import { DriveContentService, parseRange } from '../drive/drive-content.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { publicOrigin } from '../email/email-settings.service';
import { streamable } from '../files/files.service';
import { attachmentDisposition, inlineType } from '../files/user-file-response';
import { SessionsService } from '../sessions/sessions.service';
import { parseMaxPayload } from '../sessions/truncate-payload';
import { ViewerStreamService } from '../sessions/viewer-stream.service';
import { linkNotFound, withoutToolOutput } from '../share-links/share-link';
import { type OpenLink, ShareLinksService } from '../share-links/share-links.service';
import { PublicSurfaceGuard } from './public-surface.guard';
import { shareCardHead } from './share-card';
import { SHARED_STREAM_TARGET, SharedStreamGuard, type SharedStreamTarget } from './shared-stream.guard';

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
    private readonly viewerStreams: ViewerStreamService,
    private readonly drive: DriveContentService,
  ) {}

  /**
   * The link's root page: `kind`, `include` and `sharedAt`, then the root. A session root keeps the
   * shape its page has always read — title, workspace, status, the tail page of its events and
   * `hasMore` (`limit` / `maxPayload` as on the events page below). A task root is the task as its
   * layers show it (share-links/public-task.ts); a project root is the project's seven blocks
   * (share-links/public-project.ts) and `scope`, what the link opens besides it; a wiki root is the
   * space's written documents by category (share-links/public-wiki.ts). The one request
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
        : link.kind === 'WIKI'
          ? { ...head, root: await this.links.wikiPage(link) }
          : link.kind === 'DRIVE_FILE'
            ? { ...head, root: await this.driveFile(link) }
          : { ...head, ...(await this.links.projectPage(link)) };
    if (preview !== '1') await this.links.recordView(link.id);
    return body;
  }

  /**
   * A drive file link's bytes: the version the link was pinned to, whatever the file holds now, with `Range` (206). A type
   * off the inline list leaves as a download, and the answer is sandboxed and never sniffed, as every user file is.
   */
  @Get(':token/content')
  async content(
    @Param('token') token: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const link = await this.links.resolve(token);
    if (link.kind !== 'DRIVE_FILE') throw linkNotFound();
    const file = await this.links.driveFilePage(link);
    const type = driveFileType(file.name);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('ETag', `"${file.versionId}"`);
    const range = parseRange(rangeHeader, file.sizeBytes);
    if (range === 'unsatisfiable') {
      res.status(416).setHeader('Content-Range', `bytes */${file.sizeBytes}`);
      return new StreamableFile(Buffer.alloc(0), { type, length: 0 });
    }
    const opened = await this.drive.open(link.ownerId, file.versionId, range ?? undefined);
    if (range) {
      res.status(206).setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.sizeBytes}`);
    }
    res.once('close', () => opened.content.destroy());
    return new StreamableFile(opened.content, {
      type,
      disposition: inlineType(type) ? 'inline' : attachmentDisposition(file.name),
      length: range ? range.end - range.start + 1 : file.sizeBytes,
    });
  }

  /**
   * The head lines of the link's page — its title, a line saying what kind of thing it is, the app
   * icon — for a chat app that reads a link's page without running it (shared/share-card.ts).
   * web/nginx.conf includes this into `/s/<token>`; on the one 404 the page keeps its bare title.
   * Not a view: a chat fetching the page is not a person reading it.
   */
  @Get(':token/card')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async card(@Param('token') token: string): Promise<string> {
    return shareCardHead(await this.links.cardOf(token), publicOrigin());
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

  /**
   * One of a wiki link's written documents (`doc`), with the link's `include` and the wiki's name for
   * the breadcrumb. Its footnotes only with Footnotes. A document the plan does not have, one nobody
   * has written, and any other kind of link are the one 404. Not a view.
   */
  @Get(':token/docs/:slug')
  async wikiDoc(@Param('token') token: string, @Param('slug') slug: string) {
    const link = await this.links.resolve(token);
    return this.links.wikiDoc(link, slug);
  }

  /** A page of the shared transcript: the newest `limit` (≤ 500, default 200) events, or those
   *  just older than `before`; `maxPayload` trims bulky tool bodies and marks them `truncated`.
   *  With `after`, what the session has added since that seq instead, and its header as it stands
   *  now (SessionsService.getSharedEventsAfter) — the read a page following a live session makes. */
  @Get(':token/events')
  async events(
    @Param('token') token: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('maxPayload') maxPayload?: string,
  ) {
    const link = await this.sessionLink(token);
    const page = await this.pageOf(link.sessionId, { before, after, limit, maxPayload });
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
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('maxPayload') maxPayload?: string,
  ) {
    const link = await this.links.resolve(token);
    await this.links.openConversation(link, sessionId);
    const page = await this.pageOf(sessionId, { before, after, limit, maxPayload });
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

  /**
   * The shared session pushed (docs/session-viewer-stream-design.md §3–§4): the root's transcript on a session link,
   * shaped like the owner's `/sessions/:id/events` — `sinceSeq`, `maxPayload` — through the viewer projection: what
   * `:token/events` shows, as the link's Tool output allows, plus the reply as it is written and head frames.
   * SharedStreamGuard has resolved the link before anything is read. Not a view.
   */
  @UseGuards(SharedStreamGuard)
  @Sse(':token/stream')
  stream(
    @Req() req: { [SHARED_STREAM_TARGET]: SharedStreamTarget },
    @Query('sinceSeq') sinceSeq?: string,
    @Query('maxPayload') maxPayload?: string,
  ): Observable<MessageEvent> {
    return this.streamOf(req[SHARED_STREAM_TARGET], { sinceSeq, maxPayload });
  }

  /** One of the conversations the link opens besides its root, pushed, as `:token/stream` pushes the root's; the
   *  guard asks whether the link opens it as `:token/sessions/:sessionId/events` does. */
  @UseGuards(SharedStreamGuard)
  @Sse(':token/sessions/:sessionId/stream')
  conversationStream(
    @Req() req: { [SHARED_STREAM_TARGET]: SharedStreamTarget },
    @Query('sinceSeq') sinceSeq?: string,
    @Query('maxPayload') maxPayload?: string,
  ): Observable<MessageEvent> {
    return this.streamOf(req[SHARED_STREAM_TARGET], { sinceSeq, maxPayload });
  }

  /** Bytes of an inline image/file the link shares: one in the shared session's transcript, or — on a
   *  task or project link — one of its tasks' input files or of the conversations it opens, as its
   *  layers allow. Streamed from the file store, or from the row for one stored before it. */
  @Get(':token/attachments/:id')
  async attachment(
    @Param('token') token: string,
    @Param('id', PublicIdPipe) id: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<StreamableFile> {
    const link = await this.links.resolve(token);
    const file = link.sessionId
      ? await this.attachments.open({ id, sessionId: link.sessionId })
      : await this.attachments.open(await this.links.rootAttachment(link, id));
    if (!file) throw link.sessionId ? new NotFoundException('attachment not found') : linkNotFound();
    return streamable(file, res);
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

  /** One page of a conversation the link opens, as both events routes read it: what came after
   *  `after` when it is given, as the owner's `events/page` reads it; else the page before `before`,
   *  or the tail. */
  private pageOf(
    sessionId: string,
    query: { before?: string; after?: string; limit?: string; maxPayload?: string },
  ) {
    const opts = { limit: num(query.limit), maxPayload: parseMaxPayload(query.maxPayload) };
    const after = num(query.after);
    return after !== undefined
      ? this.sessions.getSharedEventsAfter(sessionId, { ...opts, after })
      : this.sessions.getSharedEventPage(sessionId, { ...opts, before: num(query.before) });
  }

  private streamOf(target: SharedStreamTarget, query: { sinceSeq?: string; maxPayload?: string }) {
    return this.viewerStreams.stream(
      target.sessionId,
      { kind: 'PUBLIC', toolOutput: target.toolOutput },
      {
        // The link turned off or changed, or the session gone from the Trash's side; not one guest's removal.
        named: (r) => ('linkId' in r ? r.linkId === target.linkId : r.sessionId === target.sessionId && r.guestId === undefined),
        // A link that no longer includes tool output a stream sends ends that stream, so it reopens redacted (§5).
        check: async () => {
          const access = await this.links.streamAccess(target.token, target.sessionId, target.conversation);
          return access && { until: access.until, narrowed: target.toolOutput && !access.toolOutput };
        },
      },
      { sinceSeq: query.sinceSeq, maxPayload: parseMaxPayload(query.maxPayload) },
    );
  }

  /** A drive file link's root page: its name, size and type, and the address of its bytes. */
  private async driveFile(link: OpenLink) {
    const file = await this.links.driveFilePage(link);
    return { name: file.name, sizeBytes: file.sizeBytes, mimeType: driveFileType(file.name), preview: inlineType(driveFileType(file.name)) !== null };
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

/** The types a drive file may be shown as, by its name; every other file is bytes to download. */
const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
};

function driveFileType(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && FILE_TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

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
   * `hasMore` (`limit` / `maxPayload` as on the events page below). A task or a project root is
   * `root: {id, title, status}` for now. The one request that counts as a view.
   */
  @Get(':token')
  async get(
    @Param('token') token: string,
    @Query('limit') limit?: string,
    @Query('maxPayload') maxPayload?: string,
  ) {
    const link = await this.links.resolve(token);
    const head = { kind: link.kind, include: link.include, sharedAt: link.sharedAt };
    const body = link.sessionId
      ? await this.sessions
          .getSharedTranscript(link.sessionId, { limit: num(limit), maxPayload: parseMaxPayload(maxPayload) })
          .then((transcript) => ({ ...head, ...transcript, events: shown(link, transcript.events) }))
      : { ...head, root: link.root };
    await this.links.recordView(link.id);
    return body;
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

  /** Bytes of an inline image/file in the shared transcript (scoped to the shared session). */
  @Get(':token/attachments/:id')
  async attachment(
    @Param('token') token: string,
    @Param('id', PublicIdPipe) id: string,
  ): Promise<StreamableFile> {
    const link = await this.sessionLink(token);
    const { data, mimeType } = await this.attachments.getForSharedSession(link.sessionId, id);
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

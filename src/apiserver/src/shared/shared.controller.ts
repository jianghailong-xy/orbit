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
import { PublicSurfaceGuard } from './public-surface.guard';

const num = (s?: string): number | undefined => {
  const n = Number(s);
  return s !== undefined && s !== '' && Number.isFinite(n) ? n : undefined;
};

/**
 * Public, UNAUTHENTICATED read-only access to a session shared via its `shareToken`. There is
 * deliberately no JwtAuthGuard here: the unguessable token in the URL is the capability. Every
 * route resolves the token to its session and 404s otherwise (revoked / never shared / trashed),
 * and only ever exposes the sanitized transcript — never ownership, billing, or runner internals.
 * PublicSurfaceGuard puts no-store / noindex on every answer and holds each visitor to a budget.
 */
@Controller('shared')
@UseGuards(PublicSurfaceGuard)
export class SharedController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly attachments: AttachmentsService,
  ) {}

  /** The shared session's read-only transcript (title, workspace, status), with the tail page of
   *  its events and `hasMore`. `limit` / `maxPayload` as on the events page below. */
  @Get(':token')
  get(
    @Param('token') token: string,
    @Query('limit') limit?: string,
    @Query('maxPayload') maxPayload?: string,
  ) {
    return this.sessions.getShared(token, { limit: num(limit), maxPayload: parseMaxPayload(maxPayload) });
  }

  /** A page of the shared transcript: the newest `limit` (≤ 500, default 200) events, or those
   *  just older than `before`; `maxPayload` trims bulky tool bodies and marks them `truncated`. */
  @Get(':token/events')
  events(
    @Param('token') token: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
    @Query('maxPayload') maxPayload?: string,
  ) {
    return this.sessions.getSharedEventPage(token, {
      before: num(before),
      limit: num(limit),
      maxPayload: parseMaxPayload(maxPayload),
    });
  }

  /** One event's untrimmed payload — what an expanded `truncated` card fetches. */
  @Get(':token/events/:seq')
  event(@Param('token') token: string, @Param('seq') seq: string) {
    const n = Number(seq);
    if (!Number.isFinite(n)) throw new BadRequestException('seq must be a number');
    return this.sessions.getSharedEventFull(token, Math.trunc(n));
  }

  /** Bytes of an inline image/file in the shared transcript (scoped to the shared session). */
  @Get(':token/attachments/:id')
  async attachment(
    @Param('token') token: string,
    @Param('id', PublicIdPipe) id: string,
  ): Promise<StreamableFile> {
    const { data, mimeType } = await this.attachments.getForSharedSession(token, id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline', length: data.length });
  }

  /** A legacy runner-local artifact path from the shared transcript — only once its bytes are
   *  stored (see SessionsService.getLegacyArtifactForShared). */
  @Get(':token/artifacts')
  async artifact(
    @Param('token') token: string,
    @Query('path') artifactPath?: string,
  ): Promise<StreamableFile> {
    const { data, mimeType, disposition } = await this.sessions.getLegacyArtifactForShared(token, artifactPath);
    return new StreamableFile(data, { type: mimeType, disposition, length: data.length });
  }
}

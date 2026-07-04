import { Controller, Get, Param, Query, StreamableFile } from '@nestjs/common';
import { AttachmentsService } from '../attachments/attachments.service';
import { SessionsService } from '../sessions/sessions.service';

/**
 * Public, UNAUTHENTICATED read-only access to a session shared via its `shareToken`. There is
 * deliberately no JwtAuthGuard here: the unguessable token in the URL is the capability. Both
 * routes resolve the token to its session and 404 otherwise (revoked / never shared / trashed),
 * and only ever expose the sanitized transcript — never ownership, billing, or runner internals.
 */
@Controller('shared')
export class SharedController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly attachments: AttachmentsService,
  ) {}

  /** The shared session's read-only transcript (title, agent, status, events). */
  @Get(':token')
  get(@Param('token') token: string) {
    return this.sessions.getShared(token);
  }

  /** Bytes of an inline image/file in the shared transcript (scoped to the shared session). */
  @Get(':token/attachments/:id')
  async attachment(
    @Param('token') token: string,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const { data, mimeType } = await this.attachments.getForSharedSession(token, id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline', length: data.length });
  }

  /** Download a legacy runner-local artifact path already present in the shared transcript. */
  @Get(':token/artifacts')
  async artifact(
    @Param('token') token: string,
    @Query('path') artifactPath?: string,
  ): Promise<StreamableFile> {
    const { data, mimeType, disposition } = await this.sessions.getLegacyArtifactForShared(token, artifactPath);
    return new StreamableFile(data, { type: mimeType, disposition, length: data.length });
  }
}

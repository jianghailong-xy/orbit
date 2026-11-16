import {
  Body, Controller, Delete, Get, MessageEvent, Param, Post, Query, Res, Sse, StreamableFile, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Observable } from 'rxjs';
import type { Response } from 'express';
import { MAX_UPLOAD_BYTES } from '../attachments/attachments.media';
import { AllowQueryToken } from '../auth/allow-query-token.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { PublicIdPipe } from '../common/public-id';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { FileUploadCleanupInterceptor } from '../files/file-upload-cleanup.interceptor';
import { FILE_UPLOAD_STORAGE, type FileUpload } from '../files/file-upload-storage';
import { streamable } from '../files/files.service';
import { parseMaxPayload } from '../sessions/truncate-payload';
import { ViewerStreamService } from '../sessions/viewer-stream.service';
import { assertClientTurnIdNotReserved } from '../sessions/watch-turn-key';
import { GuestInvitationGuard } from './guest-invitation.guard';
import { type GuestTurnBody, SessionGuestsService } from './session-guests.service';

/** `POST /sessions/:id/guests`. */
interface InviteGuestBody {
  email?: unknown;
}

/**
 * The owner's People who can reply (docs/session-guests-design.md §3, §7). Inviting lets someone else drive an agent
 * on the owner's machine with the owner's accounts, so all three are the owner channel: no access token reaches them
 * (auth/pat-owner-channel-routes.ts).
 */
@UseGuards(JwtAuthGuard)
@Controller('sessions/:id/guests')
export class SessionGuestsController {
  constructor(private readonly guests: SessionGuestsService) {}

  @PatForbidden('OWNER_INTERACTIVE')
  @Get()
  list(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.guests.list(user.userId, id);
  }

  @PatForbidden('OWNER_INTERACTIVE')
  @Post()
  invite(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() body: InviteGuestBody) {
    return this.guests.invite(user.userId, id, body?.email);
  }

  @PatForbidden('OWNER_INTERACTIVE')
  @Delete(':userId')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('userId', PublicIdPipe) userId: string,
  ) {
    return this.guests.remove(user.userId, id, userId);
  }
}

/**
 * The guest's door (§4, §5, §7): signed in as the guest, with a live invitation to the session, or the one 404
 * (`GUEST_SESSION_NOT_SHARED`) on every route. What it reads is the /shared projection with tool output on; what it
 * writes is a turn of the owner's session — words, and images the guest uploaded here. Closed to access tokens for now: no scope covers acting in someone
 * else's session.
 */
@UseGuards(JwtAuthGuard)
@PatForbidden('NO_SCOPE')
@Controller('guest-sessions')
export class GuestSessionsController {
  constructor(
    private readonly guests: SessionGuestsService,
    private readonly viewerStreams: ViewerStreamService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.guests.sharedWithMe(user.userId);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('limit') limit?: string,
    @Query('maxPayload') maxPayload?: string,
  ) {
    return this.guests.get(user.userId, id, { limit, maxPayload });
  }

  @Get(':id/events')
  events(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('maxPayload') maxPayload?: string,
  ) {
    return this.guests.events(user.userId, id, { before, after, limit, maxPayload });
  }

  @Get(':id/events/:seq')
  event(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Param('seq') seq: string) {
    return this.guests.event(user.userId, id, seq);
  }

  /**
   * The guest page's stream (docs/session-viewer-stream-design.md §3–§4), shaped like the owner's `/sessions/:id/events`:
   * `sinceSeq` replays the gap after it, `maxPayload` trims bulky tool bodies. EventSource cannot send a header, so
   * the sign-in may ride `access_token` as on the owner's stream. The invitation is checked before anything is read
   * (GuestInvitationGuard). The projection is the guest page's: tool output on, and head frames with `waitingOnOwner`.
   */
  @AllowQueryToken()
  @UseGuards(GuestInvitationGuard)
  @Sse(':id/stream')
  stream(
    @Param('id', PublicIdPipe) id: string,
    @Query('sinceSeq') sinceSeq?: string,
    @Query('maxPayload') maxPayload?: string,
  ): Observable<MessageEvent> {
    return this.viewerStreams.stream(
      id,
      { kind: 'GUEST', waitingOnOwner: (sessionId) => this.guests.waitingOnOwner(sessionId) },
      { sinceSeq, maxPayload: parseMaxPayload(maxPayload) },
    );
  }

  /** An image or file the transcript carries, as the public page's `/shared/:token/attachments/:id` serves it. */
  @Get(':id/attachments/:attachmentId')
  async attachment(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('attachmentId', PublicIdPipe) attachmentId: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<StreamableFile> {
    return streamable(await this.guests.attachment(user.userId, id, attachmentId), res);
  }

  /**
   * An image for the guest's next message (`file`, multipart, as `POST /attachments` takes one): a PNG, JPEG, WebP or GIF
   * of at most 5 MB, the owner composer's images (SessionGuestsService.uploadImage). The upload streams to a temporary
   * file bounded by the server's one upload cap, so a larger image is answered with the guest door's own sentence.
   */
  @Post(':id/attachments')
  @UseInterceptors(
    FileUploadCleanupInterceptor,
    FileInterceptor('file', { storage: FILE_UPLOAD_STORAGE, limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  uploadImage(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @UploadedFile() file: FileUpload | undefined,
  ): Promise<{ id: string }> {
    return this.guests.uploadImage(user.userId, id, file);
  }

  @Post(':id/turns')
  turn(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body(PublicIdPipe.forFields('attachmentIds')) body: GuestTurnBody,
  ) {
    // A guest names a turn key here, so the server's own reserved prefixes are refused here too.
    assertClientTurnIdNotReserved(typeof body?.clientTurnId === 'string' ? body.clientTurnId : undefined);
    return this.guests.turn(user.userId, id, body);
  }

  @Delete(':id/turns/:turnId')
  cancelTurn(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('turnId', PublicIdPipe) turnId: string,
  ) {
    return this.guests.cancelTurn(user.userId, id, turnId);
  }

  @Post(':id/turns/:turnId/steer')
  steerTurn(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('turnId', PublicIdPipe) turnId: string,
  ) {
    return this.guests.steerTurn(user.userId, id, turnId);
  }

  @Post(':id/leave')
  leave(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.guests.leave(user.userId, id);
  }
}

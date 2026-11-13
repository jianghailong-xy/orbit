import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { PublicIdPipe } from '../common/public-id';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { assertClientTurnIdNotReserved } from '../sessions/watch-turn-key';
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
 * writes is a text turn of the owner's session. Closed to access tokens for now: no scope covers acting in someone
 * else's session.
 */
@UseGuards(JwtAuthGuard)
@PatForbidden('NO_SCOPE')
@Controller('guest-sessions')
export class GuestSessionsController {
  constructor(private readonly guests: SessionGuestsService) {}

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

  @Post(':id/turns')
  turn(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() body: GuestTurnBody) {
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

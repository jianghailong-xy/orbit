import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { actingSession } from '../wiki/wiki.controller';
import { DriveChatChanges } from './drive-chat-changes';
import { DRIVE_PAT } from './drive.controller';
import { DRIVE_ROUTE_PREFIXES } from './drive-routes';
import { DriveEnabledGuard } from './drive-switch';

type Headers = { headers: Record<string, string | string[] | undefined> };

/**
 * A Drive chat's changes and overwrite questions, the owner's (drive-chat-changes.ts): the reads take a token with the
 * drive scope; Undo, Apply and an answer are presses of the owner's interactive credential alone, as a wiki chat card's
 * are. Every route refuses a request with a session header DRIVE_CHAT_OWNER_CHANNEL_ONLY.
 */
@UseGuards(JwtAuthGuard, DriveEnabledGuard)
@Controller(DRIVE_ROUTE_PREFIXES)
export class DriveChatChangesController {
  constructor(private readonly changes: DriveChatChanges) {}

  @DRIVE_PAT()
  @Get('chats/:sessionId/groups')
  groups(@CurrentUser() user: AuthUser, @Param('sessionId', PublicIdPipe) sessionId: string, @Req() request: Headers) {
    return this.changes.groups(user.userId, sessionId, actingSession(request.headers));
  }

  @DRIVE_PAT()
  @Get('chats/:sessionId/groups/:groupId')
  group(
    @CurrentUser() user: AuthUser,
    @Param('sessionId', PublicIdPipe) sessionId: string,
    @Param('groupId', PublicIdPipe) groupId: string,
    @Req() request: Headers,
  ) {
    return this.changes.group(user.userId, sessionId, groupId, actingSession(request.headers));
  }

  @PatForbidden('OWNER_INTERACTIVE')
  @Post('chats/:sessionId/groups/:groupId/undo')
  @HttpCode(HttpStatus.OK)
  undo(
    @CurrentUser() user: AuthUser,
    @Param('sessionId', PublicIdPipe) sessionId: string,
    @Param('groupId', PublicIdPipe) groupId: string,
    @Req() request: Headers,
  ) {
    return this.changes.undo(user.userId, sessionId, groupId, actingSession(request.headers));
  }

  @PatForbidden('OWNER_INTERACTIVE')
  @Post('chats/:sessionId/groups/:groupId/apply')
  @HttpCode(HttpStatus.OK)
  apply(
    @CurrentUser() user: AuthUser,
    @Param('sessionId', PublicIdPipe) sessionId: string,
    @Param('groupId', PublicIdPipe) groupId: string,
    @Req() request: Headers,
  ) {
    return this.changes.apply(user.userId, sessionId, groupId, actingSession(request.headers));
  }

  @DRIVE_PAT()
  @Get('chats/:sessionId/questions')
  questions(@CurrentUser() user: AuthUser, @Param('sessionId', PublicIdPipe) sessionId: string, @Req() request: Headers) {
    return this.changes.questions(user.userId, sessionId, actingSession(request.headers));
  }

  @PatForbidden('OWNER_INTERACTIVE')
  @Post('chats/:sessionId/questions/:questionId')
  @HttpCode(HttpStatus.OK)
  answer(
    @CurrentUser() user: AuthUser,
    @Param('sessionId', PublicIdPipe) sessionId: string,
    @Param('questionId', PublicIdPipe) questionId: string,
    @Body() body: unknown,
    @Req() request: Headers,
  ) {
    return this.changes.answer(user.userId, sessionId, questionId, body, actingSession(request.headers));
  }
}

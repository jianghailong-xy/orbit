import { Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { TerminalSelf } from '../auth/terminal-credentials';
import { TerminalLoginService } from './terminal-login.service';

/**
 * A person's terminals (docs/terminal-session-design.md, "The terminal credential"), signed in to the Orbit app:
 * the approve card's read and its two presses, and Settings → Terminals with Revoke.
 *
 * Approving mints a credential, so it is the owner channel's (auth/pat-owner-channel-routes.ts): a personal access
 * token is refused it as OWNER_INTERACTIVE, a runner credential is not a credential this guard knows (401), and a
 * TERMINAL credential is refused it 403 as it is every route that does not declare @TerminalRoute. The handler holds
 * the same line once more: only the app's own login decides.
 *
 * The two `self` routes are the terminal acting on itself — reading what it is, revoking itself — and the only routes
 * here a TERMINAL credential reaches (terminal-route-coverage.spec.ts holds its whole allowlist).
 */
@UseGuards(JwtAuthGuard)
@Controller('terminals')
export class TerminalsController {
  constructor(private readonly logins: TerminalLoginService) {}

  /** The owner's terminal sign-ins waiting for a decision: what the approve card shows. */
  @PatForbidden('OWNER_INTERACTIVE')
  @Get('requests')
  pending(@CurrentUser() user: AuthUser) {
    requireLogin(user);
    return this.logins.pending(user.userId);
  }

  /** Approve: the terminal's next poll collects a credential bound to this account and that machine, for 30 days. */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('requests/:id/approve')
  @HttpCode(200)
  approve(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    requireLogin(user);
    return this.logins.decide(user.userId, id, 'APPROVED');
  }

  /** Deny: the terminal is told so, and nothing is minted. */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('requests/:id/deny')
  @HttpCode(200)
  deny(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    requireLogin(user);
    return this.logins.decide(user.userId, id, 'DENIED');
  }

  /** The terminal reading itself. Declared before `:id` so `self` is never read as one. */
  @TerminalSelf()
  @PatForbidden('TOKEN_MANAGEMENT')
  @Get('self')
  self(@CurrentUser() user: AuthUser) {
    return this.logins.self(user.userId, user.credential);
  }

  /** The terminal revoking itself: its next request is 401. */
  @TerminalSelf()
  @PatForbidden('TOKEN_MANAGEMENT')
  @Delete('self')
  revokeSelf(@CurrentUser() user: AuthUser) {
    return this.logins.revokeSelf(user.userId, user.credential);
  }

  /** The owner's live terminals: machine, created, last used, expires. Settings → Terminals. */
  @PatForbidden('TOKEN_MANAGEMENT')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    requireLogin(user);
    return this.logins.list(user.userId);
  }

  /** Revoke one of the owner's terminals at once. */
  @PatForbidden('TOKEN_MANAGEMENT')
  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    requireLogin(user);
    return this.logins.revoke(user.userId, id);
  }
}

/**
 * Only the app's own login decides about terminals. JwtAuthGuard already refuses every other credential these routes
 * meet (a token by its declaration, a terminal by deny-by-default, an administrator viewing the account on a write);
 * this keeps that true should one of those ever change.
 */
function requireLogin(user: AuthUser): void {
  if (user.credential?.kind === 'LOGIN' || (user.credential?.kind === 'IMPERSONATION')) return;
  throw new ForbiddenException({
    code: 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED',
    requiredAction: 'OPEN_ORBIT',
    message: 'Terminals are approved and managed signed in to the Orbit app',
  });
}

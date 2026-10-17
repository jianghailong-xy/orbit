import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { IssueAccessTokenDto } from './dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PatForbidden, PatSelf } from './pat-scope.decorator';
import { PAT_DEFAULT_EXPIRES_IN_DAYS, PatService } from './pat.service';

/**
 * A person's personal access tokens, managed signed in to Orbit (docs/personal-access-token-design.md
 * §6.5, §9): issue one — the only answer that ever carries the token — list them without it, and
 * revoke one. Closed to every token on the controller, so a route added here later is closed too: a
 * token cannot make, read or end tokens.
 */
@UseGuards(JwtAuthGuard)
@PatForbidden('TOKEN_MANAGEMENT')
@Controller('access-tokens')
export class AccessTokensController {
  constructor(private readonly pats: PatService) {}

  @Post()
  issue(@CurrentUser() user: AuthUser, @Body() dto: IssueAccessTokenDto) {
    return this.pats.issue(user.userId, {
      name: dto.name,
      scopes: dto.scopes,
      workspaceIds: dto.workspaceIds,
      // Left out is the default lifetime; null is a token that never expires (§11.1).
      expiresInDays: dto.expiresInDays === undefined ? PAT_DEFAULT_EXPIRES_IN_DAYS : dto.expiresInDays,
      createdVia: 'WEB',
    });
  }

  /** Every token the caller has issued, newest first, revoked and expired ones included. */
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return { tokens: await this.pats.list(user.userId) };
  }

  /** Revoke one of the caller's tokens at once. Idempotent. */
  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.pats.revoke(user.userId, id, 'USER');
  }
}

/**
 * The token acting on itself (§6.5): reading who it acts as and what it was granted, for `orbit
 * whoami` and `orbit login --with-token` — `GET /users/me` is the account's and refuses a token —
 * and revoking itself, for `orbit logout`, which `/access-tokens*` refuses it. Every token reaches
 * both, whatever its scopes and workspaces (@PatSelf, the two routes that are so). A login is
 * answered 400: it is not a token, and `GET /users/me` describes it.
 */
@UseGuards(JwtAuthGuard)
@Controller('pat')
export class PatSelfController {
  constructor(private readonly pats: PatService) {}

  @Get('self')
  @PatSelf()
  async self(@CurrentUser() user: AuthUser) {
    const token = await this.pats.self(user.userId, tokenIdOf(user));
    if (!token) throw new UnauthorizedException('invalid token');
    return { userId: user.userId, email: user.email, token };
  }

  /**
   * Revoke the token this request is made with, and no other — recorded USER, as revoking it in the
   * settings page is. Idempotent as that revoke is; the token is 401 from its next request on.
   */
  @Delete('self')
  @PatSelf()
  revokeSelf(@CurrentUser() user: AuthUser) {
    return this.pats.revoke(user.userId, tokenIdOf(user), 'USER');
  }
}

/** The id of the personal access token a request was made with; 400 for a request signed in to Orbit. */
function tokenIdOf(user: AuthUser): string {
  const credential = user.credential;
  if (credential?.kind !== 'PAT') {
    throw new BadRequestException({
      code: 'NOT_A_PERSONAL_ACCESS_TOKEN',
      message:
        'This request was made signed in to Orbit, not with a personal access token; '
        + '/api/pat/self reads or revokes the token a request is made with',
    });
  }
  return credential.tokenId;
}

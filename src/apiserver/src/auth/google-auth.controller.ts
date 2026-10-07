import { BadRequestException, Body, Controller, Delete, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { visitorAddress } from '../shared/public-surface.guard';
import { GoogleExchangeDto, GoogleLinkDto } from './dto';
import { type GoogleCallbackOutcome, type GoogleIntent, GoogleLoginService } from './google-login.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PatForbidden } from './pat-scope.decorator';
import { googleRedirectUri } from './sign-in-providers.service';

/** Which client started a Google sign-in, and so where its answer is sent (§4.2). */
export type GoogleClient = 'web' | 'native';

/**
 * Where a Google sign-in that ended in `code` sends the browser (docs/google-sign-in-design.md
 * §4.2): the Web login page — or, for a link, the profile page — by a relative path, or the native
 * apps' one fixed address with the `client_state` they started with. Never an address the request names.
 */
export function googleFailureRedirect(client: GoogleClient, code: string, clientState?: string, intent: GoogleIntent = 'LOGIN'): string {
  if (client === 'web') return `${intent === 'LINK' ? '/settings/profile' : '/login'}?google_error=${encodeURIComponent(code)}`;
  const state = clientState === undefined ? '' : `&state=${encodeURIComponent(clientState)}`;
  return `orbit://auth/google?error=${encodeURIComponent(code)}${state}`;
}

/** Where one that succeeded sends it, with the ticket the client exchanges (§4.2): the same fixed set. */
export function googleSuccessRedirect(client: GoogleClient, ticket: string, clientState?: string, intent: GoogleIntent = 'LOGIN'): string {
  if (client === 'web') {
    return intent === 'LINK'
      ? `/settings/profile?google_link_ticket=${encodeURIComponent(ticket)}`
      : `/login?google_ticket=${encodeURIComponent(ticket)}`;
  }
  const state = clientState === undefined ? '' : `&state=${encodeURIComponent(clientState)}`;
  return `orbit://auth/google?ticket=${encodeURIComponent(ticket)}${state}`;
}

/** The cookie that ties a flow to the browser that started it (§4.1); the flow keeps only its sha256. */
export const BINDING_COOKIE = 'orbit_oauth_flow';

/**
 * The binding cookie as /start sets it, or — for null — as the callback clears it. Only the Google
 * routes ever see it, for the ten minutes a flow lasts, and over https only when PUBLIC_ORIGIN is https.
 */
export function bindingCookie(value: string | null): string {
  const secure = googleRedirectUri().startsWith('https://') ? '; Secure' : '';
  return `${BINDING_COOKIE}=${value ?? ''}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=${value === null ? 0 : 600}${secure}`;
}

/** Every value of the binding cookie the browser sent: a cookie of the same name on a wider path or domain may come too. */
function bindingsOf(header: string | undefined): string[] {
  return (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${BINDING_COOKIE}=`))
    .map((part) => part.slice(BINDING_COOKIE.length + 1))
    .filter((value) => value !== '');
}

function returnTo(outcome: GoogleCallbackOutcome): string {
  const { client, intent, clientState } = outcome.to;
  return 'ticket' in outcome
    ? googleSuccessRedirect(client, outcome.ticket, clientState ?? undefined, intent)
    : googleFailureRedirect(client, outcome.error, clientState ?? undefined, intent);
}

/**
 * Signing in with Google (§4). Public, as the password login is: the start, the callback Google sends
 * the browser to, and the exchange of the callback's ticket for a session. While Google sign-in is off
 * — no client saved, or saved and switched off (§7.1) — no flow starts: /start sends the browser back
 * to the client that asked, with GOOGLE_NOT_CONFIGURED, and the exchange is refused.
 *
 * And linking Google to the account signed in, and unlinking it (§5.3): behind JwtAuthGuard, and —
 * the class being refused to every access token — for a login only. Refused GOOGLE_NOT_CONFIGURED
 * while Google sign-in is off, as the sign-in routes are.
 */
@PatForbidden('AUTH')
@Controller('auth/google')
export class GoogleAuthController {
  constructor(private readonly flows: GoogleLoginService) {}

  /** §4.1: `client=web|native`, `code_challenge`, and for native an optional `client_state` it gets back. */
  @Get('start')
  async start(
    @Req() req: Request,
    @Res() res: Response,
    @Query('client') client?: string,
    @Query('code_challenge') codeChallenge?: string,
    @Query('client_state') clientState?: string,
  ) {
    if (client !== 'web' && client !== 'native') throw new BadRequestException('client must be web or native');
    const started = await this.flows.start({ client, codeChallenge, clientState, visitor: visitorAddress(req) });
    if (!started) return res.redirect(302, googleFailureRedirect(client, 'GOOGLE_NOT_CONFIGURED', clientState));
    res.setHeader('Set-Cookie', bindingCookie(started.binding));
    return res.redirect(302, started.authorizationUrl);
  }

  /**
   * §4.2: where Google sends the browser back, with `code` and `state` or with `error`. Answers only
   * with a redirect to the client the flow was started by, and clears the binding cookie whatever
   * the outcome — set before anything can fail, so it is on every answer.
   */
  @Get('callback')
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('state') state?: string,
    @Query('code') code?: string,
    @Query('error') error?: string,
  ) {
    res.setHeader('Set-Cookie', bindingCookie(null));
    const outcome = await this.flows.callback({ state, code, error }, bindingsOf(req.headers.cookie));
    return res.redirect(302, returnTo(outcome));
  }

  /** §4.3: `{ticket, codeVerifier}` for the session POST /auth/login answers with, in the same shape. */
  @Post('exchange')
  exchange(@Req() req: Request, @Body() dto: GoogleExchangeDto) {
    return this.flows.exchange({ ticket: dto.ticket, codeVerifier: dto.codeVerifier, visitor: visitorAddress(req) });
  }

  /**
   * §5.3: `{codeChallenge}` from the profile page of the account signed in. Opens a LINK flow, binds it
   * to this browser with the cookie /start sets, and answers `{authorizationUrl}` for the page to send
   * the browser to; the callback returns it to /settings/profile with the ticket (§4.2).
   */
  @UseGuards(JwtAuthGuard)
  @Post('link')
  async link(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: GoogleLinkDto,
  ) {
    const started = await this.flows.startLink({ userId: user.userId, codeChallenge: dto.codeChallenge, visitor: visitorAddress(req) });
    res.setHeader('Set-Cookie', bindingCookie(started.binding));
    return { authorizationUrl: started.authorizationUrl };
  }

  /** §5.3: `{ticket, codeVerifier}` the profile page came back with. Answers the account's `signInMethods`. */
  @UseGuards(JwtAuthGuard)
  @Post('link/confirm')
  confirmLink(@CurrentUser() user: AuthUser, @Body() dto: GoogleExchangeDto) {
    return this.flows.confirmLink({ userId: user.userId, ticket: dto.ticket, codeVerifier: dto.codeVerifier });
  }

  /** §5.3: the account signed in unlinks its Google account. Answers its `signInMethods`. */
  @UseGuards(JwtAuthGuard)
  @Delete('link')
  unlink(@CurrentUser() user: AuthUser) {
    return this.flows.unlink(user.userId);
  }
}

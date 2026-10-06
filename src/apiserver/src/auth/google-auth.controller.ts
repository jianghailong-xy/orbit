import { BadRequestException, Controller, Get, NotImplementedException, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PatForbidden } from './pat-scope.decorator';
import { SignInProvidersService } from './sign-in-providers.service';

/** Which client started a Google sign-in, and so where its answer is sent (§4.2). */
export type GoogleClient = 'web' | 'native';

/**
 * Where a Google sign-in that ended in `code` sends the browser (docs/google-sign-in-design.md
 * §4.2): the Web login page, by a relative path, or the native apps' one fixed address with the
 * `client_state` they started with. Never an address the request names.
 */
export function googleFailureRedirect(client: GoogleClient, code: string, clientState?: string): string {
  if (client === 'web') return `/login?google_error=${encodeURIComponent(code)}`;
  const state = clientState === undefined ? '' : `&state=${encodeURIComponent(clientState)}`;
  return `orbit://auth/google?error=${encodeURIComponent(code)}${state}`;
}

/**
 * Signing in with Google (§4). Public, as the password login is. While Google sign-in is off — no
 * client saved, or saved and switched off (§7.1) — no flow starts: /start sends the browser back to
 * the client that asked, with GOOGLE_NOT_CONFIGURED.
 */
@PatForbidden('AUTH')
@Controller('auth/google')
export class GoogleAuthController {
  constructor(private readonly signIn: SignInProvidersService) {}

  /** §4.1: `client=web|native`, `code_challenge`, and for native an optional `client_state` it gets back. */
  @Get('start')
  async start(@Res() res: Response, @Query('client') client?: string, @Query('client_state') clientState?: string) {
    if (client !== 'web' && client !== 'native') throw new BadRequestException('client must be web or native');
    if (!(await this.signIn.methods()).google) {
      return res.redirect(302, googleFailureRedirect(client, 'GOOGLE_NOT_CONFIGURED', clientState));
    }
    throw new NotImplementedException('Google sign-in is not available on this server yet');
  }
}

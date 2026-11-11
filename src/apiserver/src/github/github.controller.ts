import { Controller, Delete, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { githubCallbackUrl } from './github-app-config.service';
import { GithubConnectionService } from './github-connection.service';

/** The cookie that ties a connection in flight to the browser that started it; the flow keeps only its sha256. */
export const GITHUB_BINDING_COOKIE = 'orbit_github_flow';

/** The binding cookie as /start sets it, or — for null — as the callback clears it: the GitHub routes only, ten minutes. */
export function githubBindingCookie(value: string | null): string {
  const secure = githubCallbackUrl().startsWith('https://') ? '; Secure' : '';
  return `${GITHUB_BINDING_COOKIE}=${value ?? ''}; HttpOnly; SameSite=Lax; Path=/api/integrations/github; Max-Age=${value === null ? 0 : 600}${secure}`;
}

function bindingsOf(header: string | undefined): string[] {
  return (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${GITHUB_BINDING_COOKIE}=`))
    .map((part) => part.slice(GITHUB_BINDING_COOKIE.length + 1))
    .filter((value) => value !== '');
}

/**
 * Settings → Integrations → GitHub (docs/github-workspace-design.md §5.2): the account's connection to the
 * deployment's GitHub App, and the repositories and branches it can pick from. A browser session reaches
 * every route; an access token needs `workspaces:write`, since what it reads here is what a workspace is
 * cloned from.
 */
@UseGuards(JwtAuthGuard)
@Controller('integrations/github')
export class GithubController {
  constructor(private readonly connections: GithubConnectionService) {}

  @Get()
  @PatScope('workspaces:write', { workspaceConfinable: false })
  read(@CurrentUser() user: AuthUser) {
    return this.connections.view(user.userId);
  }

  /**
   * Opens a connection and answers `{authorizationUrl}` for the page to send the browser to, with the
   * cookie that binds the flow to this browser. A JSON answer rather than a redirect: the page's
   * credential is a bearer header, which a navigation does not carry. `return` is the Orbit path the
   * callback sends the browser back to.
   */
  @Get('start')
  @PatScope('workspaces:write', { workspaceConfinable: false })
  async start(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response, @Query('return') returnTo?: string) {
    const started = await this.connections.start(user.userId, returnTo);
    res.setHeader('Set-Cookie', githubBindingCookie(started.binding));
    return { authorizationUrl: started.authorizationUrl };
  }

  @Delete()
  @PatScope('workspaces:write', { workspaceConfinable: false })
  disconnect(@CurrentUser() user: AuthUser) {
    return this.connections.disconnect(user.userId);
  }

  @Get('repos')
  @PatScope('workspaces:write', { workspaceConfinable: false })
  repositories(@CurrentUser() user: AuthUser, @Query('q') q?: string, @Query('cursor') cursor?: string) {
    return this.connections.repositories(user.userId, q, cursor);
  }

  /** `:id` is GitHub's repository id, and only one of the account's own listing is answered. */
  @Get('repos/:id/branches')
  @PatScope('workspaces:write', { workspaceConfinable: false })
  branches(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('q') q?: string) {
    return this.connections.branches(user.userId, id, q);
  }
}

/**
 * Where GitHub sends the browser back (§5.2). Public, as Google's callback is: the state, found by its
 * hash, and the browser cookie /start set are what tie it to an account. Answers only with a redirect
 * to a path on this site, and clears the cookie whatever the outcome.
 */
@Controller('integrations/github')
export class GithubCallbackController {
  constructor(private readonly connections: GithubConnectionService) {}

  @Get('callback')
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('state') state?: string,
    @Query('code') code?: string,
    @Query('error') error?: string,
    @Query('setup_action') setupAction?: string,
  ) {
    res.setHeader('Set-Cookie', githubBindingCookie(null));
    const to = await this.connections.callback({ state, code, error, setupAction }, bindingsOf(req.headers.cookie));
    return res.redirect(302, to);
  }
}

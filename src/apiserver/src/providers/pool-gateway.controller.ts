import { All, Controller, Req, Res } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ACCOUNT_DISABLED, ACCOUNT_DISABLED_MESSAGE } from '../auth/disabled-accounts';
import {
  bearerToken,
  gatewayAllows,
  gatewayTarget,
  POOL_GATEWAY_PATH,
  PoolGatewayService,
  refuse,
} from './pool-gateway.service';
import { loginGatewayAllows } from './codex-login-gateway';
import { PoolLoginGatewayService } from './pool-login-gateway.service';
import { POOL_LOGIN_TOKEN_PREFIX } from './shared-pool';

/**
 * `/api/gw/codex/*` — the Codex pools' gateway. No guard: the caller's only credential is the session token
 * the gateway itself checks, and every path under the prefix reaches the handler, so one outside the
 * gateway's list is refused by the gateway, with its reason, rather than answered by the router.
 *
 * A token authenticates (pool, person, session) and nothing more. Its prefix says which table it is kept in
 * — a login pool's (`orbit-gwl-`, its owner's own sessions: PoolLoginGatewayService.caller) or a person's
 * (`orbit-gw-`: PoolGatewayService.caller) — and nothing about where its requests go: that is the session's,
 * as its last claim left it. A session on one of the pool's ChatGPT accounts goes to ChatGPT's Codex
 * backend (PoolLoginGatewayService.forward) — its owner's session on an `orbit-gwl-` token, one of the
 * people they added on an `orbit-gw-` one, both served there since 2026-10-03 — and one on one of its API
 * keys goes to OpenAI's API (PoolGatewayService.forward). A session on neither is answered by the side its
 * token belongs to: a login pool's as a pool holding no account, a person's as a pool with no key for them.
 */
@Controller('gw/codex')
export class PoolGatewayController {
  constructor(
    private readonly gateway: PoolGatewayService,
    private readonly loginGateway: PoolLoginGatewayService,
  ) {}

  @All(['', '{*path}'])
  async forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = bearerToken(req.headers.authorization);
    const login = token?.startsWith(POOL_LOGIN_TOKEN_PREFIX) ?? false;
    const caller = login ? await this.loginGateway.caller(token!) : await this.gateway.caller(token);
    if (!caller) {
      refuse(res, 401, 'orbit_gateway_token_invalid', login
        ? 'This Orbit session token is not valid any more — the session ended or moved, or the pool is gone'
        : 'This Orbit session token is not valid any more — the session ended, it left the shared pool, or the pool is gone');
      return;
    }
    if (caller === ACCOUNT_DISABLED) {
      // A good token of a disabled account (docs/google-sign-in-design.md §5.5): refused with the code and
      // the words its runner credential is, in the shape codex reads — and 403, not the 401 the runner
      // would take for its engine's own sign-in failing.
      refuse(res, 403, ACCOUNT_DISABLED, ACCOUNT_DISABLED_MESSAGE);
      return;
    }
    const target = gatewayTarget(req.originalUrl ?? req.url);
    // Which upstream the session is on decides which paths it may reach: a session on one of the pool's
    // ChatGPT accounts (loginGatewayAllows) also reaches the backend calls the CLI makes for itself, where
    // one on one of its API keys (gatewayAllows) reaches the turn alone.
    const onAccount = caller.accountId !== null || (login && caller.keyId === null);
    const allowed = onAccount ? loginGatewayAllows(req.method, target.path) : gatewayAllows(req.method, target.path);
    if (!allowed) {
      refuse(res, 403, 'orbit_gateway_path_not_allowed', `${req.method} ${target.path} is not something the Orbit pool gateway forwards`);
      return;
    }
    return onAccount ? this.loginGateway.forward(req, res, caller) : this.gateway.forward(req, res, caller);
  }
}

/**
 * `middleware`, for every request but the gateway's. main.ts parses JSON and form bodies for the whole
 * API; the gateway forwards the body codex sent byte for byte, so it must reach the handler unread.
 */
export function outsideThePoolGateway(middleware: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) =>
    (req.originalUrl ?? req.url).startsWith(`${POOL_GATEWAY_PATH}/`) || (req.originalUrl ?? req.url) === POOL_GATEWAY_PATH
      ? next()
      : middleware(req, res, next);
}

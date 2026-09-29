import { All, Controller, Req, Res } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { bearerToken, POOL_GATEWAY_PATH, PoolGatewayService } from './pool-gateway.service';
import { PoolLoginGatewayService } from './pool-login-gateway.service';
import { POOL_LOGIN_TOKEN_PREFIX } from './shared-pool';

/**
 * `/api/gw/codex/*` — the Codex pools' gateway: a shared pool's (PoolGatewayService, on to OpenAI's API) and
 * a pool of one's own ChatGPT login's (PoolLoginGatewayService, on to ChatGPT's Codex backend), told apart
 * by the session token's prefix, which is all a runner's codex has to send. No guard: the caller's only
 * credential is the session token the gateway itself checks. Every path under the prefix reaches the
 * handler, so one outside the gateway's list is refused by the gateway, with its reason, rather than
 * answered by the router.
 */
@Controller('gw/codex')
export class PoolGatewayController {
  constructor(
    private readonly gateway: PoolGatewayService,
    private readonly loginGateway: PoolLoginGatewayService,
  ) {}

  @All(['', '{*path}'])
  forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = bearerToken(req.headers.authorization);
    return token?.startsWith(POOL_LOGIN_TOKEN_PREFIX)
      ? this.loginGateway.handle(req, res, token)
      : this.gateway.handle(req, res);
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

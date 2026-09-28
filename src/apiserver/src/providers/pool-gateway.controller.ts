import { All, Controller, Req, Res } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { POOL_GATEWAY_PATH, PoolGatewayService } from './pool-gateway.service';

/**
 * `/api/gw/codex/*` — the shared Codex pools' gateway (PoolGatewayService). No guard: the caller is a
 * runner's codex, whose only credential is the session token the gateway itself checks. Every path under
 * the prefix reaches the handler, so one outside the gateway's list is refused by the gateway, with its
 * reason, rather than answered by the router.
 */
@Controller('gw/codex')
export class PoolGatewayController {
  constructor(private readonly gateway: PoolGatewayService) {}

  @All(['', '{*path}'])
  forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.gateway.handle(req, res);
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

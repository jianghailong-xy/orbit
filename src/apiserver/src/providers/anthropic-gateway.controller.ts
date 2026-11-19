import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ACCOUNT_DISABLED, ACCOUNT_DISABLED_MESSAGE } from '../auth/disabled-accounts';
import {
  anthropicGatewayAllows,
  anthropicGatewayPath,
  AnthropicGatewayService,
  refuseAnthropic,
} from './anthropic-gateway.service';
import { AnthropicLoginGatewayService } from './anthropic-login-gateway.service';
import { bearerToken } from './pool-gateway.service';

/**
 * `/api/gw/anthropic/*` — Claude Code on an OpenAI key (docs/claude-engine-openai-gateway-design.md §4.1), beside
 * `/api/gw/codex`. No guard: the caller's only credential is the `orbit-gwk-` session token the gateway checks,
 * and every path under the prefix reaches the handler, so one outside the gateway's list is refused by the
 * gateway, in Anthropic's error shape, rather than answered by the router. That includes the
 * `HEAD <base>/api/hello` the CLI sends before its first request (P0, basic.json request 1).
 *
 * A login pool's session token (`orbit-gwl-`) is a Claude Code session on its owner's own Codex login pool
 * (design §9), answered by AnthropicLoginGatewayService on the pool's account; every other token is a key's.
 */
@Controller('gw/anthropic')
export class AnthropicGatewayController {
  constructor(
    private readonly gateway: AnthropicGatewayService,
    private readonly loginGateway: AnthropicLoginGatewayService,
  ) {}

  @All(['', '{*path}'])
  async forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = bearerToken(req.headers.authorization) ?? headerToken(req.headers['x-api-key']);
    const login = AnthropicLoginGatewayService.owns(token);
    const caller = login ? await this.loginGateway.caller(token!) : await this.gateway.caller(token);
    if (!caller) {
      refuseAnthropic(res, 401, 'authentication_error', login
        ? 'This Orbit session token is not valid any more: the session ended or moved, or the pool is gone.'
        : 'This Orbit session token is not valid any more: the session ended or moved, or its key was removed, switched off or replaced.');
      return;
    }
    if (caller === ACCOUNT_DISABLED) {
      refuseAnthropic(res, 403, 'permission_error', ACCOUNT_DISABLED_MESSAGE);
      return;
    }
    const path = anthropicGatewayPath(req.originalUrl ?? req.url);
    if (!anthropicGatewayAllows(req.method, path)) {
      refuseAnthropic(res, 404, 'not_found_error', `${req.method} ${path} is not something the Orbit gateway forwards.`);
      return;
    }
    return 'poolId' in caller ? this.loginGateway.forward(req, res, caller) : this.gateway.forward(req, res, caller);
  }
}

/** A token sent as `x-api-key`, which Claude Code uses for ANTHROPIC_API_KEY (it sends a bearer for ours). */
function headerToken(value: string | string[] | undefined): string | undefined {
  const token = (Array.isArray(value) ? value[0] : value)?.trim();
  return token ? token : undefined;
}

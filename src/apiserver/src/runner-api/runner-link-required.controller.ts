import { Controller, Get, UseGuards } from '@nestjs/common';
import { RunnerLinkGatewayGuard } from './runner-link-token.controller';

/** GET /api/runner/link/mode: what the link gateway tells runners, as it reads it. */
export interface RunnerLinkModeResponse {
  required: true;
}

/**
 * GET /api/runner/link/mode, which the link gateway reads every second to learn whether to tell runners MODE_LINK
 * (src/link-gateway/mode.go). It always does now. The route stays for as long as a gateway reads it: a gateway that
 * starts and cannot read it tells every runner MODE_HTTP, and forwards nothing. The gateway's door: the secret
 * RUNNER_LINK_GATEWAY_TOKEN names, and 404 while the link is off.
 */
@UseGuards(RunnerLinkGatewayGuard)
@Controller('runner/link')
export class RunnerLinkModeController {
  @Get('mode')
  mode(): RunnerLinkModeResponse {
    return { required: true };
  }
}

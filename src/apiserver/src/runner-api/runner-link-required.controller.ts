import { Controller, Get, UseGuards } from '@nestjs/common';
import { RunnerLinkGatewayGuard } from './runner-link-token.controller';

/** GET /api/runner/link/mode: what the link gateway tells runners, as it reads it. */
export interface RunnerLinkModeResponse {
  required: true;
}

/**
 * GET /api/runner/link/mode, which a link gateway from before its shadow period's code was removed (task
 * 34sSqSNx9BHCECKDNblLr; production's, built at f8b9964f3, is one) reads every second to learn whether to tell runners
 * MODE_LINK. It always does now. A gateway from that task on never reads it. The route has to stay until no gateway from
 * before then runs anywhere: such a gateway keeps what it last read while a read fails, but one that starts and cannot
 * read it tells every runner MODE_HTTP, and forwards nothing. The gateway's door: the secret RUNNER_LINK_GATEWAY_TOKEN
 * names, and 404 while the link is off.
 */
@UseGuards(RunnerLinkGatewayGuard)
@Controller('runner/link')
export class RunnerLinkModeController {
  @Get('mode')
  mode(): RunnerLinkModeResponse {
    return { required: true };
  }
}

import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { MachineProtocol } from '../common/machine-protocol';
import { isRunnerLinkCall } from '../common/runner-link-call';
import { readLinkEventCall, type LinkEventCall, type LinkEventCallAnswer } from './link-events';
import { RunnerApiController } from './runner-api.controller';
import { RUNNER_LINK, runnerLinkNotConfigured, type RunnerLinkState } from './runner-link-token';

/**
 * The merged call's door: the runner link's internal listener alone, which admits only the link gateway, by its
 * secret, RUNNER_LINK_GATEWAY_TOKEN (runner-link-call.ts `runnerLinkCallListener`). The call carries batches of many
 * runners, so no runner's credential can be the call's: each batch's runner is admitted from the link token its
 * connection carries, as RunnerAuthGuard admits a link call (link-events.ts `admitLinkCallConnections`). Over HTTPS the
 * route is not there, and answers the 404 of a server without it.
 */
@Injectable()
export class RunnerLinkGatewayCallGuard implements CanActivate {
  constructor(@Inject(RUNNER_LINK) private readonly link: RunnerLinkState) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.link.config) throw runnerLinkNotConfigured();
    if (!isRunnerLinkCall(context.switchToHttp().getRequest())) {
      throw new NotFoundException({
        code: 'RUNNER_LINK_GATEWAY_ONLY',
        message: 'This route is the runner link gateway\'s, on the link\'s internal listener.',
      });
    }
    return true;
  }
}

/**
 * POST /api/runner/link/events: several sessions' durable event batches, from any of the gateway's connections, stored
 * in one transaction (docs/runner-link-design.md §6.6, §6.7; link-events.ts, RunnerApiController.ingestLinkEventCall).
 * The gateway sends here what it collected for a short window (src/link-gateway/events_merge.go), and each batch's
 * EventAck says what this call answered for it, or, for a batch it answers `sendAlone`, what the events route answers
 * it alone.
 *
 * A controller of its own, so that the runner controller's routes stay the daemon protocol a runner calls itself, and
 * machine protocol, so that the session ids are UUIDs, as on every route the gateway calls.
 */
@MachineProtocol()
@Controller('runner/link')
export class RunnerLinkEventsController {
  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(RUNNER_LINK) private readonly link: RunnerLinkState,
  ) {}

  @UseGuards(RunnerLinkGatewayCallGuard)
  @Post('events')
  @HttpCode(200)
  async events(@Body() body: LinkEventCall): Promise<LinkEventCallAnswer> {
    const call = readLinkEventCall(body);
    // The ingest is the events route's own, so the call is answered by the controller that serves it.
    const ingest = this.moduleRef.get(RunnerApiController, { strict: true });
    return ingest.ingestLinkEventCall(call, this.link.config!.publicKey);
  }
}

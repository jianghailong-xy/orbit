import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { RunnerLinkSwitch } from './runner-link-required';
import { RunnerLinkGatewayGuard } from './runner-link-token.controller';

/** PUT's body: whether the runner daemon's routes are served only over the runner link. */
export class SetRunnerLinkRequiredDto {
  @IsBoolean()
  required!: boolean;
}

/** GET /api/runner/link/mode: the switch, as the link gateway reads it. */
export interface RunnerLinkModeResponse {
  required: boolean;
}

/**
 * RUNNER_LINK_REQUIRED in the administrators' area (runner-link-required.ts): read it, and switch it. Gated like the
 * runner dispatch pause: a signed-in ADMIN, never an access token. The cut-over (docs/runner-link-design.md §11.3)
 * and its first rollback (§11.4) drive it with curl and a login token:
 *
 *   curl -H "Authorization: Bearer $TOKEN" https://<host>/api/admin/runner-link-required
 *   curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
 *     -d '{"required":true}' https://<host>/api/admin/runner-link-required
 *
 * The replica that takes the PUT refuses HTTPS daemon calls at once, every other within a second, and the link
 * gateway tells runners the new mode within its next read of GET /api/runner/link/mode. Nothing is restarted.
 */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@PatForbidden('ADMIN')
@Controller('admin/runner-link-required')
export class RunnerLinkRequiredController {
  constructor(private readonly linkSwitch: RunnerLinkSwitch) {}

  /** Whether it is on, when it was last switched and by whom. */
  @Get()
  read() {
    return this.linkSwitch.read();
  }

  /** Switch it; answered with what GET answers. */
  @Put()
  set(@CurrentUser() admin: AuthUser, @Body() dto: SetRunnerLinkRequiredDto) {
    return this.linkSwitch.set(admin.userId, dto.required);
  }
}

/**
 * GET /api/runner/link/mode: the switch, read from its row for the link gateway, which tells runners MODE_LINK while it
 * is on and MODE_HTTP while it is off (src/link-gateway/mode.go). The gateway's door: the secret RUNNER_LINK_GATEWAY_TOKEN
 * names, and 404 while the link is off. A row that cannot be read is an error, never an answer of off, so the gateway
 * keeps the mode it last read.
 */
@UseGuards(RunnerLinkGatewayGuard)
@Controller('runner/link')
export class RunnerLinkModeController {
  constructor(private readonly linkSwitch: RunnerLinkSwitch) {}

  @Get('mode')
  async mode(): Promise<RunnerLinkModeResponse> {
    return { required: (await this.linkSwitch.read()).required };
  }
}

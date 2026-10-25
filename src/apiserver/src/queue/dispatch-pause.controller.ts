import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { DispatchPauseService } from './dispatch-pause.service';

/** PUT's body: whether runner dispatch is paused. */
export class SetDispatchPauseDto {
  @IsBoolean()
  paused!: boolean;
}

/**
 * The runner dispatch pause in the administrators' area (queue/dispatch-pause.ts): read it with the work
 * still running, and switch it. Gated like the user-management area: a signed-in ADMIN, never an access
 * token. The link cut-over (docs/runner-link-design.md §11.3) drives it with curl and a login token:
 *
 *   curl -H "Authorization: Bearer $TOKEN" https://<host>/api/admin/dispatch-pause
 *   curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
 *     -d '{"paused":true}' https://<host>/api/admin/dispatch-pause
 *
 * The switch takes effect on every replica the moment it commits; nothing is restarted.
 */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@PatForbidden('ADMIN')
@Controller('admin/dispatch-pause')
export class DispatchPauseController {
  constructor(private readonly pause: DispatchPauseService) {}

  /** Whether dispatch is paused, and the turns, integration jobs and merges/commits still running, each with how long. */
  @Get()
  read() {
    return this.pause.read();
  }

  /** Switch it; answered with what GET answers. Turning it off delivers what it held, and wakes it once. */
  @Put()
  set(@CurrentUser() admin: AuthUser, @Body() dto: SetDispatchPauseDto) {
    return this.pause.set(admin.userId, dto.paused);
  }
}

import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { TaskRerunCheckService } from './task-rerun-check.service';

/**
 * Re-run the check on a FAILED EXECUTABLE task (docs/task-run-sidebar-design.md, D3 = A): its acceptance command runs
 * once more in its latest run session, and no agent turn starts. No body: the press's identity is derived by the
 * server (`rerunCheckClientTurnId`), so a double press or a retried request queues one round.
 */
@UseGuards(JwtAuthGuard)
@Controller('tasks/:id/rerun-check')
export class TaskRerunCheckController {
  constructor(private readonly rerunCheck: TaskRerunCheckService) {}

  @PatScope('tasks:write', { workspaceConfinable: { params: { id: 'task' } } })
  @Post()
  rerun(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.rerunCheck.rerun(user.userId, id);
  }
}

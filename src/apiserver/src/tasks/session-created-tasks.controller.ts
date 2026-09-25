import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdPipe } from '../common/public-id';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { SessionCreatedTasksService } from './session-created-tasks.service';

/**
 * A session-scoped read that lives with the tasks rather than in `SessionsController`: it is answered
 * by `TasksService.withRunning`, and the sessions module cannot import the tasks module (the tasks
 * module imports it). Two path segments, so it never competes with that controller's `:id`.
 */
@UseGuards(JwtAuthGuard)
@Controller('sessions')
export class SessionCreatedTasksController {
  constructor(private readonly createdTasks: SessionCreatedTasksService) {}

  /**
   * The tasks this session's agent created, as its "Tasks created here" row draws them
   * (`SessionCreatedTasks`, @orbit/shared). `limit` caps `items` (default 20, at most 50) and
   * nothing else. Another account's session answers 404, exactly as a missing one does.
   */
  @Get(':id/created-tasks')
  read(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.createdTasks.read(user.userId, id, limit);
  }
}

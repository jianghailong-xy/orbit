import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { CoordinatorHandoffView, CoordinatorPendingWait } from '@orbit/shared';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { CoordinatorHandoffService } from './coordinator-handoff.service';
import { ProjectsService } from './projects.service';

/**
 * "Start a new coordinator" with a handoff note (board 02, docs/coordinator-handoff.md). A
 * controller of its own, for the reason `ProjectDoneNotYetController` is one: `ProjectsController`
 * is built positionally and by token in several specs, and none of these routes needs its CRUD.
 *
 * Every POST answers the handoff as it then stands (`CoordinatorHandoffView`); the sessions it
 * touches publish `session.updated`, whose summary carries `coordinatorHandoff` and
 * `coordinatorHandoffReceived`.
 */
@UseGuards(JwtAuthGuard)
@Controller('projects')
export class CoordinatorHandoffController {
  constructor(
    private readonly handoffs: CoordinatorHandoffService,
    private readonly projects: ProjectsService,
  ) {}

  /** The waits a handover would move — ACTIVE and PAUSED, the latter marked — for the confirm dialog. */
  @PatScope('projects:read', { workspaceConfinable: false })
  @Get(':id/coordinator/pending-waits')
  pendingWaits(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<CoordinatorPendingWait[]> {
    return this.projects.coordinatorPendingWaits(user.userId, id);
  }

  /** Hand over: the current coordinator writes its note (after a running turn), then the successor opens. */
  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/coordinator/handoff')
  @HttpCode(200)
  start(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<CoordinatorHandoffView> {
    return this.handoffs.start(user.userId, id);
  }

  /** Skip the note / Hand over without a note: the replacement now, with no note. */
  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/coordinator/handoff/skip')
  @HttpCode(200)
  skip(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<CoordinatorHandoffView> {
    return this.handoffs.skip(user.userId, id);
  }

  /** Cancel handover / Keep this coordinator: nothing changes. */
  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/coordinator/handoff/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<CoordinatorHandoffView> {
    return this.handoffs.cancel(user.userId, id);
  }

  /** Try again: after a failure, the note turn again. */
  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/coordinator/handoff/retry')
  @HttpCode(200)
  retry(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<CoordinatorHandoffView> {
    return this.handoffs.retry(user.userId, id);
  }
}

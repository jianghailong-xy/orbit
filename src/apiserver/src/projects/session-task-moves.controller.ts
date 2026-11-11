import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden, PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { DecideTaskMoveBatchDto } from './dto';
import { ProjectHandoffService } from './project-handoff.service';

/**
 * The task-move card a session draws, and the one answer it gives for a whole batch.
 *
 * A session draws the MOVE_TASK requests it asked for and those into a project it coordinates, in
 * batches (same asker, same source and target project). Separate from `ProjectsController` for the
 * reason `ProjectDoneNotYetController` gives: that one is built positionally by several specs.
 */
@UseGuards(JwtAuthGuard)
@Controller('sessions')
export class SessionTaskMovesController {
  constructor(private readonly handoffs: ProjectHandoffService) {}

  /** Every waiting batch, then the latest answered ones, each with every move it holds. */
  @PatScope('projects:read', { workspaceConfinable: false })
  @Get(':id/task-moves')
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
  ) {
    return this.handoffs.listMovesForSession(user.userId, id);
  }

  /**
   * Approve or deny a whole batch. The person, and only the person, as for one crossing
   * (`POST /projects/:id/handoffs/:handoffId/decision`). Every move is sent with the crossing key
   * the card was drawn from; if any key names another crossing or any move is no longer waiting,
   * nothing is written and the 409 names each one. Approving applies every move in one transaction.
   */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post(':id/task-moves/decision')
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: DecideTaskMoveBatchDto,
  ) {
    return this.handoffs.decideBatch(
      user.userId, user.userId, id, dto.decision, dto.moves, new Date(), user.credential,
    );
  }
}

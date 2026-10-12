import { Body, Controller, Headers, Param, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { DeclineDoneRequestDto } from './dto';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * The owner's "Not yet…" door for a coordinator's `DONE_REQUEST`.
 *
 * This controller is intentionally separate from `ProjectsController`.  That controller is built
 * positionally by several hand-written specs; adding the open-item door there would make its
 * constructor a breaking dependency even though the route itself has no relation to the project's
 * ordinary CRUD methods.
 */
@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectDoneNotYetController {
  constructor(private readonly openItems: ProjectOpenItemService) {}

  /**
   * End the card as RESOLVED / DECLINED and tell the project's current coordinator what is missing.
   * An acting session is passed through so the service applies the same owner-only rule as
   * `POST /projects/:id/done`.
   */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post(':id/done-requests/:itemId/decline')
  decline(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('itemId', PublicIdPipe) itemId: string,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
    @Body() dto: DeclineDoneRequestDto,
  ) {
    return this.openItems.declineDoneRequest(user.userId, id, itemId, dto, actingSessionId);
  }
}


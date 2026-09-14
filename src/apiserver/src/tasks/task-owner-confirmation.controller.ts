import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { DecideOwnerConfirmationDto } from './dto';
import { TaskOwnerConfirmationService } from './task-owner-confirmation.service';

/**
 * The app's face of the fourth criterion: what an OWNER_CONFIRMED task is waiting on, and the
 * account owner's Confirm done / Send back.
 *
 * The session header is read here only to refuse it. The app sends none; a request that carries one
 * is being made by an agent session, and an agent session cannot confirm a task this criterion keeps
 * for its owner — whose credential it is holding does not change who is deciding.
 */
@UseGuards(JwtAuthGuard)
@Controller('tasks/:taskId/owner-confirmation')
export class TaskOwnerConfirmationController {
  constructor(private readonly confirmations: TaskOwnerConfirmationService) {}

  @Get()
  read(@CurrentUser() user: AuthUser, @Param('taskId', PublicIdPipe) taskId: string) {
    return this.confirmations.read(user.userId, taskId);
  }

  @Post()
  decide(
    @CurrentUser() user: AuthUser,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
    @Body() dto: DecideOwnerConfirmationDto,
  ) {
    return this.confirmations.decide(
      user.userId,
      taskId,
      { door: 'USER', userId: user.userId, actingSessionId },
      dto,
    );
  }
}

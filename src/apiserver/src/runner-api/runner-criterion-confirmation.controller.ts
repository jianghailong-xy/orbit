import { Body, Controller, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import {
  ConfirmCriterionDto,
  ReportCriterionCheckDto,
  StartCriterionCheckDto,
} from '../projects/dto';
import { ProjectCriterionConfirmationService } from '../projects/project-criterion-confirmation.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The agent side of a CONFIRMATION criterion (migration 0545).
 *
 * Confirm, withdraw and start a check are the project coordinator's: X-Orbit-Session-Id is the
 * authority, checked by the service against the project's own coordinator pointer, and a missing
 * header is refused rather than read as the owner. The report is the check session's own: the
 * header names the session, and the session's task names the attempt it settles.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerCriterionConfirmationController {
  constructor(private readonly confirmations: ProjectCriterionConfirmationService) {}

  @Post('projects/:id/criteria/:criterionId/confirmations')
  @HttpCode(200)
  confirm(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Param('criterionId', PublicIdPipe) criterionId: string,
    @Body() dto: ConfirmCriterionDto,
  ) {
    return this.confirmations.confirm(
      runner.ownerId, id, criterionId, { kind: 'COORDINATOR', sessionId }, dto,
    );
  }

  @Post('projects/:id/criteria/:criterionId/confirmations/withdraw')
  @HttpCode(200)
  withdraw(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Param('criterionId', PublicIdPipe) criterionId: string,
  ) {
    return this.confirmations.withdraw(runner.ownerId, id, criterionId, { kind: 'COORDINATOR', sessionId });
  }

  @Post('projects/:id/criteria/:criterionId/checks')
  startCheck(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Param('criterionId', PublicIdPipe) criterionId: string,
    @Body() dto: StartCriterionCheckDto,
  ) {
    return this.confirmations.startCheck(
      runner.ownerId, id, criterionId, { kind: 'COORDINATOR', sessionId }, dto,
    );
  }

  @Post('criterion-checks/report')
  @HttpCode(200)
  report(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: ReportCriterionCheckDto,
  ) {
    return this.confirmations.reportCheck(runner.ownerId, sessionId, dto);
  }
}

import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpException,
  Optional,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden, PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import {
  IntegrationJobRelay,
  integrationAbandonHttpError,
} from '../runner-api/integration-job-relay';
import { INTEGRATION_ABANDON_OWNER_CHANNEL_ONLY } from './project-integration-abandon';
import { RetryIntegrationDto, SkipMergeCheckAsOwnerDto } from './dto';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * The account owner's doors for rerunning a failed integration.
 *
 * This is deliberately a separate controller: ProjectsController is constructed by a number of
 * hand-written specs, and adding a dependency there makes those unrelated specs fail before they
 * can exercise their own route. Both routes use the same service decisions as the runner's
 * coordinator doors; the service records this press as a USER request.
 */
@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectIntegrationRetryController {
  constructor(
    private readonly openItems: ProjectOpenItemService,
    // Provided by ProjectsModule for the abandon door. Optional so the hand-built specs that
    // exercise the retry routes with the item service alone keep constructing this controller.
    @Optional() private readonly integrationJobs?: IntegrationJobRelay,
  ) {}

  /** Rerun the next LAND_TASK generation for a failed task landing. */
  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/tasks/:taskId/integration/retry')
  @HttpCode(200)
  retryIntegration(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) projectId: string,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Body() dto: RetryIntegrationDto,
  ) {
    return this.openItems.retryIntegrationAsOwner(user.userId, projectId, taskId, dto);
  }

  /**
   * Queue one landing again with its merge check NOT RUN (§2.4 J-S5).
   *
   * The account owner's own act, and the reason it needs no card: a skip is approved by them, and
   * asking them to answer their own question is not a gate. Every other rule of the door is the
   * service's own and is the same one the coordinator's card-gated route meets.
   */
  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/tasks/:taskId/integration/skip-merge-check')
  @HttpCode(200)
  skipIntegrationMergeCheck(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) projectId: string,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Body() dto: SkipMergeCheckAsOwnerDto,
  ) {
    return this.openItems.skipIntegrationMergeCheckAsOwner(user.userId, projectId, taskId, dto);
  }

  /**
   * Retry a job the integration view calls timed out — the Retry on the landing row's job list
   * (§2.2 J-T9). No body: the job's own facts are the reason, and the server writes it. Answers with
   * the integration view, read after the retry.
   */
  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/integration/jobs/:jobId/retry')
  @HttpCode(200)
  retryTimedOutJob(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) projectId: string,
    @Param('jobId', PublicIdPipe) jobId: string,
  ) {
    return this.openItems.retryTimedOutJobAsOwner(user.userId, projectId, jobId);
  }

  /** Rerun a blocked candidate's failed check, leaving its merge decision untouched. */
  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/promotions/:promotionId/integration/retry')
  @HttpCode(200)
  retryPromotionCheck(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) projectId: string,
    @Param('promotionId', PublicIdPipe) promotionId: string,
    @Body() dto: RetryIntegrationDto,
  ) {
    return this.openItems.retryPromotionCheckAsOwner(user.userId, projectId, promotionId, dto);
  }

  /**
   * Abandon a running job whose runner has stopped reporting (J-T10, §4.7).
   *
   * The owner's own door: the account owner's credential, and an acting session is refused whole —
   * an agent that wants a job abandoned has its own door (`integration_abandon`), which checks the
   * acting session against the project's current coordinator. The gate is the server's: the claim's
   * lease must have expired by §7.2 V6's one definition, and the job must be RUNNING. The job ends
   * as `ERROR` with J12's code, and nothing is re-queued, for all three kinds of job.
   */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post(':id/integration/jobs/:jobId/abandon')
  @HttpCode(200)
  async abandonIntegrationJob(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) projectId: string,
    @Param('jobId', PublicIdPipe) jobId: string,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
  ) {
    if (actingSessionId?.trim()) {
      throw new ForbiddenException({
        code: INTEGRATION_ABANDON_OWNER_CHANNEL_ONLY,
        message:
          'the owner\'s abandon door does not take an acting session. A coordinator abandons through '
          + 'its own door (integration_abandon), which the server checks against the project\'s '
          + 'current coordinator conversation.',
      });
    }
    if (!this.integrationJobs) {
      throw new HttpException(
        { code: 'INTEGRATION_QUEUE_UNAVAILABLE', message: 'this control plane runs no integration queue' },
        503,
      );
    }
    try {
      const applied = await this.integrationJobs.abandon({
        jobId, projectId, ownerId: user.userId, by: 'owner',
      });
      if (applied.after) await this.openItems.deliverForItems(applied.after.openItemIds);
      return applied.abandoned;
    } catch (error) {
      throw integrationAbandonHttpError(error);
    }
  }

  /**
   * Stop a task's in-flight landing (J-T8, §4.7): `QUEUED` ends `CANCELLED` on the spot, a RUNNING
   * claim inside its window is asked and answers (J-T12), and one already past its lease is ended as
   * `ERROR` with J12's code. Past the push boundary the stop is refused — the merge may already have
   * happened — and with nothing in flight there is nothing to stop. The task itself is not settled.
   */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post(':id/tasks/:taskId/integration/stop')
  @HttpCode(200)
  stopTaskIntegration(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) projectId: string,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
  ) {
    return this.openItems.stopTaskIntegrationAsOwner(
      user.userId, projectId, taskId, actingSessionId,
    );
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import type {
  ConfirmCriterionDto,
  ReportCriterionCheckDto,
  StartCriterionCheckDto,
} from './dto';
import {
  CRITERION_CONFIRMATION_SELECT,
  criterionConfirmationStanding,
  type CriterionConfirmationStanding,
  type CriterionConfirmerKindValue,
} from './project-criterion-confirmation';
import { refreshProjectDone } from './project-done-request';

/** Who is acting at one of these doors. */
export type CriterionConfirmationActor =
  | { kind: 'OWNER' }
  | { kind: 'COORDINATOR'; sessionId: string | undefined };

/** What every door answers with: the row it wrote and where the criterion stands afterwards. */
export interface CriterionConfirmationResult {
  definitionId: string;
  revision: number;
  confirmation: CriterionConfirmationStanding;
}

export const CRITERION_NOT_CONFIRMATION_MODE = 'CRITERION_NOT_CONFIRMATION_MODE';
export const CRITERION_REVISION_MOVED = 'CRITERION_REVISION_MOVED';
export const CRITERION_CONFIRMATION_COORDINATOR_ONLY = 'CRITERION_CONFIRMATION_COORDINATOR_ONLY';
export const CRITERION_NOTHING_TO_WITHDRAW = 'CRITERION_NOTHING_TO_WITHDRAW';
export const CRITERION_CHECK_NOT_FOUND = 'CRITERION_CHECK_NOT_FOUND';
export const CRITERION_CHECK_NO_WORKSPACE = 'CRITERION_CHECK_NO_WORKSPACE';

/** The MCP tool a check session reports through. Named once: the prompt quotes it. */
export const CRITERION_CHECK_REPORT_TOOL = 'criterion_check_report';

/**
 * The doors of a CONFIRMATION criterion (migration 0545, owner decisions 2026-11-11).
 *
 *  - The owner confirms or withdraws over REST; the project's coordinator does the same through
 *    `criterion_confirm` / `criterion_confirmation_withdraw`. A coordinator is the conversation the
 *    project points at (`project.coordinatorSessionId`) and nobody else.
 *  - An Agent check is a run started for the criterion. It is dispatched as an ordinary task of the
 *    project — the run machinery every task uses: workspace, runner, worktree, attempt budget —
 *    which serves no criterion (so it is never counted as TASKS work), settles itself when its turn
 *    ends (EXECUTABLE, `true`), and whose session reports PASS or FAIL through
 *    `criterion_check_report`. The PENDING row written at the start is what that report settles:
 *    PASS makes it an AGENT_CHECK confirmation, FAIL a failed attempt.
 *
 * Every write re-projects the project's DONE afterwards (`refreshProjectDone`), since a
 * confirmation can be the last thing a project was waiting for and a withdrawal can take it away.
 */
@Injectable()
export class ProjectCriterionConfirmationService {
  private readonly logger = new Logger(ProjectCriterionConfirmationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly sessions?: SessionsService,
    @Optional() private readonly push?: PushService,
  ) {}

  async confirm(
    ownerId: string,
    projectId: string,
    definitionId: string,
    actor: CriterionConfirmationActor,
    dto: ConfirmCriterionDto,
  ): Promise<CriterionConfirmationResult> {
    const { definition, sessionId } = await this.admit(ownerId, projectId, definitionId, actor);
    if (dto.revision !== undefined && dto.revision !== definition.revision) {
      throw new ConflictException({
        code: CRITERION_REVISION_MOVED,
        message: `criterion is on revision ${definition.revision}, not ${dto.revision}: re-read it `
          + 'before confirming, since what you checked is not what it says now',
      });
    }
    const attachmentIds = await this.ownAttachments(ownerId, dto.attachmentIds);
    const now = new Date();
    await this.prisma.projectCriterionConfirmation.create({
      data: {
        ownerId,
        projectId,
        definitionId,
        revision: definition.revision,
        confirmerKind: actor.kind,
        outcome: 'CONFIRMED',
        sessionId,
        note: dto.note?.trim() || null,
        attachmentIds,
        createdAt: now,
        settledAt: now,
      },
    });
    return this.answer(ownerId, projectId, definitionId);
  }

  /**
   * Take back every standing confirmation of the criterion's current revision. A coordinator may
   * withdraw the owner's too: taking a confirmation away can only make the criterion unmet.
   */
  async withdraw(
    ownerId: string,
    projectId: string,
    definitionId: string,
    actor: CriterionConfirmationActor,
  ): Promise<CriterionConfirmationResult> {
    const { definition } = await this.admit(ownerId, projectId, definitionId, actor);
    const withdrawn = await this.prisma.projectCriterionConfirmation.updateMany({
      where: {
        definitionId,
        revision: definition.revision,
        outcome: 'CONFIRMED',
        withdrawnAt: null,
      },
      data: { withdrawnAt: new Date(), withdrawnByKind: actor.kind },
    });
    if (withdrawn.count === 0) {
      throw new ConflictException({
        code: CRITERION_NOTHING_TO_WITHDRAW,
        message: `criterion has no standing confirmation of its revision ${definition.revision} to withdraw`,
      });
    }
    return this.answer(ownerId, projectId, definitionId);
  }

  /** Start an Agent check of the criterion's current revision. */
  async startCheck(
    ownerId: string,
    projectId: string,
    definitionId: string,
    actor: CriterionConfirmationActor,
    dto: StartCriterionCheckDto,
  ): Promise<CriterionConfirmationResult & { checkTaskId: string; run: unknown }> {
    if (!this.tasks) throw new Error('ProjectCriterionConfirmationService was built without TasksService');
    const { definition, project } = await this.admit(ownerId, projectId, definitionId, actor);
    const workspaceId = dto.workspaceId
      ?? (await this.prisma.projectMember.findFirst({
        where: { projectId, role: 'COORDINATOR' },
        select: { agentId: true },
      }))?.agentId;
    if (!workspaceId) {
      throw new BadRequestException({
        code: CRITERION_CHECK_NO_WORKSPACE,
        message: 'this project has no coordinator workspace to run the check in: name a workspaceId',
      });
    }
    const task = await this.tasks.create(ownerId, {
      title: `Agent check: criterion ${definition.ordinal} (revision ${definition.revision})`,
      description: checkPrompt(project.title, definition, dto.instructions),
      projectId,
      assigneeId: workspaceId,
      codeless: true,
      codelessReason: 'An Agent check reads and reports; it changes no code.',
      completionCriterion: 'EXECUTABLE',
      acceptanceCriteria: `The check reported PASS or FAIL through ${CRITERION_CHECK_REPORT_TOOL}.`,
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
      autoRunWhenReady: false,
    } as never) as { id: string };
    await this.prisma.projectCriterionConfirmation.create({
      data: {
        ownerId,
        projectId,
        definitionId,
        revision: definition.revision,
        confirmerKind: 'AGENT_CHECK',
        outcome: 'PENDING',
        checkTaskId: task.id,
      },
    });
    const run = await this.tasks.execute(ownerId, task.id);
    return { ...(await this.answer(ownerId, projectId, definitionId)), checkTaskId: task.id, run };
  }

  /** The check session's verdict, settling the attempt its task was started for. */
  async reportCheck(
    ownerId: string,
    actingSessionId: string | undefined,
    dto: ReportCriterionCheckDto,
  ): Promise<CriterionConfirmationResult & { outcome: 'CONFIRMED' | 'FAILED' }> {
    const sessionId = actingSessionId?.trim();
    const session = sessionId
      ? await this.prisma.session.findFirst({ where: { id: sessionId, ownerId }, select: { taskId: true } })
      : null;
    const attempt = session?.taskId
      ? await this.prisma.projectCriterionConfirmation.findFirst({
        where: { ownerId, checkTaskId: session.taskId, outcome: 'PENDING', withdrawnAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, projectId: true, definitionId: true },
      })
      : null;
    if (!attempt) {
      throw new NotFoundException({
        code: CRITERION_CHECK_NOT_FOUND,
        message: 'this session is not running an Agent check that is waiting for a verdict',
      });
    }
    const attachmentIds = await this.ownAttachments(ownerId, dto.attachmentIds);
    const outcome = dto.verdict === 'PASS' ? 'CONFIRMED' : 'FAILED';
    const settled = await this.prisma.projectCriterionConfirmation.updateMany({
      where: { id: attempt.id, outcome: 'PENDING' },
      data: {
        outcome,
        sessionId,
        note: dto.note?.trim() || null,
        attachmentIds,
        settledAt: new Date(),
      },
    });
    if (settled.count === 0) {
      throw new ConflictException({
        code: CRITERION_CHECK_NOT_FOUND,
        message: 'this Agent check has already reported its verdict',
      });
    }
    return {
      ...(await this.answer(ownerId, attempt.projectId, attempt.definitionId)),
      outcome,
    };
  }

  /** The criterion, checked to be this project's and in CONFIRMATION mode, and the actor admitted. */
  private async admit(
    ownerId: string,
    projectId: string,
    definitionId: string,
    actor: CriterionConfirmationActor,
  ) {
    const definition = await this.prisma.projectAcceptanceCriterionDefinition.findFirst({
      where: { id: definitionId, projectId, project: { ownerId } },
      select: {
        id: true,
        ordinal: true,
        text: true,
        verificationMethod: true,
        revision: true,
        satisfiedBy: true,
        project: { select: { title: true, coordinatorSessionId: true } },
      },
    });
    if (!definition) throw new NotFoundException('criterion not found in this project');
    let sessionId: string | null = null;
    if (actor.kind === 'COORDINATOR') {
      const acting = actor.sessionId?.trim();
      if (!acting || acting !== definition.project.coordinatorSessionId) {
        throw new ForbiddenException({
          code: CRITERION_CONFIRMATION_COORDINATOR_ONLY,
          message: 'only the conversation coordinating this project may confirm, withdraw or check '
            + 'its criteria; the owner does it from the project page',
        });
      }
      sessionId = acting;
    }
    if (definition.satisfiedBy !== 'CONFIRMATION') {
      throw new ConflictException({
        code: CRITERION_NOT_CONFIRMATION_MODE,
        message: 'this criterion is met by its tasks, not by confirmation: set its satisfiedBy to '
          + 'CONFIRMATION with project_update first',
      });
    }
    return { definition, project: definition.project, sessionId };
  }

  private async ownAttachments(ownerId: string, ids: string[] | undefined): Promise<string[]> {
    const unique = [...new Set(ids ?? [])];
    if (unique.length === 0) return [];
    const own = await this.prisma.attachment.count({ where: { id: { in: unique }, ownerId } });
    if (own !== unique.length) {
      throw new NotFoundException('attachmentIds names an upload this account does not have');
    }
    return unique;
  }

  /** The post-commit edge every write ends on: a confirmation can be the last thing a project was
   *  waiting for, and a withdrawal can take DONE away. Never a condition of the write. */
  protected async reproject(ownerId: string, projectId: string): Promise<void> {
    await refreshProjectDone(this.prisma, ownerId, projectId, {
      sessions: this.sessions,
      push: this.push,
    }).catch((error) => this.logger.warn(`project ${projectId} done not re-projected: ${
      error instanceof Error ? error.message : error}`));
  }

  /** Where the criterion stands now, and the project's DONE re-projected from it. */
  private async answer(
    ownerId: string,
    projectId: string,
    definitionId: string,
  ): Promise<CriterionConfirmationResult> {
    const row = await this.prisma.projectAcceptanceCriterionDefinition.findFirstOrThrow({
      where: { id: definitionId },
      select: { revision: true, confirmations: CRITERION_CONFIRMATION_SELECT },
    });
    await this.reproject(ownerId, projectId);
    return {
      definitionId,
      revision: row.revision,
      confirmation: criterionConfirmationStanding(row.revision, row.confirmations),
    };
  }
}

/** What the check's run is told. */
export function checkPrompt(
  projectTitle: string,
  definition: { ordinal: number; revision: number; text: string; verificationMethod: string },
  instructions?: string,
): string {
  return [
    `You are running an Agent check of acceptance criterion ${definition.ordinal} of the project `
      + `"${projectTitle}". Nobody else is deciding this criterion right now: your verdict is the `
      + 'answer, and a PASS records it as confirmed.',
    '',
    `Criterion (revision ${definition.revision}): ${definition.text}`,
    `Verification method: ${definition.verificationMethod}`,
    ...(instructions?.trim() ? ['', `Instructions from whoever started the check: ${instructions.trim()}`] : []),
    '',
    'Decide whether the criterion holds by following its verification method. Read and run what the '
      + 'method asks; do not change code or project state to make it hold.',
    `When you have decided, call the MCP tool ${CRITERION_CHECK_REPORT_TOOL} once, with verdict `
      + 'PASS or FAIL and a note saying what you checked and what you found. Report FAIL whenever '
      + 'you could not establish that the criterion holds.',
  ].join('\n');
}

export type { CriterionConfirmerKindValue };

import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
  HttpException,
  Controller,
  Logger,
  ForbiddenException,
  HttpCode,
  NotFoundException,
  Optional,
  Param,
  Get,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  type AgentExecConfig,
  type RemoteSubagentClaim,
  type RemoteSubagentEventBatch,
  type RemoteSubagentEventsPage,
  type SubagentRemoteRunCreateResponse,
  type SubagentCandidateTarget,
  type SubagentDecision,
  type SubagentFallbackResponse,
  type SubagentRatingResponse,
  type SubagentRunCreateResponse,
  type SubagentRunStatus,
  type SubagentRunUpdateResponse,
  SUBAGENT_REMOTE_RESUME_V1,
} from '@orbit/shared';
import { Prisma, type Runner } from '@prisma/client';
import { TURN_STATE_SELECT } from '../sessions/session-legacy-words';
import { PublicIdPipe } from '../common/public-id';
import {
  ALWAYS_ALLOWED_TOOLS,
  isWiderThanParent,
  modesASubagentMayRunIn,
  resolvePermissionMode,
  subagentChildMode,
  widerModeRefusal,
} from '../common/permission-mode';
import { dispatchAllowedTools } from '../common/permission-rules';
import { normalizeBuiltinPermissionMode, normalizeEffortForRuntimeModel } from '../common/runtime-provider';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { QueueService } from '../queue/queue.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { reapApprovalsOfEndedSubagents } from '../sessions/abandoned-approvals';
import { runAccessLevel, scheduleRunDisallowedTools, scheduleRunPermissionMode } from '../schedules/schedule-access';
import { assertEngineSession } from '../sessions/engine-session';
import { SessionsService } from '../sessions/sessions.service';
import { RealtimeService } from '../realtime/realtime.service';
import { sessionProviderExec, type SubagentPoolMemberChoice } from './session-provider-exec';
import { stripNul } from './strip-nul';
import {
  ACCOUNT_REFUSAL_OUTCOMES,
  attemptsOf,
  countedMoves,
  fallbackCandidates,
  firstAttempt,
  movableFailure,
  moveReason,
  noProviderMessage,
  appliedDecision,
  SUBAGENT_ATTEMPT_ERROR_MAX,
  SUBAGENT_MAX_MOVES,
  SubagentFallbackDto,
  SubagentRunCreateDto,
  SubagentRunUpdateDto,
  subjectOfKey,
  TRIAL_HELD_REASON,
  type TrialAttempt,
  trialSubject,
  truncateResultSummary,
} from './subagent-run';
import { AccountHealthService, claimTrialByKey } from '../providers/account-health.service';
import { uuidv7 } from '../drive/drive.service';
import type { SubagentAttempt } from '@orbit/shared';
import { planSubagentRoute } from './subagent-route';
import {
  chooseSubagentWorkspace,
  neededCapabilities,
  notGitRefusal,
  planRemoteSubagent,
  readRelayBatch,
  remoteFactsOf,
  remoteRunEndRefusal,
  remoteSubagentExec,
  rewriteRemoteSubagentEvent,
  runOfTarget,
  STOPPED_BEFORE_CLAIM_RESULT,
  SUBAGENT_RELAY_BATCH_MAX,
  type SubagentRemoteFacts,
  type SubagentWorkspacePick,
} from './subagent-remote';
import { sessionHasEnded } from './background-job-wake';
import { fileSubagentWake, fileWorkflowWake } from './subagent-wake';
import { rateSubagentRun, SubagentRatingDto } from './subagent-rating';
import { WORKFLOW_SCRIPT_MAX_BYTES, WorkflowRunCreateDto, WorkflowRunUpdateDto } from './workflow-run';
import { isReleased } from '../common/session-release';

/** How a SubAgent's child runs on one candidate: the claim-shaped config, and what it resolved to. */
interface ChildExec {
  exec: AgentExecConfig;
  provider: string;
  resolvedModel: string;
  effort: string | undefined;
  /** The account of an account pool chosen for this SubAgent alone. */
  poolMember?: SubagentPoolMemberChoice;
}

/** What a resumed run on this machine was opened under: its last attempt's target, never routed (resumeInPlace). */
export const SUBAGENT_RESUME_POLICY_VERSION = 'subagent-resume-v1';

/** A refusal's own words. */
function refusalText(error: HttpException): string {
  const said = error.getResponse();
  return typeof said === 'string' ? said : (said as { message?: string }).message ?? error.message;
}

/** What a SubAgent's run reads of its parent session. */
const SUBAGENT_PARENT_SELECT = {
  ownerId: true,
  // The release column: a released parent opens no SubAgent run (common/session-release.ts).
  finishedAt: true,
  workspaceId: true,
  assignedRunnerId: true,
  provider: true,
  effort: true,
  permissionMode: true,
  scheduleRun: { select: { accessLevel: true, schedule: { select: { accessLevel: true } } } },
  workspace: {
    select: {
      subagentsEnabled: true, subagentsMaxRunning: true, effort: true, permissionRules: true,
      disallowedTools: true,
    },
  },
  assignedRunner: { select: { modelCatalog: true } },
  owner: { select: { preferences: true } },
} satisfies Prisma.SessionSelect;
type SubagentParent = Prisma.SessionGetPayload<{ select: typeof SUBAGENT_PARENT_SELECT }>;

function assertSubagentsEnabled(workspace: { subagentsEnabled: boolean } | null): void {
  if (workspace?.subagentsEnabled === false) {
    throw new ForbiddenException({
      code: 'SUBAGENTS_DISABLED',
      message: 'SubAgents are turned off for this agent. Do the work in this session instead.',
    });
  }
}

/** A workflow needs its own switch on as well (workflowsOn); `delegate` reads only SubAgents. */
function assertWorkflowsEnabled(workspace: { workflowsEnabled: boolean } | null): void {
  if (workspace?.workflowsEnabled === false) {
    throw new ForbiddenException({
      code: 'WORKFLOWS_DISABLED',
      message: 'Workflows are turned off for this agent. Hand each piece of work to delegate, or do it in this session.',
    });
  }
}

/** Called under the session lock shared by workflow completion and SubAgent admission. */
async function assertWorkflowRunning(tx: Prisma.TransactionClient, sessionId: string, workflowRunId?: string): Promise<void> {
  if (!workflowRunId) return;
  const workflow = await tx.subagentWorkflowRun.findFirst({
    where: { id: workflowRunId, sessionId, status: 'RUNNING' },
    select: { id: true },
  });
  if (!workflow) {
    throw new ConflictException({ code: 'WORKFLOW_NOT_RUNNING', message: 'This session has no running workflow by that ID.' });
  }
}

/**
 * SubAgent runs (docs/subagent-design.md §5.1, §6.2), reached by `orbit mcp`'s `delegate` tool with the
 * machine's runner credential over HTTPS, like the rest of the agent tool API (docs/runner-link-design.md
 * D14). Only for a session this runner hosts: any other id, another account's included, is answered as an
 * id that names nothing.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerSubagentsController {
  private readonly logger = new Logger(RunnerSubagentsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly planUsage: ProviderPlanUsageService,
    /**
     * Files the wake a run's end owes its parent (subagent-wake.ts). `@Optional()` for the specs that build this
     * controller by hand; RunnerApiModule imports SessionsModule, so production always has it, and the wake
     * sweep files any wake this could not.
     */
    @Optional() private readonly sessions?: SessionsService,
    /** Marks a remote run's target runner changed, so its next beat over the runner link lists the run (§10.2). */
    @Optional() private readonly realtime?: RealtimeService,
    /** Told of each attempt's end (docs/routing-account-health-design.md §6.3); absent in hand-built specs. */
    @Optional() private readonly accountHealth?: AccountHealthService,
  ) {}

  /** Hand an attempt's end to account health (§6.3), on the parent's runner and workspace; never in the run's way. */
  private async attemptEnded(
    sessionId: string,
    runId: string,
    attempt: SubagentAttempt | undefined,
    end: { failed: boolean; error?: string; failure?: SubagentFallbackDto['failure']; admission?: boolean },
  ): Promise<void> {
    if (!this.accountHealth || !attempt) return;
    const parent = await this.prisma.session.findUnique({
      where: { id: sessionId }, select: { ownerId: true, assignedRunnerId: true, workspaceId: true },
    });
    if (!parent) return;
    const member = attempt.poolMember;
    await this.accountHealth.afterSubagentAttempt({
      ownerId: parent.ownerId,
      runId,
      runnerId: parent.assignedRunnerId,
      workspaceId: parent.workspaceId,
      attempt: {
        engine: attempt.engine, provider: attempt.provider, model: attempt.model,
        ...(member && 'providerId' in member ? { poolMember: { providerId: member.providerId } } : {}),
        ...(member && 'accountId' in member ? { poolMember: { accountId: member.accountId } } : {}),
      },
      failed: end.failed,
      error: end.error ?? null,
      failure: end.failure ?? null,
      admission: end.admission ?? null,
    });
  }

  /**
   * The trial an attempt claimed on its account (§6.5) ends with it: released, so it is due again, unless account
   * health already cleared the row (an admitted run) or released it with the refusal it took (recordFailure).
   * Never in the run's way.
   */
  private async releaseAttemptTrial(ownerId: string, runId: string, attempt: TrialAttempt | undefined): Promise<void> {
    const subject = attempt?.trialOf ? subjectOfKey(attempt.trialOf) : null;
    if (!this.accountHealth || !subject) return;
    try {
      await this.accountHealth.releaseTrial(ownerId, subject, runId);
    } catch (e) {
      this.logger.warn(`the trial SubAgent run ${runId} held was not released: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Mark a run's end as owing its parent a wake, whatever its status, and read the status back. */
  private recordWakeOwed(sessionId: string, runId: string): Promise<{ status: string } | null> {
    return withTransactionRetry(this.prisma, async (tx) => {
      await tx.subagentRun.updateMany({ where: { id: runId, sessionId, wakeFiledAt: null }, data: { wakeOwed: true } });
      return tx.subagentRun.findFirst({ where: { id: runId, sessionId }, select: { status: true } });
    }, loggedRetry(this.logger, 'runnerSubagents.recordWakeOwed'));
  }

  /** File a run's owed wake now, after the transaction that made it owed. A failure is the sweep's to retry. */
  private async fileWake(runId: string): Promise<void> {
    if (!this.sessions) return;
    try {
      await fileSubagentWake(this.prisma, this.sessions, runId);
    } catch (error) {
      this.logger.warn(`the wake for SubAgent run ${runId} was not filed yet: ${(error as Error).message}`);
    }
  }

  private async assertParentOfRunner(sessionId: string, runner: Runner): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { ownerId: true, assignedRunnerId: true, sessionKind: true },
    });
    // A delegate never runs inside the platform's landing container (§2.9 LS6); refused as the other doors refuse it.
    if (session && session.ownerId === runner.ownerId) assertEngineSession(session);
    if (!session || session.ownerId !== runner.ownerId || session.assignedRunnerId !== runner.id) {
      throw new NotFoundException('session not found');
    }
  }

  @Post('sessions/:id/workflows')
  @HttpCode(200)
  async openWorkflowRun(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: WorkflowRunCreateDto,
  ): Promise<{ workflowRunId: string; status: SubagentRunStatus }> {
    await this.assertParentOfRunner(sessionId, runner);
    if (Buffer.byteLength(dto.script, 'utf8') > WORKFLOW_SCRIPT_MAX_BYTES) {
      throw new BadRequestException('Workflow scripts must be at most 512 KB.');
    }
    if (dto.script.includes('\0')) {
      throw new BadRequestException('Workflow scripts must not contain null characters.');
    }
    return withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const where = { sessionId_toolUseId: { sessionId, toolUseId: dto.toolUseId } };
      const opened = await tx.subagentWorkflowRun.findUnique({ where, select: { id: true, status: true } });
      if (opened) return { workflowRunId: opened.id, status: opened.status as SubagentRunStatus };
      const session = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
          // What sessionHasEnded reads: the turn state's columns (sessions/session-legacy-words.ts) and the filing facts.
          ...TURN_STATE_SELECT,
          ownerId: true, endReason: true, completedAt: true, archivedAt: true, deletedAt: true,
          workspace: { select: { subagentsEnabled: true, workflowsEnabled: true } },
        },
      });
      if (sessionHasEnded(session)) throw new ConflictException('the session has ended');
      assertSubagentsEnabled(session.workspace);
      assertWorkflowsEnabled(session.workspace);
      const row = await tx.subagentWorkflowRun.create({
        data: {
          ownerId: session.ownerId,
          sessionId,
          toolUseId: dto.toolUseId,
          name: stripNul(dto.name),
          description: stripNul(dto.description),
          phases: stripNul(dto.phases ?? []),
          script: dto.script,
          scriptSha256: createHash('sha256').update(dto.script).digest('hex'),
          args: dto.args === null ? Prisma.JsonNull : stripNul(dto.args) as Prisma.InputJsonValue | undefined,
          maxCostUsd: dto.maxCostUsd,
        },
        select: { id: true, status: true },
      });
      return { workflowRunId: row.id, status: row.status as SubagentRunStatus };
    }, loggedRetry(this.logger, 'runnerSubagents.openWorkflowRun'));
  }

  @Patch('sessions/:id/workflows/:workflowRunId')
  async updateWorkflowRun(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('workflowRunId', PublicIdPipe) workflowRunId: string,
    @Body() dto: WorkflowRunUpdateDto,
  ): Promise<{ workflowRunId: string; status: SubagentRunStatus; applied: boolean }> {
    await this.assertParentOfRunner(sessionId, runner);
    const answer = await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const where = { id: workflowRunId, sessionId };
      const ended = await tx.subagentWorkflowRun.updateMany({
        where: { ...where, status: 'RUNNING' },
        data: {
          status: dto.status,
          result: truncateResultSummary(dto.result ?? undefined),
          error: truncateResultSummary(dto.error ?? undefined),
          costUsd: dto.costUsd ?? 0,
          callsDone: dto.callsDone ?? 0,
          callsFailed: dto.callsFailed ?? 0,
          wakeOwed: dto.wake === true,
          endedAt: new Date(),
        },
      });
      // Each SubAgent call already charged the session when it ended.
      if (ended.count === 1) return { workflowRunId, status: dto.status, applied: true };
      const row = await tx.subagentWorkflowRun.findFirst({ where, select: { status: true } });
      if (!row) throw new NotFoundException('Workflow run not found');
      return { workflowRunId, status: row.status as SubagentRunStatus, applied: false };
    }, loggedRetry(this.logger, 'runnerSubagents.updateWorkflowRun'));
    if (answer.applied && dto.wake && this.sessions) {
      try {
        await fileWorkflowWake(this.prisma, this.sessions, workflowRunId);
      } catch (error) {
        this.logger.warn(`the wake for workflow run ${workflowRunId} was not filed yet: ${(error as Error).message}`);
      }
    }
    return answer;
  }

  /**
   * A parent session's `mcp__orbit__delegate` call opens a SubAgent run (docs/subagent-design.md §5.1 step 2).
   * Refused when the session's Agent has SubAgents turned off (403 SUBAGENTS_DISABLED) or already runs as many
   * as it allows at once (409 SUBAGENT_LIMIT_REACHED), counted under the parent row's lock so two calls cannot
   * both take the last place. The router's decision (routeSubagent, §4.1, §4.2) applies (§8 P3): the answer runs
   * the child on the engine, credential, model and effort it picked, in the shape a claim hands the runner — or,
   * when the pick cannot be started on this runner, on the first of the tier's next candidates that can, the
   * pick recorded as removed with its reason. A pool with nothing in it, or nothing that can start, is refused
   * with 409 NO_SUBAGENT_PROVIDER listing each provider's reason; the SubAgent never falls back onto the
   * parent's model. The row is written RUNNING with that decision, and an account pool's member chosen for it
   * on its first attempt, never on the parent's session. A retry with the same tool_use id answers with the run
   * it opened, whose decision is frozen, on the candidate its last attempt runs on.
   *
   * A call that names a `workspace` or `needs` capabilities is placed first (docs/subagent-design.md §10.1,
   * chooseSubagentWorkspace): on another workspace of the owner's account it is opened there
   * (openRemoteSubagentRun), and answered without `exec`; on the parent's own it is opened here, the choice's
   * reason heading the Why. The refusals of §10.1 are thrown before anything is written.
   */
  @Post('sessions/:id/subagents')
  @HttpCode(200)
  async openSubagentRun(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: SubagentRunCreateDto,
  ): Promise<SubagentRunCreateResponse | SubagentRemoteRunCreateResponse> {
    await this.assertParentOfRunner(sessionId, runner);
    const opened = await this.prisma.subagentRun.findUnique({
      where: { sessionId_toolUseId: { sessionId, toolUseId: dto.toolUseId } },
    });
    // A retry answers with the run it opened, wherever it was placed.
    if (opened?.targetRunnerId) return this.remoteAnswer(opened);
    if (!opened && dto.resumeOf) {
      // One that ran on another workspace continues there (§10.2); one that ran on this machine, here (createSubagentRun).
      const original = await this.prisma.subagentRun.findFirst({ where: { id: dto.resumeOf, sessionId }, select: { targetRunnerId: true } });
      if (!original || original.targetRunnerId) return this.openRemoteResume(sessionId, dto, dto.resumeOf);
    }
    if (!opened && (dto.workspace?.trim() || neededCapabilities(dto.needs).length > 0)) {
      const parent = await this.prisma.session.findUniqueOrThrow({ where: { id: sessionId }, select: { ownerId: true, workspaceId: true } });
      const pick = await chooseSubagentWorkspace(this.prisma, {
        ownerId: parent.ownerId,
        parentWorkspaceId: parent.workspaceId,
        workspace: dto.workspace,
        needs: dto.needs,
        readonly: dto.readonly === true,
      });
      if (pick.kind === 'remote') return this.openRemoteSubagentRun(sessionId, dto, pick);
      return this.createSubagentRun(runner, sessionId, dto, pick.reason);
    }
    return this.createSubagentRun(runner, sessionId, dto);
  }

  /** A run on the parent's own machine (§5.1): openSubagentRun's local case, and what the specs open directly. */
  async createSubagentRun(
    runner: Runner,
    sessionId: string,
    dto: SubagentRunCreateDto,
    /** Why this machine was chosen for a call that asked for a workspace or capabilities (§10.1). */
    workspaceReason?: string | null,
  ): Promise<SubagentRunCreateResponse> {
    await this.assertParentOfRunner(sessionId, runner);
    return withTransactionRetry(this.prisma, async (tx) => {
      // Chosen first, so that a trial the run claims (§6.5) names the run before its row is written.
      const runId = uuidv7();
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: SUBAGENT_PARENT_SELECT });
      if (isReleased(session)) throw new ConflictException('the session has ended');
      const opened = await tx.subagentRun.findUnique({
        where: { sessionId_toolUseId: { sessionId, toolUseId: dto.toolUseId } },
      });
      if (!opened) {
        assertSubagentsEnabled(session.workspace);
        await assertWorkflowRunning(tx, sessionId, dto.workflowRunId);
        const limit = session.workspace?.subagentsMaxRunning ?? 8;
        const running = await tx.subagentRun.count({ where: { sessionId, status: 'RUNNING' } });
        if (running >= limit) {
          throw new ConflictException({
            code: 'SUBAGENT_LIMIT_REACHED',
            message: `This session already has ${running} SubAgents running, the most its agent allows at once (${limit}). Wait for one to finish.`,
          });
        }
      }
      // The parent's own engine, credential, model and effort: what the router weighs the pick against, and what
      // a candidate that IS the parent's runs on, exactly as the parent does.
      const parentBuilt = await this.childExec(tx, sessionId, runner, session, dto);
      const parent = {
        engine: parentBuilt.provider, provider: session.provider ?? parentBuilt.provider,
        model: parentBuilt.resolvedModel, effort: parentBuilt.effort ?? null,
      };
      const isParent = (c: SubagentCandidateTarget) =>
        c.engine === parent.engine && c.provider === parent.provider && c.model === parent.model;
      const build = (c: SubagentCandidateTarget) =>
        isParent(c) ? Promise.resolve(parentBuilt) : this.childExec(tx, sessionId, runner, session, dto, c);
      if (opened) {
        // A retry: the run as it stands, on the candidate its last attempt runs on.
        const last = attemptsOf(opened.attempts).at(-1);
        const built = last ? await build(last) : parentBuilt;
        return {
          runId: opened.id, status: opened.status as SubagentRunStatus,
          decision: opened.decision as unknown as SubagentDecision, exec: built.exec,
        };
      }
      // A resume continues the conversation where it ran: on its last attempt's engine, provider and model, never routed
      // again, since the conversation is that engine's and another would get the model without it.
      const { chosen, decision } = dto.resumeOf
        ? await this.resumeInPlace(tx, sessionId, dto.resumeOf, build)
        : await (async () => {
          const route = await planSubagentRoute(tx, {
            ownerId: session.ownerId,
            workspaceId: session.workspaceId,
            runnerId: session.assignedRunnerId,
            dto,
            planUsage: this.planUsage,
            parent,
          });
          // The pick, else the first of the tier's next candidates this runner can start. One whose account is due
          // its trial (§6.5) claims it, the SubAgent run's id standing in for a session's; one another run claimed
          // first is passed over, as a task dispatch routes past it.
          const passedOver: Array<{ target: SubagentCandidateTarget; reason: string }> = [];
          let chosen: { target: SubagentCandidateTarget; built: ChildExec; trialOf?: string } | null = null;
          const hasPick = Boolean(route.engine && route.provider && route.model);
          for (const [index, target] of fallbackCandidates(route).entries()) {
            let built: ChildExec;
            try {
              built = await build(target);
            } catch (error) {
              if (!(error instanceof HttpException)) throw error;
              passedOver.push({ target, reason: refusalText(error) });
              continue;
            }
            const trial = trialSubject(index === 0 && hasPick ? route : target);
            const claim = trial ? await claimTrialByKey(tx, session.ownerId, trial, '', runId) : 'NOT_DUE';
            if (claim === 'HELD') {
              passedOver.push({ target, reason: TRIAL_HELD_REASON });
              continue;
            }
            chosen = { target, built, ...(claim === 'CLAIMED' && trial ? { trialOf: trial } : {}) };
            break;
          }
          if (!chosen) {
            throw new ConflictException({
              code: 'NO_SUBAGENT_PROVIDER',
              message: noProviderMessage(route, [], passedOver.map((p) => `${p.target.provider} (${p.target.engine}), ${p.target.model}: ${p.reason}`)),
            });
          }
          return { chosen, decision: appliedDecision(route, chosen.target, passedOver) };
        })();
      if (dto.readonly) decision.readonly = true;
      // A call that asked for a workspace or capabilities and was placed here says why first (§10.1).
      if (workspaceReason) decision.reasons = [workspaceReason, ...decision.reasons];
      const { note: _note, level: _level, ...target } = chosen.target;
      const row = await tx.subagentRun.create({
        data: {
          id: runId,
          ownerId: session.ownerId,
          sessionId,
          toolUseId: dto.toolUseId,
          type: dto.type,
          definitionSource: dto.definitionSource,
          background: dto.background ?? false,
          // A background run is answered by the wake its end sends; nobody waits for it inline.
          wakeOwed: !dto.workflowRunId && (dto.background ?? false),
          workflowRunId: dto.workflowRunId,
          callIndex: dto.callIndex,
          label: stripNul(dto.label),
          phase: stripNul(dto.phase),
          ...(dto.description ? { description: stripNul(dto.description) } : {}),
          status: 'RUNNING',
          decision: decision as unknown as Prisma.InputJsonValue,
          // The first attempt: the candidate it opened on, with the pool account chosen for it, if any, and the
          // trial it claimed.
          attempts: [{
            ...firstAttempt({ ...target, effort: chosen.built.effort ?? target.effort }),
            ...(chosen.built.poolMember ? { poolMember: chosen.built.poolMember } : {}),
            ...('trialOf' in chosen && chosen.trialOf ? { trialOf: chosen.trialOf } : {}),
          }] as unknown as Prisma.InputJsonValue,
        },
      });
      return {
        runId: row.id,
        status: row.status as SubagentRunStatus,
        decision,
        exec: chosen.built.exec,
      };
    }, loggedRetry(this.logger, 'runnerSubagents.createSubagentRun'));
  }

  /**
   * Continue a finished run of this session on this machine: a new run on the engine, provider, model and effort its
   * last attempt ran on, which hold its conversation. Refused while it runs, and when that target cannot start here
   * now: moving it to another engine would start a conversation without the one it continues.
   */
  private async resumeInPlace(
    tx: Prisma.TransactionClient,
    sessionId: string,
    resumeOf: string,
    build: (target: SubagentCandidateTarget) => Promise<ChildExec>,
  ): Promise<{ chosen: { target: SubagentCandidateTarget; built: ChildExec }; decision: SubagentDecision }> {
    const original = await tx.subagentRun.findFirst({
      where: { id: resumeOf, sessionId, targetRunnerId: null },
      select: { status: true, attempts: true, decision: true },
    });
    const last = original ? attemptsOf(original.attempts).at(-1) : undefined;
    if (!original || !last) {
      throw new NotFoundException({ code: 'SUBAGENT_RESUME_NOT_FOUND', message: 'This session has no SubAgent run by that id to resume.' });
    }
    if (original.status === 'RUNNING') {
      throw new ConflictException({ code: 'SUBAGENT_RESUME_RUNNING', message: 'That SubAgent is still running; resume it once it has ended.' });
    }
    const target: SubagentCandidateTarget = { engine: last.engine, provider: last.provider, model: last.model, effort: last.effort ?? null };
    const where = `${target.model} on ${target.provider}${target.engine === target.provider ? '' : ` (${target.engine})`}`;
    let built: ChildExec;
    try {
      built = await build(target);
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      throw new ConflictException({
        code: 'SUBAGENT_RESUME_CANNOT_START',
        message: `That SubAgent ran on ${where}, which cannot start here now: ${refusalText(error)}. Its conversation is that `
          + "engine's, so it is not moved to another. Start a new SubAgent with the full brief instead.",
      });
    }
    const before = original.decision as unknown as SubagentDecision | null;
    const decision: SubagentDecision = {
      level: before?.level ?? null,
      tierSource: 'not-routed',
      optimizeFor: null,
      ...target,
      reasons: [`Resumes ${resumeOf} where it ran: ${where}`],
      candidates: [],
      fallbacks: [],
      policyVersion: SUBAGENT_RESUME_POLICY_VERSION,
      applied: true,
      tierNote: 'Resumed where it ran',
    };
    return { chosen: { target, built }, decision };
  }

  /**
   * Continue a finished remote run of this session (docs/subagent-design.md §10.2): a new remote run on the workspace
   * and runner that ran it, whose claim names it in `resumeOf`, so that runner continues its conversation. Refused
   * while it runs, once its workspace is gone or on another runner (which does not have the conversation), and for a
   * runner that keeps no conversation (SUBAGENT_REMOTE_RESUME_V1), which would start a new one instead.
   */
  private async openRemoteResume(sessionId: string, dto: SubagentRunCreateDto, resumeOf: string): Promise<SubagentRemoteRunCreateResponse> {
    if (dto.workspace?.trim() || neededCapabilities(dto.needs).length > 0) {
      throw new BadRequestException({
        code: 'SUBAGENT_RESUME_PLACED',
        message: 'A resumed SubAgent runs where it ran before: leave out workspace and needs.',
      });
    }
    const original = await this.prisma.subagentRun.findFirst({
      where: { id: resumeOf, sessionId },
      select: { status: true, workspaceId: true, targetRunnerId: true, attempts: true },
    });
    if (!original?.targetRunnerId || !original.workspaceId) {
      throw new NotFoundException({
        code: 'SUBAGENT_RESUME_NOT_FOUND',
        message: 'This session has no SubAgent run by that id that ran on another workspace.',
      });
    }
    const refuse = (code: string, why: string) => new ConflictException({
      code, message: `${why} Start a new SubAgent with the full brief instead.`,
    });
    if (original.status === 'RUNNING') {
      throw new ConflictException({ code: 'SUBAGENT_RESUME_RUNNING', message: 'That SubAgent is still running; resume it once it has ended.' });
    }
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: original.workspaceId },
      select: { id: true, name: true, workDir: true, workDirIsGit: true, runnerId: true, runner: { select: { capabilities: true } } },
    });
    if (!workspace) throw refuse('SUBAGENT_RESUME_GONE', 'The workspace that SubAgent ran on is gone, and its conversation with it.');
    if (workspace.runnerId !== original.targetRunnerId || !workspace.runner) {
      throw refuse('SUBAGENT_RESUME_MOVED',
        `${workspace.name} has moved to another machine since that SubAgent ran there, and its conversation stayed on the old one.`);
    }
    if (!workspace.runner.capabilities.includes(SUBAGENT_REMOTE_RESUME_V1)) {
      throw refuse('SUBAGENT_RESUME_UNSUPPORTED', `${workspace.name}'s runner is too old to continue a SubAgent's conversation.`);
    }
    const inPlace = workspace.workDirIsGit === false;
    if (inPlace && !dto.readonly) throw notGitRefusal(workspace.name);
    // The model it last ran on, unless the call names one: the conversation is that engine's, and a model named is
    // run as named on the target (planRemoteSubagent), so the resume is not routed onto another engine.
    const lastModel = attemptsOf(original.attempts).at(-1)?.model;
    const pinned = dto.model?.trim() || !lastModel ? dto : Object.assign(new SubagentRunCreateDto(), dto, { model: lastModel });
    return this.openRemoteSubagentRun(sessionId, pinned, {
      kind: 'remote',
      workspace: { id: workspace.id, name: workspace.name, runnerId: original.targetRunnerId, workDir: workspace.workDir, inPlace },
      reason: `Continues the SubAgent that ran on ${workspace.name}, with its conversation`,
    });
  }

  /** A remote run as openSubagentRun answers it. */
  private remoteAnswer(row: { id: string; status: string; decision: unknown; workspaceId: string | null }): SubagentRemoteRunCreateResponse {
    const decision = row.decision as unknown as SubagentDecision;
    return {
      runId: row.id,
      status: row.status as SubagentRunStatus,
      decision,
      remote: { workspaceId: row.workspaceId ?? decision.workspace?.id ?? '', workspaceName: decision.workspace?.name ?? '' },
    };
  }

  /**
   * Open a SubAgent run on another workspace (docs/subagent-design.md §10): written RUNNING with that workspace and
   * its runner as the target, the brief and the definition's flags kept for the target's claim, and a decision that
   * names the workspace and why it was chosen. What it runs on is judged on the target runner (planRemoteSubagent,
   * §10.3): a named model as named, or refused now with what the workspace can run (409 SUBAGENT_TARGET_CANNOT_RUN);
   * otherwise the workspace's own default engine and model while that engine is installed, signed in and under its
   * quota there, else the routed candidate the target runner can run, the default skipped with its reason (none:
   * 409 NO_SUBAGENT_PROVIDER). The parent's limits count it like any other of its SubAgents. The target runner is
   * hinted once this commits; its heartbeat lists the run until it claims it.
   */
  private async openRemoteSubagentRun(
    sessionId: string,
    dto: SubagentRunCreateDto,
    pick: Extract<SubagentWorkspacePick, { kind: 'remote' }>,
  ): Promise<SubagentRemoteRunCreateResponse> {
    const prompt = stripNul(dto.prompt ?? '');
    if (!prompt.trim()) {
      throw new BadRequestException({
        code: 'SUBAGENT_PROMPT_REQUIRED',
        message: 'A SubAgent on another workspace needs its prompt in the request: that machine does not have it.',
      });
    }
    const answer = await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: SUBAGENT_PARENT_SELECT });
      if (isReleased(session)) throw new ConflictException('the session has ended');
      const opened = await tx.subagentRun.findUnique({ where: { sessionId_toolUseId: { sessionId, toolUseId: dto.toolUseId } } });
      if (opened) return this.remoteAnswer(opened);
      assertSubagentsEnabled(session.workspace);
      await assertWorkflowRunning(tx, sessionId, dto.workflowRunId);
      const limit = session.workspace?.subagentsMaxRunning ?? 8;
      const running = await tx.subagentRun.count({ where: { sessionId, status: 'RUNNING' } });
      if (running >= limit) {
        throw new ConflictException({
          code: 'SUBAGENT_LIMIT_REACHED',
          message: `This session already has ${running} SubAgents running, the most its agent allows at once (${limit}). Wait for one to finish.`,
        });
      }
      const facts: SubagentRemoteFacts = {
        prompt,
        ...(dto.readonly ? { readonly: true } : {}),
        ...(dto.permissionMode ? { permissionMode: dto.permissionMode } : {}),
        ...(dto.needs?.length ? { needs: neededCapabilities(dto.needs) } : {}),
        ...(dto.resumeOf ? { resumeOf: dto.resumeOf } : {}),
        ...(pick.workspace.inPlace ? { inPlace: true } : {}),
      };
      // Only a read-only run goes in a work dir that is not a git repository (§10.2): nothing would discard its changes.
      if (facts.inPlace && !facts.readonly) throw notGitRefusal(pick.workspace.name);
      // What it runs on, judged on the target runner (§10.3); the refusals are thrown before anything is written.
      const { decision, target: chosen, built } = await planRemoteSubagent(tx, {
        ownerId: session.ownerId, sessionId, dto, facts, pick, planUsage: this.planUsage,
      });
      const parentMode = resolvePermissionMode(session.permissionMode, session.owner);
      const childEngine = String(built.exec!.provider);
      const parentEngine = session.provider ?? childEngine;
      if (!dto.readonly && dto.permissionMode
        && isWiderThanParent({ mode: parentMode, engine: parentEngine }, dto.permissionMode, childEngine)) {
        throw widerModeRefusal(parentMode, dto.permissionMode, childEngine,
          "Remove permissionMode from the SubAgent's definition to run it in this session's mode.");
      }
      const { note: _note, level: _level, ...target } = chosen;
      const row = await tx.subagentRun.create({
        data: {
          ownerId: session.ownerId,
          sessionId,
          toolUseId: dto.toolUseId,
          type: dto.type,
          definitionSource: dto.definitionSource,
          background: dto.background ?? false,
          wakeOwed: !dto.workflowRunId && (dto.background ?? false),
          workflowRunId: dto.workflowRunId,
          callIndex: dto.callIndex,
          label: stripNul(dto.label),
          phase: stripNul(dto.phase),
          ...(dto.description ? { description: stripNul(dto.description) } : {}),
          status: 'RUNNING',
          decision: decision as unknown as Prisma.InputJsonValue,
          attempts: [firstAttempt({ ...target, effort: built.effort ?? target.effort })] as unknown as Prisma.InputJsonValue,
          workspaceId: pick.workspace.id,
          targetRunnerId: pick.workspace.runnerId,
          remote: facts as unknown as Prisma.InputJsonValue,
        },
      });
      return this.remoteAnswer(row);
    }, loggedRetry(this.logger, 'runnerSubagents.openRemoteSubagentRun'));
    this.realtime?.markRunnerChanged(pick.workspace.runnerId);
    return answer;
  }

  /**
   * The target runner claims a remote SubAgent run its heartbeat listed (docs/subagent-design.md §10.2): what to run,
   * in which workspace, and how — the candidate the run was opened on (the target workspace's own default engine and
   * model, or the one planRemoteSubagent chose there), as remoteSubagentExec builds it now, in a session claim's
   * shape. Only the run's target runner may (403 SUBAGENT_RUN_NOT_TARGET). A claim sent
   * again answers the same; one for a run that ended or whose parent stopped it is 409. When the workspace can no
   * longer run it, the run ends FAILED with the reason, which reaches the parent as its result.
   */
  @Post('subagent-runs/:runId/claim')
  @HttpCode(200)
  async claimRemoteSubagentRun(
    @CurrentRunner() runner: Runner,
    @Param('runId', PublicIdPipe) runId: string,
  ): Promise<RemoteSubagentClaim> {
    const { sessionId } = await runOfTarget(this.prisma, runId, runner);
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const run = await runOfTarget(tx, runId, runner);
      if (run.status !== 'RUNNING') throw new ConflictException({ code: 'SUBAGENT_RUN_ENDED', message: `SubAgent run ${runId} has already ended` });
      if (run.stopRequestedAt) throw new ConflictException({ code: 'SUBAGENT_RUN_STOPPED', message: `SubAgent run ${runId} was stopped by its parent` });
      const facts = remoteFactsOf(run.remote);
      // The candidate it was opened on (§10.3); a run on the workspace's own default is built from that default now.
      const decision = run.decision as unknown as SubagentDecision;
      const last = attemptsOf(run.attempts).at(-1);
      const target = decision.tierSource !== 'not-routed' && last
        ? { engine: last.engine, provider: last.provider, model: last.model, effort: last.effort }
        : undefined;
      const built = run.workspaceId
        ? await remoteSubagentExec(tx, { workspaceId: run.workspaceId, parentSessionId: run.sessionId, facts, ...(target ? { target } : {}) })
        : { refusal: 'its workspace is gone' };
      if (!built.exec) {
        await tx.subagentRun.update({
          where: { id: run.id },
          data: { status: 'FAILED', resultSummary: `The workspace it was handed to cannot run it: ${built.refusal}.`, endedAt: new Date() },
        });
        await reapApprovalsOfEndedSubagents(tx, run.sessionId, run.id);
        return { refusal: built.refusal! };
      }
      if (!run.claimedAt) await tx.subagentRun.update({ where: { id: run.id }, data: { claimedAt: new Date() } });
      const workspace = await tx.workspace.findUnique({ where: { id: run.workspaceId! }, select: { workDir: true } });
      const claim: RemoteSubagentClaim = {
        runId: run.id,
        sessionId: run.sessionId,
        toolUseId: run.toolUseId,
        workspaceId: run.workspaceId!,
        workDir: workspace?.workDir ?? null,
        type: run.type,
        definitionSource: run.definitionSource,
        description: run.description,
        background: run.background,
        prompt: facts.prompt,
        exec: built.exec,
        parentPermissionMode: built.parentMode ?? null,
        resumeOf: facts.resumeOf ?? null,
        inPlace: facts.inPlace === true && facts.readonly === true,
      };
      return { claim };
    }, loggedRetry(this.logger, 'runnerSubagents.claimRemoteSubagentRun'));
    if (outcome.refusal !== undefined) {
      await this.fileWake(runId);
      throw new ConflictException({ code: 'SUBAGENT_TARGET_CANNOT_RUN', message: outcome.refusal });
    }
    return outcome.claim!;
  }

  /**
   * The target runner relays a batch of its child's events (docs/subagent-design.md §10.3). Accepted only from the
   * run's target runner, while the run is RUNNING and claimed. Each event is stored as the parent's stream carries it
   * (rewriteRemoteSubagentEvent: nested under the delegate call, child ids prefixed with the run id), once per seq;
   * the kinds the parent's stream never carries are dropped. The parent's runner reads them back
   * (readRelayedSubagentEvents) and emits them into the parent session's stream, which only it numbers.
   */
  @Post('subagent-runs/:runId/events')
  @HttpCode(202)
  async relaySubagentEvents(
    @CurrentRunner() runner: Runner,
    @Param('runId', PublicIdPipe) runId: string,
    @Body() batch: RemoteSubagentEventBatch,
  ): Promise<{ ok: true; stored: number; dropped: number }> {
    const events = readRelayBatch(batch?.events);
    const run = await runOfTarget(this.prisma, runId, runner);
    if (run.status !== 'RUNNING') throw new ConflictException({ code: 'SUBAGENT_RUN_ENDED', message: `SubAgent run ${runId} has already ended` });
    if (!run.claimedAt) throw new ConflictException({ code: 'SUBAGENT_RUN_NOT_CLAIMED', message: 'Claim the SubAgent run before relaying its events.' });
    const rows = events.flatMap((event) => {
      const payload = rewriteRemoteSubagentEvent(run.id, run.toolUseId, event.type, event.payload);
      return payload ? [{ runId: run.id, seq: event.seq, type: event.type, payload: payload as Prisma.InputJsonValue }] : [];
    });
    const stored = rows.length ? (await this.prisma.subagentRelayEvent.createMany({ data: rows, skipDuplicates: true })).count : 0;
    return { ok: true, stored, dropped: events.length - rows.length };
  }

  /**
   * The parent's runner reads a remote run's relayed events after `after` (docs/subagent-design.md §10.3), already
   * rewritten for its stream, with the run's status and result so it knows when no more will come. Only for a run of
   * a session this runner hosts.
   */
  @Get('sessions/:id/subagents/:runId/events')
  async readRelayedSubagentEvents(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('runId', PublicIdPipe) runId: string,
    @Query('after') after?: string,
  ): Promise<RemoteSubagentEventsPage> {
    await this.assertParentOfRunner(sessionId, runner);
    const run = await this.prisma.subagentRun.findFirst({
      where: { id: runId, sessionId },
      select: { id: true, status: true, resultSummary: true, targetRunnerId: true },
    });
    if (!run) throw new NotFoundException('SubAgent run not found');
    if (!run.targetRunnerId) {
      throw new ConflictException({ code: 'SUBAGENT_RUN_IS_LOCAL', message: 'This SubAgent runs on this machine; it relays nothing.' });
    }
    const from = Number.parseInt(after ?? '0', 10);
    const events = await this.prisma.subagentRelayEvent.findMany({
      where: { runId: run.id, seq: { gt: Number.isFinite(from) && from > 0 ? from : 0 } },
      orderBy: { seq: 'asc' },
      take: SUBAGENT_RELAY_BATCH_MAX,
      select: { seq: true, type: true, payload: true },
    });
    return {
      events: events.map((event) => ({ seq: event.seq, type: event.type, payload: event.payload as Record<string, unknown> })),
      status: run.status as SubagentRunStatus,
      resultSummary: run.resultSummary,
    };
  }

  /**
   * The parent stops a remote run (docs/subagent-design.md §10.3): its runner, stopping its own SubAgents on a stop or
   * an end, asks here for one another runner hosts. A run not claimed yet ends STOPPED at once; a claimed one is
   * marked, and the target's heartbeat tells it to stop the child (10 s grace, then kill) until it reports the end.
   * The target is hinted to beat now. A parent that ended is stopped the same way without asking (remoteSubagentHeartbeat).
   */
  @Post('sessions/:id/subagents/:runId/stop')
  @HttpCode(200)
  async stopRemoteSubagentRun(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('runId', PublicIdPipe) runId: string,
  ): Promise<SubagentRunUpdateResponse> {
    await this.assertParentOfRunner(sessionId, runner);
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const run = await tx.subagentRun.findFirst({ where: { id: runId, sessionId } });
      if (!run) throw new NotFoundException('SubAgent run not found');
      if (!run.targetRunnerId) {
        throw new ConflictException({ code: 'SUBAGENT_RUN_IS_LOCAL', message: 'This SubAgent runs on this machine; stop its child here.' });
      }
      if (run.status !== 'RUNNING') return { answer: { runId, status: run.status as SubagentRunStatus, applied: false }, ended: false, target: null };
      if (!run.claimedAt) {
        const attempts = attemptsOf(run.attempts);
        const last = attempts.at(-1);
        if (last?.outcome === 'RUNNING') Object.assign(last, { outcome: 'STOPPED', endedAt: new Date().toISOString() });
        await tx.subagentRun.update({
          where: { id: run.id },
          data: {
            status: 'STOPPED', resultSummary: STOPPED_BEFORE_CLAIM_RESULT, endedAt: new Date(), stopRequestedAt: new Date(),
            attempts: attempts as unknown as Prisma.InputJsonValue,
          },
        });
        await reapApprovalsOfEndedSubagents(tx, sessionId, run.id);
        return { answer: { runId, status: 'STOPPED' as SubagentRunStatus, applied: true }, ended: true, target: null };
      }
      if (!run.stopRequestedAt) await tx.subagentRun.update({ where: { id: run.id }, data: { stopRequestedAt: new Date() } });
      return { answer: { runId, status: 'RUNNING' as SubagentRunStatus, applied: !run.stopRequestedAt }, ended: false, target: run.targetRunnerId };
    }, loggedRetry(this.logger, 'runnerSubagents.stopRemoteSubagentRun'));
    if (outcome.ended) await this.fileWake(runId);
    if (outcome.target) this.realtime?.markRunnerChanged(outcome.target);
    return outcome.answer;
  }

  /**
   * The target runner reports a remote run's end (docs/subagent-design.md §10.3): the same end the parent's runner
   * reports for a run on its own machine (endRun) — status, result, cost added to the parent once, the parent's wake
   * filed — accepted only from the run's target runner.
   */
  @Patch('subagent-runs/:runId')
  async endRemoteSubagentRun(
    @CurrentRunner() runner: Runner,
    @Param('runId', PublicIdPipe) runId: string,
    @Body() dto: SubagentRunUpdateDto,
  ): Promise<SubagentRunUpdateResponse> {
    const run = await runOfTarget(this.prisma, runId, runner);
    if (dto.status === 'RUNNING') throw new BadRequestException('report the run\'s end: DONE, FAILED, INTERRUPTED or STOPPED');
    return this.endRun(run.sessionId, run.id, dto);
  }

  /**
   * How the child runs: the session's credential (or, with `target`, another candidate's on the same runner) as
   * dispatch resolves it, the child's permission mode — plan for a read-only definition, else the mode the
   * definition names or the parent's, never wider than the parent (§5.3) — and the workspace's tool rules, in the
   * shape a claim hands the runner. Throws the refusal when no credential can run it.
   */
  private async childExec(
    tx: Prisma.TransactionClient,
    sessionId: string,
    runner: Runner,
    session: SubagentParent,
    dto: { readonly?: boolean; permissionMode?: string },
    target?: SubagentCandidateTarget,
  ): Promise<ChildExec> {
    const resolved = await sessionProviderExec(tx, this.queue, sessionId, target, this.planUsage);
    if (!resolved.exec) {
      throw new ConflictException(resolved.refusal ?? 'the session has no provider to run a SubAgent on');
    }
    const { exec: resolvedExec, customRow } = resolved;
    const provider = resolvedExec.provider;
    const runnerModel = resolvedExec.runnerModel ?? resolvedExec.model;
    const workspace = session.workspace;
    const effort = normalizeEffortForRuntimeModel(
      provider,
      target ? target.effort ?? undefined : session.effort ?? workspace?.effort,
      runnerModel,
      session.assignedRunner?.modelCatalog,
      resolvedExec.reasoningLevels,
    );
    // By the rule a session starting another is held to (SessionsService.assertChildModeOrNarrow), but with no
    // exemption: an Auto parent's SubAgent may not run Bypass either (isWiderThanParent).
    const parentMode = resolvePermissionMode(session.permissionMode, session.owner);
    if (!dto.readonly && dto.permissionMode && isWiderThanParent({ mode: parentMode, engine: provider }, dto.permissionMode, provider)) {
      throw widerModeRefusal(
        parentMode,
        dto.permissionMode,
        provider,
        `Remove permissionMode from the SubAgent's definition to run it in this session's mode, or name one it may ` +
          `run in (${modesASubagentMayRunIn({ mode: parentMode, engine: provider }, provider).join(', ')}).`,
      );
    }
    // The parent's mode on every engine, read-only or not: the runner keeps a read-only child read-only and answers
    // what it asks the way the parent's mode does (§5.3).
    const childMode = subagentChildMode(parentMode, { readonly: dto.readonly, asked: dto.permissionMode }, provider);
    // A scheduled run's SubAgent is held to the run's level, as the run is: Auto on Claude Code, the level's denials
    // on every engine (schedule-access.ts). It never waits on a card nobody is there to answer.
    const level = runAccessLevel(session.scheduleRun);
    const exec: AgentExecConfig = {
      provider,
      model: runnerModel,
      allowedTools: dispatchAllowedTools(provider, ALWAYS_ALLOWED_TOOLS, workspace?.permissionRules ?? []),
      disallowedTools: scheduleRunDisallowedTools((workspace?.disallowedTools as string[] | null) ?? [], level, provider),
      permissionMode: normalizeBuiltinPermissionMode(
        provider,
        runnerModel,
        scheduleRunPermissionMode(childMode, level, provider),
        customRow?.enabled === true,
        runner.runsAsRoot,
        session.assignedRunner?.modelCatalog,
      ),
      effort,
      env: resolvedExec.env,
    };
    return { exec, provider, resolvedModel: resolvedExec.model, effort, ...(resolved.poolMember ? { poolMember: resolved.poolMember } : {}) };
  }

  /**
   * The runner's ask for where a SubAgent goes after its child failed on a usage limit, capacity, a failed login, an
   * account that needed action or denied the use, or an unclassified refusal before it started (docs/subagent-design.md
   * §4.3, docs/routing-account-health-design.md §7.3): the next candidate of the tier, from the decision the run
   * opened with — so a shadow decision serves too — skipping every provider an attempt already failed on. A
   * candidate whose account is due its trial claims it, and one another run claimed first is skipped (§6.5). The
   * failed attempt is closed with its error, the new one appended to `attempts`, and the Why gains a line naming both
   * models. At most SUBAGENT_MAX_MOVES moves per run, a move off a refused trial not counted (409
   * SUBAGENT_FALLBACK_SPENT); any other failure is not moved (409 SUBAGENT_NOT_A_LIMIT_FAILURE), nor is an account's
   * refusal on a model the caller named (409 SUBAGENT_NAMED_MODEL_NOT_MOVED); no candidate left is 409
   * NO_SUBAGENT_PROVIDER, listing why each provider is out. Each refusal still closes the failed attempt.
   */
  @Post('sessions/:id/subagents/:runId/fallback')
  @HttpCode(200)
  async nextSubagentCandidate(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('runId', PublicIdPipe) runId: string,
    @Body() dto: SubagentFallbackDto,
  ): Promise<SubagentFallbackResponse> {
    await this.assertParentOfRunner(sessionId, runner);
    const failure = movableFailure(dto.error, dto.failure, dto.admission);
    // The attempt that failed, as it stood before this closes it: what account health is told of (§6.3).
    const before = await this.prisma.subagentRun.findFirst({
      where: { id: runId, sessionId, status: 'RUNNING' }, select: { attempts: true, ownerId: true },
    });
    const failing: TrialAttempt | undefined = before ? attemptsOf(before.attempts).at(-1) : undefined;
    // Refusals still close the failed attempt, so they are thrown after the transaction commits.
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const row = await tx.subagentRun.findFirst({ where: { id: runId, sessionId } });
      if (!row) throw new NotFoundException('SubAgent run not found');
      if (row.status !== 'RUNNING') throw new ConflictException(`SubAgent run ${runId} has already ended`);
      if (!failure) {
        return { refusal: new ConflictException({
          code: 'SUBAGENT_NOT_A_LIMIT_FAILURE',
          message: 'The SubAgent failed on something other than a usage limit, capacity, a failed login, its account or a ' +
            'refusal before it started, so it is not moved: its failure is its result.',
        }) };
      }
      const now = new Date().toISOString();
      const attempts = attemptsOf(row.attempts);
      const failed = attempts.at(-1);
      if (failed) Object.assign(failed, { outcome: failure, error: dto.error.slice(0, SUBAGENT_ATTEMPT_ERROR_MAX), endedAt: now });
      const decision = row.decision as unknown as SubagentDecision;
      const save = (data: Prisma.SubagentRunUpdateInput = {}) =>
        tx.subagentRun.update({ where: { id: row.id }, data: { attempts: attempts as unknown as Prisma.InputJsonValue, ...data } });
      // A model the caller named runs as named (§4.1 row 1): its account's refusal — a failed login, an action it
      // needs, a use it denies, a start it refused — is the parent's to see, not to route around.
      if (ACCOUNT_REFUSAL_OUTCOMES.has(failure) && decision.tierSource === 'named-model') {
        await save();
        const model = failed?.model ?? decision.model ?? 'the model';
        const what = failure === 'AUTH_FAILED' ? `The SubAgent's login failed on ${model}`
          : failure === 'ADMISSION_FAILED' ? `The SubAgent could not start on ${model}`
            : `The SubAgent's account needed action on ${model}`;
        return { refusal: new ConflictException({
          code: 'SUBAGENT_NAMED_MODEL_NOT_MOVED',
          message: `${what}, which the delegate call named, so it is not moved to another model: its failure is its result.`,
        }) };
      }
      // Each attempt moved off counts, the one that just failed included, except a refused trial (§6.5).
      if (countedMoves(attempts) > SUBAGENT_MAX_MOVES) {
        await save();
        return { refusal: new ConflictException({
          code: 'SUBAGENT_FALLBACK_SPENT',
          message: `The SubAgent hit a usage limit, capacity, a failed login or its account's refusal on ${attempts.length} ` +
            `candidates in a row; it was moved ${SUBAGENT_MAX_MOVES} times, the most one delegate call is.`,
        }) };
      }
      const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: SUBAGENT_PARENT_SELECT });
      const spent = new Set(attempts.map((a) => a.provider));
      const skipped: string[] = [];
      for (const next of fallbackCandidates(decision)) {
        if (spent.has(next.provider)) continue;
        let built: ChildExec;
        try {
          built = await this.childExec(tx, sessionId, runner, session, dto, next);
        } catch (error) {
          if (!(error instanceof HttpException)) throw error;
          skipped.push(`${next.provider} (${next.engine}): ${refusalText(error)}`);
          spent.add(next.provider);
          continue;
        }
        // Its account's due trial (§6.5), claimed for this run; one another run claimed first is skipped.
        const trial = trialSubject(next);
        const claim = trial ? await claimTrialByKey(tx, row.ownerId, trial, '', row.id) : 'NOT_DUE';
        if (claim === 'HELD') {
          skipped.push(`${next.provider} (${next.engine}): ${TRIAL_HELD_REASON}`);
          spent.add(next.provider);
          continue;
        }
        const reason = moveReason(next, failed?.model ?? 'the first model', failure);
        const attempt = attempts.length + 1;
        const { note: _note, level: _level, trial: _trial, suspect: _suspect, ...target } =
          next as SubagentCandidateTarget & { trial?: unknown; suspect?: unknown };
        attempts.push({
          ...target, attempt, outcome: 'RUNNING', startedAt: now,
          ...(built.poolMember ? { poolMember: built.poolMember } : {}),
          ...(claim === 'CLAIMED' && trial ? { trialOf: trial } : {}),
        } as TrialAttempt);
        const moved: SubagentDecision = {
          ...decision,
          reasons: [...decision.reasons, reason],
          moves: [...(decision.moves ?? []), reason],
          // What it runs on now, which the block's meta names; the pick stays what the router chose.
          runModel: next.model,
          runEffort: built.effort ?? null,
        };
        await save({ decision: moved as unknown as Prisma.InputJsonValue });
        return { answer: { runId: row.id, attempt, reason, decision: moved, exec: built.exec }, trialOf: trial };
      }
      await save();
      return { refusal: new ConflictException({
        code: 'NO_SUBAGENT_PROVIDER',
        message: noProviderMessage(decision, attempts, skipped),
      }) };
    }, loggedRetry(this.logger, 'runnerSubagents.nextSubagentCandidate'));
    await this.attemptEnded(sessionId, runId, failing, { failed: true, error: dto.error, failure: dto.failure, admission: dto.admission });
    // A trial the failed attempt held ends with it; the refusal it took already released it, unless the next attempt
    // claimed the same account's.
    if (before && (!('trialOf' in outcome) || outcome.trialOf !== failing?.trialOf)) {
      await this.releaseAttemptTrial(before.ownerId, runId, failing);
    }
    if (outcome.refusal) throw outcome.refusal;
    return outcome.answer!;
  }

  /**
   * The runner's report that a SubAgent run ended (docs/subagent-design.md §5.1 step 5): its status, result,
   * changed files, usage and cost. The cost is added to the parent session's `cost_usd` in the same
   * transaction (§6.1), so budgets that read the session's spend count it. Only a RUNNING run ends: a
   * repeated report changes nothing and adds no cost again (`applied: false`).
   *
   * `wake: true` says the parent is owed a wake for the end (subagent-wake.ts), which is filed once the end is
   * committed. `RUNNING` with `wake: true` is the one report that ends nothing: the foreground call that waited
   * for the run stopped waiting (docs/subagent-design.md §2), so the server now holds the wake its end owes — and
   * files it at once for a run whose end got here first.
   */
  @Patch('sessions/:id/subagents/:runId')
  async updateSubagentRun(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('runId', PublicIdPipe) runId: string,
    @Body() dto: SubagentRunUpdateDto,
  ): Promise<SubagentRunUpdateResponse> {
    await this.assertParentOfRunner(sessionId, runner);
    if (dto.status === 'RUNNING') {
      if (dto.wake !== true) {
        throw new BadRequestException('a RUNNING report only says the waiting call stopped waiting: send wake: true');
      }
      const row = await this.recordWakeOwed(sessionId, runId);
      if (!row) throw new NotFoundException('SubAgent run not found');
      if (row.status !== 'RUNNING') await this.fileWake(runId);
      return { runId, status: row.status as SubagentRunStatus, applied: row.status === 'RUNNING' };
    }
    const remote = await this.prisma.subagentRun.findFirst({ where: { id: runId, sessionId }, select: { targetRunnerId: true } });
    if (remote?.targetRunnerId) throw remoteRunEndRefusal();
    return this.endRun(sessionId, runId, dto);
  }

  /**
   * The parent rates a run it started (`subagent_rate`, docs/subagent-design.md §7.1): how useful its result was,
   * 1 to 5, with an optional note. Only the session that started the run can: the session must be one this runner
   * hosts, and the run is matched by (id, that session). A later rating replaces the earlier one. Display only:
   * the Model tiers view reads it, routing never does.
   */
  @Post('sessions/:id/subagents/:runId/rating')
  @HttpCode(200)
  async rateSubagentRun(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('runId', PublicIdPipe) runId: string,
    @Body() dto: SubagentRatingDto,
  ): Promise<SubagentRatingResponse> {
    await this.assertParentOfRunner(sessionId, runner);
    return rateSubagentRun(this.prisma, sessionId, runId, dto);
  }

  /** A run's end, reported by the runner that ran it: the parent's for its own machine, the target's for a remote one. */
  private async endRun(sessionId: string, runId: string, dto: SubagentRunUpdateDto): Promise<SubagentRunUpdateResponse> {
    const costUsd = dto.costUsd ?? 0;
    const answer = await withTransactionRetry(this.prisma, async (tx) => {
      // The parent first, as every writer of a session and its children takes them (rank 30, then 60).
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const open = await tx.subagentRun.findFirst({
        where: { id: runId, sessionId, status: 'RUNNING' }, select: { attempts: true, ownerId: true },
      });
      const attempts = open ? attemptsOf(open.attempts) : [];
      const last: TrialAttempt | undefined = attempts.at(-1);
      if (last?.outcome === 'RUNNING') Object.assign(last, { outcome: dto.status, endedAt: new Date().toISOString() });
      const ended = await tx.subagentRun.updateMany({
        where: { id: runId, sessionId, status: 'RUNNING' },
        data: {
          status: dto.status,
          ...(last ? { attempts: attempts as unknown as Prisma.InputJsonValue } : {}),
          resultSummary: truncateResultSummary(dto.resultSummary),
          ...(dto.changedFiles ? { changedFiles: stripNul(dto.changedFiles) } : {}),
          costUsd,
          ...(dto.usage ? { usage: stripNul(dto.usage) as Prisma.InputJsonValue } : {}),
          ...(dto.wake ? { wakeOwed: true } : {}),
          endedAt: new Date(),
        },
      });
      if (ended.count === 0) {
        const row = await tx.subagentRun.findFirst({ where: { id: runId, sessionId }, select: { status: true } });
        if (!row) throw new NotFoundException('SubAgent run not found');
        return { runId, status: row.status as SubagentRunStatus, applied: false };
      }
      if (costUsd > 0) {
        await tx.session.update({ where: { id: sessionId }, data: { costUsd: { increment: costUsd } } });
      }
      // Its child engine was the only reader of the cards it asked (§5.3), and it has gone.
      await reapApprovalsOfEndedSubagents(tx, sessionId, runId);
      return { runId, status: dto.status, applied: true, last, ownerId: open?.ownerId };
    }, loggedRetry(this.logger, 'runnerSubagents.updateSubagentRun'));
    // A run that succeeded was admitted on the account of its last attempt (§6.3).
    if (answer.applied && dto.status === 'DONE' && 'last' in answer) {
      await this.attemptEnded(sessionId, runId, answer.last, { failed: false });
    }
    // A trial its last attempt held ends with the run (§6.5): cleared above when it was admitted, due again otherwise.
    if (answer.applied && 'last' in answer && answer.ownerId) await this.releaseAttemptTrial(answer.ownerId, runId, answer.last);
    if (answer.applied) await this.fileWake(runId);
    const { last: _last, ownerId: _ownerId, ...reply } = answer as SubagentRunUpdateResponse & { last?: unknown; ownerId?: unknown };
    return reply;
  }
}

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
  PermissionMode,
  type RemoteSubagentClaim,
  type RemoteSubagentEventBatch,
  type RemoteSubagentEventsPage,
  type SubagentRemoteRunCreateResponse,
  type SubagentCandidateTarget,
  type SubagentDecision,
  type SubagentFallbackResponse,
  type SubagentRunCreateResponse,
  type SubagentRunStatus,
  type SubagentRunUpdateResponse,
} from '@orbit/shared';
import { Prisma, RunStatus, type Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import {
  ALWAYS_ALLOWED_TOOLS,
  isWiderThanParent,
  modesASubagentMayRunIn,
  resolvePermissionMode,
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
import { assertEngineSession } from '../sessions/engine-session';
import { SessionsService } from '../sessions/sessions.service';
import { RealtimeService } from '../realtime/realtime.service';
import { sessionProviderExec } from './session-provider-exec';
import { stripNul } from './strip-nul';
import {
  attemptsOf,
  fallbackCandidates,
  firstAttempt,
  limitFailure,
  noProviderMessage,
  shadowDecision,
  SUBAGENT_ATTEMPT_ERROR_MAX,
  SUBAGENT_MAX_MOVES,
  SubagentFallbackDto,
  SubagentRunCreateDto,
  SubagentRunUpdateDto,
  truncateResultSummary,
} from './subagent-run';
import { planSubagentRoute } from './subagent-route';
import {
  chooseSubagentWorkspace,
  neededCapabilities,
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
  workspaceChoice,
} from './subagent-remote';
import { fileSubagentWake } from './subagent-wake';

const TERMINAL: RunStatus[] = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];

/** What a SubAgent's run reads of its parent session. */
const SUBAGENT_PARENT_SELECT = {
  ownerId: true,
  status: true,
  workspaceId: true,
  assignedRunnerId: true,
  provider: true,
  effort: true,
  permissionMode: true,
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
  ) {}

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

  /**
   * A parent session's `mcp__orbit__delegate` call opens a SubAgent run (docs/subagent-design.md §5.1 step 2).
   * Refused when the session's Agent has SubAgents turned off (403 SUBAGENTS_DISABLED) or already runs as many
   * as it allows at once (409 SUBAGENT_LIMIT_REACHED), counted under the parent row's lock so two calls cannot
   * both take the last place. The row is written RUNNING with the router's decision (routeSubagent, §4.1,
   * §4.2) — in shadow (§8 P2): the answer still runs the child on the parent's own engine, credential, model
   * and effort, in the shape a claim hands the runner. A retry with the same tool_use id answers with the run
   * it opened, whose decision is frozen.
   *
   * A call that names a `workspace` or `needs` capabilities is placed first (docs/subagent-design.md §10.1,
   * chooseSubagentWorkspace): on another workspace of the parent's repository it is opened there
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
    if (!opened && (dto.workspace?.trim() || neededCapabilities(dto.needs).length > 0)) {
      const parent = await this.prisma.session.findUniqueOrThrow({ where: { id: sessionId }, select: { ownerId: true, workspaceId: true } });
      const pick = await chooseSubagentWorkspace(this.prisma, {
        ownerId: parent.ownerId,
        parentWorkspaceId: parent.workspaceId,
        workspace: dto.workspace,
        needs: dto.needs,
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
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: SUBAGENT_PARENT_SELECT });
      if (TERMINAL.includes(session.status)) throw new ConflictException('the session has ended');
      const opened = await tx.subagentRun.findUnique({
        where: { sessionId_toolUseId: { sessionId, toolUseId: dto.toolUseId } },
      });
      if (!opened) {
        if (session.workspace?.subagentsEnabled === false) {
          throw new ForbiddenException({
            code: 'SUBAGENTS_DISABLED',
            message: 'SubAgents are turned off for this agent. Do the work in this session instead.',
          });
        }
        const limit = session.workspace?.subagentsMaxRunning ?? 4;
        const running = await tx.subagentRun.count({ where: { sessionId, status: 'RUNNING' } });
        if (running >= limit) {
          throw new ConflictException({
            code: 'SUBAGENT_LIMIT_REACHED',
            message: `This session already has ${running} SubAgents running, the most its agent allows at once (${limit}). Wait for one to finish.`,
          });
        }
      }
      const { exec, provider, resolvedModel, effort } = await this.childExec(tx, sessionId, runner, session, dto);
      const route = opened ? null : await planSubagentRoute(tx, {
        ownerId: session.ownerId,
        workspaceId: session.workspaceId,
        runnerId: session.assignedRunnerId,
        dto,
        planUsage: this.planUsage,
        parent: { engine: provider, provider: session.provider ?? provider, model: resolvedModel, effort: effort ?? null },
      });
      const decision = route ? shadowDecision(route, resolvedModel, effort ?? null) : null;
      if (decision && workspaceReason) decision.reasons = [workspaceReason, ...decision.reasons];
      const row =
        opened ??
        (await tx.subagentRun.create({
          data: {
            ownerId: session.ownerId,
            sessionId,
            toolUseId: dto.toolUseId,
            type: dto.type,
            definitionSource: dto.definitionSource,
            background: dto.background ?? false,
            // A background run is answered by the wake its end sends; nobody waits for it inline.
            wakeOwed: dto.background ?? false,
            ...(dto.description ? { description: stripNul(dto.description) } : {}),
            status: 'RUNNING',
            decision: decision as unknown as Prisma.InputJsonValue,
            // The first attempt: the parent's own engine, credential and model while routing is in shadow (§8 P2).
            attempts: [firstAttempt({
              engine: provider, provider: session.provider ?? provider, model: resolvedModel, effort: effort ?? null,
            })] as unknown as Prisma.InputJsonValue,
          },
        }));
      return {
        runId: row.id,
        status: row.status as SubagentRunStatus,
        decision: row.decision as unknown as SubagentDecision,
        exec,
      };
    }, loggedRetry(this.logger, 'runnerSubagents.createSubagentRun'));
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
   * names the workspace and why it was chosen. In this phase routing does not apply to it: it runs on the target
   * workspace's own default engine and model, which is checked here so a workspace that cannot run it refuses now
   * (409 SUBAGENT_TARGET_CANNOT_RUN). The parent's limits count it like any other of its SubAgents. The target
   * runner is hinted once this commits; its heartbeat lists the run until it claims it.
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
      if (TERMINAL.includes(session.status)) throw new ConflictException('the session has ended');
      const opened = await tx.subagentRun.findUnique({ where: { sessionId_toolUseId: { sessionId, toolUseId: dto.toolUseId } } });
      if (opened) return this.remoteAnswer(opened);
      if (session.workspace?.subagentsEnabled === false) {
        throw new ForbiddenException({
          code: 'SUBAGENTS_DISABLED',
          message: 'SubAgents are turned off for this agent. Do the work in this session instead.',
        });
      }
      const limit = session.workspace?.subagentsMaxRunning ?? 4;
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
      };
      const built = await remoteSubagentExec(tx, { workspaceId: pick.workspace.id, parentSessionId: sessionId, facts });
      if (!built.exec) {
        throw new ConflictException({
          code: 'SUBAGENT_TARGET_CANNOT_RUN',
          message: `${pick.workspace.name} cannot run this SubAgent: ${built.refusal}.`,
        });
      }
      const parentMode = resolvePermissionMode(session.permissionMode, session.owner);
      const childEngine = String(built.exec.provider);
      const parentEngine = session.provider ?? childEngine;
      if (!dto.readonly && dto.permissionMode
        && isWiderThanParent({ mode: parentMode, engine: parentEngine }, dto.permissionMode, childEngine)) {
        throw widerModeRefusal(parentMode, dto.permissionMode, childEngine,
          "Remove permissionMode from the SubAgent's definition to run it in this session's mode.");
      }
      const target = { engine: built.engine!, provider: built.provider!, model: built.model!, effort: built.effort ?? null };
      const decision: SubagentDecision = {
        level: null,
        tierSource: 'not-routed',
        optimizeFor: null,
        ...target,
        reasons: [pick.reason, `Runs on ${pick.workspace.name}'s own default engine and model, ${target.model}`],
        candidates: [],
        policyVersion: 'subagent-remote-v1',
        applied: true,
        workspace: workspaceChoice(pick.workspace, pick.reason),
      };
      const row = await tx.subagentRun.create({
        data: {
          ownerId: session.ownerId,
          sessionId,
          toolUseId: dto.toolUseId,
          type: dto.type,
          definitionSource: dto.definitionSource,
          background: dto.background ?? false,
          wakeOwed: dto.background ?? false,
          ...(dto.description ? { description: stripNul(dto.description) } : {}),
          status: 'RUNNING',
          decision: decision as unknown as Prisma.InputJsonValue,
          attempts: [firstAttempt(target)] as unknown as Prisma.InputJsonValue,
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
   * in which workspace, and how — the target workspace's own default engine and model, as remoteSubagentExec builds
   * it now, in a session claim's shape. Only the run's target runner may (403 SUBAGENT_RUN_NOT_TARGET). A claim sent
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
      const built = run.workspaceId
        ? await remoteSubagentExec(tx, { workspaceId: run.workspaceId, parentSessionId: run.sessionId, facts })
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
  ): Promise<{ exec: AgentExecConfig; provider: string; resolvedModel: string; effort: string | undefined }> {
    const resolved = await sessionProviderExec(tx, this.queue, sessionId, target);
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
    const childMode = (dto.readonly ? PermissionMode.PLAN : dto.permissionMode ?? parentMode) as PermissionMode;
    const exec: AgentExecConfig = {
      provider,
      model: runnerModel,
      allowedTools: dispatchAllowedTools(provider, ALWAYS_ALLOWED_TOOLS, workspace?.permissionRules ?? []),
      disallowedTools: (workspace?.disallowedTools as string[] | null) ?? [],
      permissionMode: normalizeBuiltinPermissionMode(
        provider,
        runnerModel,
        childMode,
        customRow?.enabled === true,
        runner.runsAsRoot,
        session.assignedRunner?.modelCatalog,
      ),
      effort,
      env: resolvedExec.env,
    };
    return { exec, provider, resolvedModel: resolvedExec.model, effort };
  }

  /**
   * The runner's ask for where a SubAgent goes after its child failed on a usage limit or capacity
   * (docs/subagent-design.md §4.3): the next candidate of the tier, from the decision the run opened with — so a
   * shadow decision serves too — skipping every provider an attempt already hit a limit on. The failed attempt is
   * closed with its error, the new one appended to `attempts`, and the Why gains a line naming both models.
   * At most SUBAGENT_MAX_MOVES moves per run (409 SUBAGENT_FALLBACK_SPENT); any other failure is not moved
   * (409 SUBAGENT_NOT_A_LIMIT_FAILURE); no candidate left is 409 NO_SUBAGENT_PROVIDER, listing why each provider
   * is out. Each refusal still closes the failed attempt.
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
    const failure = limitFailure(dto.error);
    // Refusals still close the failed attempt, so they are thrown after the transaction commits.
    const outcome = await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const row = await tx.subagentRun.findFirst({ where: { id: runId, sessionId } });
      if (!row) throw new NotFoundException('SubAgent run not found');
      if (row.status !== 'RUNNING') throw new ConflictException(`SubAgent run ${runId} has already ended`);
      if (!failure) {
        return { refusal: new ConflictException({
          code: 'SUBAGENT_NOT_A_LIMIT_FAILURE',
          message: 'The SubAgent failed on something other than a usage limit or capacity, so it is not moved: its failure is its result.',
        }) };
      }
      const now = new Date().toISOString();
      const attempts = attemptsOf(row.attempts);
      const failed = attempts.at(-1);
      if (failed) Object.assign(failed, { outcome: failure, error: dto.error.slice(0, SUBAGENT_ATTEMPT_ERROR_MAX), endedAt: now });
      const decision = row.decision as unknown as SubagentDecision;
      const save = (data: Prisma.SubagentRunUpdateInput = {}) =>
        tx.subagentRun.update({ where: { id: row.id }, data: { attempts: attempts as unknown as Prisma.InputJsonValue, ...data } });
      const moves = Math.max(attempts.length - 1, 0);
      if (moves >= SUBAGENT_MAX_MOVES) {
        await save();
        return { refusal: new ConflictException({
          code: 'SUBAGENT_FALLBACK_SPENT',
          message: `The SubAgent hit a usage limit or capacity on ${attempts.length} candidates in a row; ` +
            `it was moved ${SUBAGENT_MAX_MOVES} times, the most one delegate call is.`,
        }) };
      }
      const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: SUBAGENT_PARENT_SELECT });
      const spent = new Set(attempts.map((a) => a.provider));
      const skipped: string[] = [];
      for (const next of fallbackCandidates(decision)) {
        if (spent.has(next.provider)) continue;
        let built: Awaited<ReturnType<RunnerSubagentsController['childExec']>>;
        try {
          built = await this.childExec(tx, sessionId, runner, session, dto, next);
        } catch (error) {
          if (!(error instanceof HttpException)) throw error;
          const said = error.getResponse();
          skipped.push(`${next.provider} (${next.engine}): ${typeof said === 'string' ? said : (said as { message?: string }).message ?? error.message}`);
          spent.add(next.provider);
          continue;
        }
        const reason = failure === 'AT_CAPACITY'
          ? `Moved to ${next.model} after ${failed?.model ?? 'the first model'} was at capacity`
          : `Moved to ${next.model} after ${failed?.model ?? 'the first model'}'s account hit its limit`;
        const attempt = attempts.length + 1;
        attempts.push({ ...next, attempt, outcome: 'RUNNING', startedAt: now });
        const moved: SubagentDecision = {
          ...decision,
          reasons: [...decision.reasons, reason],
          ...(decision.applied === false ? { runModel: next.model, runEffort: built.effort ?? null } : {}),
        };
        await save({ decision: moved as unknown as Prisma.InputJsonValue });
        return { answer: { runId: row.id, attempt, reason, decision: moved, exec: built.exec } };
      }
      await save();
      return { refusal: new ConflictException({
        code: 'NO_SUBAGENT_PROVIDER',
        message: noProviderMessage(decision, attempts, skipped),
      }) };
    }, loggedRetry(this.logger, 'runnerSubagents.nextSubagentCandidate'));
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

  /** A run's end, reported by the runner that ran it: the parent's for its own machine, the target's for a remote one. */
  private async endRun(sessionId: string, runId: string, dto: SubagentRunUpdateDto): Promise<SubagentRunUpdateResponse> {
    const costUsd = dto.costUsd ?? 0;
    const answer = await withTransactionRetry(this.prisma, async (tx) => {
      // The parent first, as every writer of a session and its children takes them (rank 30, then 60).
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
      const open = await tx.subagentRun.findFirst({ where: { id: runId, sessionId, status: 'RUNNING' }, select: { attempts: true } });
      const attempts = open ? attemptsOf(open.attempts) : [];
      const last = attempts.at(-1);
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
      return { runId, status: dto.status, applied: true };
    }, loggedRetry(this.logger, 'runnerSubagents.updateSubagentRun'));
    if (answer.applied) await this.fileWake(runId);
    return answer;
  }
}

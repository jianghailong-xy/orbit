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
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  type AgentExecConfig,
  PermissionMode,
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
import { sessionProviderExec } from './session-provider-exec';
import { stripNul } from './strip-nul';
import {
  attemptsOf,
  fallbackCandidates,
  firstAttempt,
  limitFailure,
  noProviderMessage,
  appliedDecision,
  SUBAGENT_ATTEMPT_ERROR_MAX,
  SUBAGENT_MAX_MOVES,
  SubagentFallbackDto,
  SubagentRunCreateDto,
  SubagentRunUpdateDto,
  truncateResultSummary,
} from './subagent-run';
import { planSubagentRoute } from './subagent-route';
import { fileSubagentWake } from './subagent-wake';

const TERMINAL: RunStatus[] = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];

/** How a SubAgent's child runs on one candidate: the claim-shaped config, and what it resolved to. */
interface ChildExec {
  exec: AgentExecConfig;
  provider: string;
  resolvedModel: string;
  effort: string | undefined;
  /** The account of an account pool chosen for this SubAgent alone. */
  poolMember?: { providerId: string; label: string };
}

/** A refusal's own words. */
function refusalText(error: HttpException): string {
  const said = error.getResponse();
  return typeof said === 'string' ? said : (said as { message?: string }).message ?? error.message;
}

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
   * both take the last place. The router's decision (routeSubagent, §4.1, §4.2) applies (§8 P3): the answer runs
   * the child on the engine, credential, model and effort it picked, in the shape a claim hands the runner — or,
   * when the pick cannot be started on this runner, on the first of the tier's next candidates that can, the
   * pick recorded as removed with its reason. A pool with nothing in it, or nothing that can start, is refused
   * with 409 NO_SUBAGENT_PROVIDER listing each provider's reason; the SubAgent never falls back onto the
   * parent's model. The row is written RUNNING with that decision, and an account pool's member chosen for it
   * on its first attempt, never on the parent's session. A retry with the same tool_use id answers with the run
   * it opened, whose decision is frozen, on the candidate its last attempt runs on.
   */
  @Post('sessions/:id/subagents')
  @HttpCode(200)
  async createSubagentRun(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: SubagentRunCreateDto,
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
      const route = await planSubagentRoute(tx, {
        ownerId: session.ownerId,
        workspaceId: session.workspaceId,
        runnerId: session.assignedRunnerId,
        dto,
        planUsage: this.planUsage,
        parent,
      });
      // The pick, else the first of the tier's next candidates this runner can start.
      const passedOver: Array<{ target: SubagentCandidateTarget; reason: string }> = [];
      let chosen: { target: SubagentCandidateTarget; built: ChildExec } | null = null;
      for (const target of fallbackCandidates(route)) {
        try {
          chosen = { target, built: await build(target) };
          break;
        } catch (error) {
          if (!(error instanceof HttpException)) throw error;
          passedOver.push({ target, reason: refusalText(error) });
        }
      }
      if (!chosen) {
        throw new ConflictException({
          code: 'NO_SUBAGENT_PROVIDER',
          message: noProviderMessage(route, [], passedOver.map((p) => `${p.target.provider} (${p.target.engine}), ${p.target.model}: ${p.reason}`)),
        });
      }
      const decision = appliedDecision(route, chosen.target, passedOver);
      const { note: _note, ...target } = chosen.target;
      const row = await tx.subagentRun.create({
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
          // The first attempt: the candidate it opened on, with the pool account chosen for it, if any.
          attempts: [{
            ...firstAttempt({ ...target, effort: chosen.built.effort ?? target.effort }),
            ...(chosen.built.poolMember ? { poolMember: chosen.built.poolMember } : {}),
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
    return { exec, provider, resolvedModel: resolvedExec.model, effort, ...(resolved.poolMember ? { poolMember: resolved.poolMember } : {}) };
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
        let built: ChildExec;
        try {
          built = await this.childExec(tx, sessionId, runner, session, dto, next);
        } catch (error) {
          if (!(error instanceof HttpException)) throw error;
          skipped.push(`${next.provider} (${next.engine}): ${refusalText(error)}`);
          spent.add(next.provider);
          continue;
        }
        const reason = failure === 'AT_CAPACITY'
          ? `Moved to ${next.model} on ${next.provider} after ${failed?.model ?? 'the first model'} was at capacity`
          : `Moved to ${next.model} on ${next.provider} after ${failed?.model ?? 'the first model'}'s account hit its limit`;
        const attempt = attempts.length + 1;
        const { note: _note, ...target } = next;
        attempts.push({
          ...target, attempt, outcome: 'RUNNING', startedAt: now,
          ...(built.poolMember ? { poolMember: built.poolMember } : {}),
        });
        const moved: SubagentDecision = {
          ...decision,
          reasons: [...decision.reasons, reason],
          moves: [...(decision.moves ?? []), reason],
          // What it runs on now, which the block's meta names; the pick stays what the router chose.
          runModel: next.model,
          runEffort: built.effort ?? null,
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

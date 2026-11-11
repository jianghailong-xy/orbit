import {
  BadRequestException,
  Body,
  ConflictException,
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
  type SubagentDecision,
  type SubagentRunCreateResponse,
  type SubagentRunStatus,
  type SubagentRunUpdateResponse,
} from '@orbit/shared';
import { Prisma, RunStatus, type Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { ALWAYS_ALLOWED_TOOLS, resolvePermissionMode } from '../common/permission-mode';
import { dispatchAllowedTools } from '../common/permission-rules';
import { normalizeBuiltinPermissionMode, normalizeEffortForRuntimeModel } from '../common/runtime-provider';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { QueueService } from '../queue/queue.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { assertEngineSession } from '../sessions/engine-session';
import { SessionsService } from '../sessions/sessions.service';
import { sessionProviderExec } from './session-provider-exec';
import { stripNul } from './strip-nul';
import { shadowDecision, SubagentRunCreateDto, SubagentRunUpdateDto, truncateResultSummary } from './subagent-run';
import { planSubagentRoute } from './subagent-route';
import { fileSubagentWake } from './subagent-wake';

const TERMINAL: RunStatus[] = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];

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
   * both take the last place. The row is written RUNNING with the router's decision (routeSubagent, §4.1,
   * §4.2) — in shadow (§8 P2): the answer still runs the child on the parent's own engine, credential, model
   * and effort, in the shape a claim hands the runner. A retry with the same tool_use id answers with the run
   * it opened, whose decision is frozen.
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
      const session = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
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
        },
      });
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
      const resolved = await sessionProviderExec(tx, this.queue, sessionId);
      if (!resolved.exec) {
        throw new ConflictException(resolved.refusal ?? 'the session has no provider to run a SubAgent on');
      }
      const { exec: resolvedExec, customRow } = resolved;
      const provider = resolvedExec.provider;
      const runnerModel = resolvedExec.runnerModel ?? resolvedExec.model;
      const workspace = session.workspace;
      const effort = normalizeEffortForRuntimeModel(
        provider,
        session.effort ?? workspace?.effort,
        runnerModel,
        session.assignedRunner?.modelCatalog,
        resolvedExec.reasoningLevels,
      );
      // A read-only definition runs in plan mode; anything else as the parent does, never wider (§5.3).
      const parentMode = resolvePermissionMode(session.permissionMode, session.owner);
      const exec: AgentExecConfig = {
        provider,
        model: runnerModel,
        allowedTools: dispatchAllowedTools(provider, ALWAYS_ALLOWED_TOOLS, workspace?.permissionRules ?? []),
        disallowedTools: (workspace?.disallowedTools as string[] | null) ?? [],
        permissionMode: normalizeBuiltinPermissionMode(
          provider,
          runnerModel,
          dto.readonly ? PermissionMode.PLAN : parentMode,
          customRow?.enabled === true,
          runner.runsAsRoot,
          session.assignedRunner?.modelCatalog,
        ),
        effort,
        env: resolvedExec.env,
      };
      const route = opened ? null : await planSubagentRoute(tx, {
        ownerId: session.ownerId,
        workspaceId: session.workspaceId,
        runnerId: session.assignedRunnerId,
        dto,
        planUsage: this.planUsage,
        parent: { engine: provider, provider: session.provider ?? provider, model: resolvedExec.model, effort: effort ?? null },
      });
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
            decision: shadowDecision(route!, resolvedExec.model) as unknown as Prisma.InputJsonValue,
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
      const ended = await tx.subagentRun.updateMany({
        where: { id: runId, sessionId, status: 'RUNNING' },
        data: {
          status: dto.status,
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
      return { runId, status: dto.status, applied: true };
    }, loggedRetry(this.logger, 'runnerSubagents.updateSubagentRun'));
    if (answer.applied) await this.fileWake(runId);
    return answer;
  }
}

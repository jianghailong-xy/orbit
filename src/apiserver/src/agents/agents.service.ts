import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lastProviderByAgent, withProviderSeed } from './agent-provider';
import {
  isBlockingRepoState,
  readRunnerRepoHealth,
  repoHealthForAgent,
} from '../common/runner-repo-health';
import { CreateAgentDto, UpdateAgentDto } from './dto';

// The `orbit mcp` server is injected into every session, but under DONT_ASK its tools
// are blocked unless allow-listed. Default new agents to allow the whole orbit server.
const ORBIT_MCP_TOOL = 'mcp__orbit__*';
@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * An agent may only be pinned to a runner the same owner controls. Without
   * this, a user could point their own agent at another tenant's runner and
   * route tasks there (cross-tenant execution via the agent-routing path).
   */
  private async assertOwnedRunner(ownerId: string, runnerId?: string): Promise<void> {
    if (!runnerId) return;
    const runner = await this.prisma.runner.findFirst({
      where: { id: runnerId, ownerId },
      select: { id: true },
    });
    if (!runner) throw new ForbiddenException('runner not found');
  }

  async create(ownerId: string, dto: CreateAgentDto) {
    await this.assertOwnedRunner(ownerId, dto.targetRunnerId);
    await this.assertOwnedRunner(ownerId, dto.runnerId);
    const agent = await this.prisma.agent.create({
      data: {
        ownerId,
        name: dto.name,
        description: dto.description,
        // Runtime defaults are reported through the bound Runner. Keep the nullable column only for
        // old-client reads of agents created before migration 0079; never seed it from dto.model.
        model: null,
        appendSystemPrompt: dto.appendSystemPrompt,
        systemPrompt: dto.systemPrompt,
        allowedTools: Array.from(
          new Set([...(dto.allowedTools ?? []), ORBIT_MCP_TOOL]),
        ) as Prisma.InputJsonValue,
        disallowedTools: (dto.disallowedTools ?? []) as Prisma.InputJsonValue,
        permissionMode: dto.permissionMode ?? 'dontAsk',
        effort: dto.effort,
        maxTurns: dto.maxTurns,
        maxBudgetUsd: dto.maxBudgetUsd,
        mcpConfig: (dto.mcpConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        targetRunnerId: dto.targetRunnerId,
        targetLabels: dto.targetLabels ?? [],
        runnerId: dto.runnerId,
        workDir: dto.workDir,
        env: (dto.env ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        enabled: dto.enabled ?? true,
        autoInitGit: dto.autoInitGit ?? false,
        enableWorktree: dto.enableWorktree ?? false,
        enableOrchestration: dto.enableOrchestration ?? false,
        defaultMergeTarget: dto.defaultMergeTarget,
      },
    });
    // Brand-new: no sessions yet, so the seed is the floor. Shaped like every other read.
    return withProviderSeed([agent], new Map())[0];
  }

  /** What the read paths include about an agent's machine: identity for grouping/routing, plus
   *  the checkout-health snapshot its heartbeat carries (resolved per agent by withRepoHealth). */
  private static readonly RUNNER_INCLUDE = {
    runner: {
      select: {
        id: true,
        name: true,
        displayName: true,
        repoHealth: true,
        repoCleanupStatus: true,
        repoCleanupBranch: true,
        repoCleanupMessage: true,
      },
    },
  } as const;

  /**
   * Attach the state of the shared checkout this agent's sessions run in.
   *
   * The runner reports every checkout on the machine; an agent only cares about its own, so this
   * resolves the one entry and drops the rest rather than shipping the whole column with each
   * agent. Null when the runner is older than the report, has no runner, or the workDir isn't a
   * git repo — all of which the UI reads as "unknown", never as "clean".
   */
  private withRepoHealth<T extends { id: string; runner?: { repoHealth?: unknown } | null }>(
    agent: T,
  ) {
    if (!agent.runner) return { ...agent, repoHealth: null, repoCleanup: null };
    const {
      repoHealth: reported,
      repoCleanupStatus,
      repoCleanupBranch,
      repoCleanupMessage,
      ...runner
    } = agent.runner as Record<string, unknown> & { repoHealth?: unknown };
    return {
      ...agent,
      runner,
      repoHealth: repoHealthForAgent(readRunnerRepoHealth(reported), agent.id),
      // The repair relay's last word, so the UI can hold "Cleaning up…" and then name the rescue
      // branch instead of silently dropping the warning.
      repoCleanup: repoCleanupStatus
        ? {
            status: repoCleanupStatus as string,
            branch: (repoCleanupBranch as string | null) ?? null,
            message: (repoCleanupMessage as string | null) ?? null,
          }
        : null,
    };
  }

  async list(ownerId: string) {
    const agents = await this.prisma.agent.findMany({
      where: { ownerId, deletedAt: null },
      // Custom drag order first; never-reordered agents (position NULL) sort last by
      // creation time, so newly added agents append below the arranged ones.
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      // Expose the machine an agent belongs to so the UI can group/route by runner.
      include: AgentsService.RUNNER_INCLUDE,
    });
    // One indexed query for the whole list — the provider each project last ran on.
    const seeded = withProviderSeed(agents, await lastProviderByAgent(this.prisma, agents.map((a) => a.id)));
    return seeded.map((agent) => this.withRepoHealth(agent));
  }

  /**
   * Persist the sidebar order. `ids` is the full agent list in the desired order;
   * each agent's `position` is set to its index. Ids the caller doesn't own are
   * dropped, so a stale or hostile client can't stamp positions onto another
   * tenant's agents.
   */
  async reorder(ownerId: string, ids: string[]) {
    const owned = await this.prisma.agent.findMany({
      where: { id: { in: ids }, ownerId, deletedAt: null },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((a) => a.id));
    const ordered = ids.filter((id) => ownedIds.has(id));
    await this.prisma.$transaction(
      ordered.map((id, i) => this.prisma.agent.update({ where: { id }, data: { position: i } })),
    );
    return this.list(ownerId);
  }

  async get(ownerId: string, id: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id, ownerId, deletedAt: null },
      include: AgentsService.RUNNER_INCLUDE,
    });
    if (!agent) throw new NotFoundException('agent not found');
    const seeded = withProviderSeed([agent], await lastProviderByAgent(this.prisma, [agent.id]))[0];
    return this.withRepoHealth(seeded);
  }

  /**
   * Queue "clean up the checkout this agent works in" for its runner's next heartbeat.
   *
   * Only offered for a checkout the runner itself reported as wedged: the repair rewrites a
   * directory shared by every session on that machine, so the trigger is a state we observed, not
   * a path a client asked for. Re-clicking while one is pending is a no-op rather than a second
   * repair — the first is already redelivered until the runner answers.
   */
  async requestRepoCleanup(ownerId: string, id: string) {
    const agent = await this.get(ownerId, id);
    const health = agent.repoHealth;
    if (!health) throw new BadRequestException('this agent has no reported checkout');
    if (!isBlockingRepoState(health.state)) {
      throw new BadRequestException(`${health.root} is not stuck (${health.state}) — nothing to clean up`);
    }
    if (!agent.runnerId) throw new BadRequestException('this agent is not bound to a runner');
    await this.prisma.runner.updateMany({
      // Owner-scoped even though `get` already proved the agent is ours: the runner is a separate
      // row, and a write keyed only by id would be a cross-tenant write if the two ever disagreed.
      where: {
        id: agent.runnerId,
        ownerId,
        NOT: { repoCleanupStatus: 'pending' },
      },
      data: {
        repoCleanupStatus: 'pending',
        repoCleanupRoot: health.root,
        repoCleanupBranch: null,
        repoCleanupMessage: null,
        repoCleanupAt: new Date(),
      },
    });
    return this.get(ownerId, id);
  }

  async update(ownerId: string, id: string, dto: UpdateAgentDto) {
    const current = await this.get(ownerId, id);
    await this.assertOwnedRunner(ownerId, dto.targetRunnerId);
    await this.assertOwnedRunner(ownerId, dto.runnerId);
    const data: Prisma.AgentUpdateInput = {
      name: dto.name,
      description: dto.description,
      appendSystemPrompt: dto.appendSystemPrompt,
      systemPrompt: dto.systemPrompt,
      permissionMode: dto.permissionMode,
      effort: dto.effort,
      maxTurns: dto.maxTurns,
      maxBudgetUsd: dto.maxBudgetUsd,
      workDir: dto.workDir,
      targetRunnerId: dto.targetRunnerId,
      enabled: dto.enabled,
      autoInitGit: dto.autoInitGit,
      enableWorktree: dto.enableWorktree,
      enableOrchestration: dto.enableOrchestration,
      defaultMergeTarget: dto.defaultMergeTarget,
    };
    if (dto.allowedTools) data.allowedTools = dto.allowedTools as Prisma.InputJsonValue;
    if (dto.disallowedTools) data.disallowedTools = dto.disallowedTools as Prisma.InputJsonValue;
    if (dto.mcpConfig) data.mcpConfig = dto.mcpConfig as Prisma.InputJsonValue;
    if (dto.env) data.env = dto.env as Prisma.InputJsonValue;
    if (dto.targetLabels) data.targetLabels = dto.targetLabels;
    // runnerId is a relation FK: connect to (re)bind, disconnect to detach.
    if (dto.runnerId !== undefined) {
      data.runner = dto.runnerId ? { connect: { id: dto.runnerId } } : { disconnect: true };
    }
    const agent = await this.prisma.agent.update({ where: { id }, data });
    return withProviderSeed([agent], await lastProviderByAgent(this.prisma, [id]))[0];
  }

  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    // Soft delete: stamp `deletedAt` rather than dropping the row. The agent's sessions and
    // tasks stay linked (no FK SET NULL orphaning) and it stays restorable; every user-facing
    // listing filters on `deletedAt: null`, while runtime lookups by a live session's agentId
    // deliberately don't — so in-flight sessions keep resolving their agent's config.
    await this.prisma.agent.update({ where: { id }, data: { deletedAt: new Date() } });
    return { ok: true };
  }
}

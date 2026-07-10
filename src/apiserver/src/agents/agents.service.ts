import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAgentDto, UpdateAgentDto } from './dto';

// The `orbit mcp` server is injected into every session, but under DONT_ASK its tools
// are blocked unless allow-listed. Default new agents to allow the whole orbit server.
const ORBIT_MCP_TOOL = 'mcp__orbit__*';
const DEFAULT_MODEL_BY_PROVIDER: Record<AgentProvider, string> = {
  [AgentProvider.CLAUDE]: 'claude-opus-4-8',
  [AgentProvider.CODEX]: 'gpt-5.6-sol',
};

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
    const provider = dto.provider ?? AgentProvider.CLAUDE;
    return this.prisma.agent.create({
      data: {
        ownerId,
        name: dto.name,
        description: dto.description,
        provider,
        model: dto.model ?? DEFAULT_MODEL_BY_PROVIDER[provider],
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
      },
    });
  }

  list(ownerId: string) {
    return this.prisma.agent.findMany({
      where: { ownerId, deletedAt: null },
      // Custom drag order first; never-reordered agents (position NULL) sort last by
      // creation time, so newly added agents append below the arranged ones.
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      // Expose the machine an agent belongs to so the UI can group/route by runner.
      include: { runner: { select: { id: true, name: true, displayName: true } } },
    });
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
      include: { runner: { select: { id: true, name: true, displayName: true } } },
    });
    if (!agent) throw new NotFoundException('agent not found');
    return agent;
  }

  async update(ownerId: string, id: string, dto: UpdateAgentDto) {
    await this.get(ownerId, id);
    await this.assertOwnedRunner(ownerId, dto.targetRunnerId);
    await this.assertOwnedRunner(ownerId, dto.runnerId);
    const data: Prisma.AgentUpdateInput = {
      name: dto.name,
      description: dto.description,
      model: dto.model,
      appendSystemPrompt: dto.appendSystemPrompt,
      systemPrompt: dto.systemPrompt,
      permissionMode: dto.permissionMode,
      effort: dto.effort,
      provider: dto.provider,
      maxTurns: dto.maxTurns,
      maxBudgetUsd: dto.maxBudgetUsd,
      workDir: dto.workDir,
      targetRunnerId: dto.targetRunnerId,
      enabled: dto.enabled,
      autoInitGit: dto.autoInitGit,
      enableWorktree: dto.enableWorktree,
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
    return this.prisma.agent.update({ where: { id }, data });
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

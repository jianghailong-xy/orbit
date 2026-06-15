import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAgentDto, UpdateAgentDto } from './dto';

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
    return this.prisma.agent.create({
      data: {
        ownerId,
        name: dto.name,
        description: dto.description,
        model: dto.model ?? 'claude-sonnet-4-6',
        appendSystemPrompt: dto.appendSystemPrompt,
        systemPrompt: dto.systemPrompt,
        allowedTools: (dto.allowedTools ?? []) as Prisma.InputJsonValue,
        disallowedTools: (dto.disallowedTools ?? []) as Prisma.InputJsonValue,
        permissionMode: dto.permissionMode ?? 'dontAsk',
        maxTurns: dto.maxTurns,
        maxBudgetUsd: dto.maxBudgetUsd,
        mcpConfig: (dto.mcpConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        targetRunnerId: dto.targetRunnerId,
        targetLabels: dto.targetLabels ?? [],
        enabled: dto.enabled ?? true,
      },
    });
  }

  list(ownerId: string) {
    return this.prisma.agent.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(ownerId: string, id: string) {
    const agent = await this.prisma.agent.findFirst({ where: { id, ownerId } });
    if (!agent) throw new NotFoundException('agent not found');
    return agent;
  }

  async update(ownerId: string, id: string, dto: UpdateAgentDto) {
    await this.get(ownerId, id);
    await this.assertOwnedRunner(ownerId, dto.targetRunnerId);
    const data: Prisma.AgentUpdateInput = {
      name: dto.name,
      description: dto.description,
      model: dto.model,
      appendSystemPrompt: dto.appendSystemPrompt,
      systemPrompt: dto.systemPrompt,
      permissionMode: dto.permissionMode,
      maxTurns: dto.maxTurns,
      maxBudgetUsd: dto.maxBudgetUsd,
      targetRunnerId: dto.targetRunnerId,
      enabled: dto.enabled,
    };
    if (dto.allowedTools) data.allowedTools = dto.allowedTools as Prisma.InputJsonValue;
    if (dto.disallowedTools) data.disallowedTools = dto.disallowedTools as Prisma.InputJsonValue;
    if (dto.mcpConfig) data.mcpConfig = dto.mcpConfig as Prisma.InputJsonValue;
    if (dto.targetLabels) data.targetLabels = dto.targetLabels;
    return this.prisma.agent.update({ where: { id }, data });
  }

  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    await this.prisma.agent.delete({ where: { id } });
    return { ok: true };
  }
}

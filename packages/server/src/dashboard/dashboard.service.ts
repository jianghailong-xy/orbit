import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async costs(ownerId: string) {
    const tasksByStatus = await this.prisma.task.groupBy({
      by: ['status'],
      where: { ownerId },
      _count: true,
    });

    const runAgg = await this.prisma.taskRun.aggregate({
      where: { task: { ownerId } },
      _count: true,
      _sum: {
        costUsd: true,
        sumInputTokens: true,
        sumOutputTokens: true,
        sumCacheRead: true,
        sumCacheWrite: true,
      },
    });

    const recentRuns = await this.prisma.taskRun.findMany({
      where: { task: { ownerId } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        task: { select: { id: true, title: true } },
        agent: { select: { name: true, model: true } },
      },
    });

    return {
      tasksByStatus: tasksByStatus.map((t) => ({ status: t.status, count: t._count })),
      runs: runAgg._count,
      totalCostUsd: runAgg._sum.costUsd ?? 0,
      totalInputTokens: runAgg._sum.sumInputTokens ?? 0,
      totalOutputTokens: runAgg._sum.sumOutputTokens ?? 0,
      totalCacheRead: runAgg._sum.sumCacheRead ?? 0,
      totalCacheWrite: runAgg._sum.sumCacheWrite ?? 0,
      recentRuns,
    };
  }
}

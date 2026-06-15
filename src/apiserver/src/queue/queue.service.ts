import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { ClaimedJob, PermissionMode } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Task queue backed by the `Task` table. Runners claim work atomically via
 * `FOR UPDATE SKIP LOCKED`. A long-poll claim waits for an enqueue signal so
 * runners don't have to hammer the endpoint.
 */
@Injectable()
export class QueueService {
  private readonly signal = new EventEmitter();

  constructor(private readonly prisma: PrismaService) {
    this.signal.setMaxListeners(0);
  }

  /** Wake long-poll waiters after a task transitions to QUEUED. */
  notifyQueued(): void {
    this.signal.emit('queued');
  }

  private waitForSignal(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.signal.off('queued', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.signal.once('queued', done);
    });
  }

  async claimForRunner(
    runner: { id: string; labels: string[] },
    waitMs = 0,
  ): Promise<ClaimedJob | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const job = await this.tryClaim(runner);
      if (job) return job;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this.waitForSignal(Math.min(remaining, 5000));
    }
  }

  private async tryClaim(runner: { id: string; labels: string[] }): Promise<ClaimedJob | null> {
    const labels = runner.labels ?? [];
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "Task" SET status = 'RUNNING', "assignedRunnerId" = ${runner.id}, "updatedAt" = now()
      WHERE id = (
        SELECT t.id FROM "Task" t
        WHERE t.status = 'QUEUED'
          AND (t."scheduledAt" IS NULL OR t."scheduledAt" <= now())
          -- A runner may only ever claim tasks owned by the runner's own owner.
          -- This single top-level guard covers BOTH the assigned-runner branch
          -- and the agent/unassigned branch below (prevents cross-tenant exec).
          AND t."ownerId" = (SELECT r."ownerId" FROM "Runner" r WHERE r.id = ${runner.id})
          AND (
            t."assignedRunnerId" = ${runner.id}
            OR (
              t."assignedRunnerId" IS NULL AND (
                t."agentId" IS NULL OR EXISTS (
                  SELECT 1 FROM "Agent" a WHERE a.id = t."agentId"
                    AND (a."targetRunnerId" IS NULL OR a."targetRunnerId" = ${runner.id})
                    AND (cardinality(a."targetLabels") = 0 OR a."targetLabels" && ${labels}::text[])
                )
              )
            )
          )
        ORDER BY t.priority DESC, t."createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id
    `;
    if (rows.length === 0) return null;
    return this.buildJob(rows[0].id, runner.id);
  }

  private async buildJob(taskId: string, runnerId: string): Promise<ClaimedJob> {
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      include: { agent: true },
    });
    const run = await this.prisma.taskRun.create({
      data: {
        taskId: task.id,
        runnerId,
        agentId: task.agentId,
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });
    const agent = task.agent;
    return {
      runId: run.id,
      taskId: task.id,
      title: task.title,
      input: (task.input as Record<string, unknown>) ?? {},
      prompt: task.prompt,
      agent: {
        model: agent?.model ?? 'claude-sonnet-4-6',
        appendSystemPrompt: agent?.appendSystemPrompt ?? undefined,
        systemPrompt: agent?.systemPrompt ?? undefined,
        allowedTools: (agent?.allowedTools as string[] | null) ?? [],
        disallowedTools: (agent?.disallowedTools as string[] | null) ?? [],
        permissionMode: (agent?.permissionMode as PermissionMode) ?? PermissionMode.DONT_ASK,
        maxTurns: agent?.maxTurns ?? undefined,
        maxBudgetUsd: agent?.maxBudgetUsd ?? undefined,
        mcpConfig: (agent?.mcpConfig as Record<string, unknown> | null) ?? undefined,
      },
    };
  }
}

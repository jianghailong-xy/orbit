import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Prisma, RunStatus, TaskStatus } from '@prisma/client';
import {
  ClaimedJob,
  RunCompleteRequest,
  RunEventBatch,
  RunEventType,
  RunnerHeartbeatRequest,
  RunnerHeartbeatResponse,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
} from '@orbit/shared';
import { generateToken, sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

const LONG_POLL_MS = 25_000;

@Controller('runner')
export class RunnerApiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
  ) {}

  /** `orbit register` — exchange a one-time enrollment token for a runner credential. */
  @Post('register')
  async register(@Body() dto: RunnerRegisterRequest): Promise<RunnerRegisterResponse> {
    if (!dto?.enrollmentToken || !dto?.name) {
      throw new UnauthorizedException('enrollmentToken and name are required');
    }
    const enrollment = await this.prisma.enrollmentToken.findUnique({
      where: { tokenHash: sha256(dto.enrollmentToken) },
    });
    if (!enrollment) throw new UnauthorizedException('invalid enrollment token');
    if (enrollment.usedAt) throw new UnauthorizedException('enrollment token already used');
    if (enrollment.expiresAt && enrollment.expiresAt < new Date()) {
      throw new UnauthorizedException('enrollment token expired');
    }

    const runnerToken = generateToken(32);
    const runner = await this.prisma.runner.create({
      data: {
        name: dto.name,
        hostname: dto.hostname,
        ownerId: enrollment.ownerId,
        labels: dto.labels ?? [],
        maxConcurrent: dto.maxConcurrent ?? 1,
        version: dto.version,
        tokenHash: sha256(runnerToken),
        status: 'ONLINE',
        lastHeartbeatAt: new Date(),
      },
    });
    await this.prisma.enrollmentToken.update({
      where: { id: enrollment.id },
      data: { usedAt: new Date() },
    });

    return { runnerId: runner.id, runnerToken, name: runner.name };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('heartbeat')
  async heartbeat(
    @CurrentRunner() runner: { id: string; version: string | null },
    @Body() dto: RunnerHeartbeatRequest,
  ): Promise<RunnerHeartbeatResponse> {
    await this.prisma.runner.update({
      where: { id: runner.id },
      data: {
        status: dto?.status ?? 'ONLINE',
        version: dto?.version ?? runner.version ?? undefined,
        lastHeartbeatAt: new Date(),
      },
    });
    return { cancelRunIds: this.realtime.drainCancellations(runner.id) };
  }

  /** Long-poll: returns one claimed job, or null when nothing is available. */
  @UseGuards(RunnerAuthGuard)
  @Get('jobs')
  jobs(@CurrentRunner() runner: { id: string; labels: string[] }): Promise<ClaimedJob | null> {
    return this.queue.claimForRunner({ id: runner.id, labels: runner.labels }, LONG_POLL_MS);
  }

  @UseGuards(RunnerAuthGuard)
  @Post('runs/:id/events')
  @HttpCode(202)
  async events(
    @CurrentRunner() runner: { id: string },
    @Param('id') runId: string,
    @Body() batch: RunEventBatch,
  ) {
    await this.assertOwnership(runId, runner.id);
    const events = batch?.events ?? [];
    if (events.length === 0) return { ok: true };

    await this.prisma.runEvent.createMany({
      data: events.map((e) => ({
        runId,
        seq: e.seq,
        type: e.type,
        payload: e.payload as Prisma.InputJsonValue,
        createdAt: new Date(e.ts),
      })),
      skipDuplicates: true,
    });

    const toolUses = events.filter((e) => e.type === RunEventType.TOOL_USE);
    if (toolUses.length > 0) {
      await this.prisma.toolCall.createMany({
        data: toolUses.map((e) => ({
          runId,
          name: String((e.payload as Record<string, unknown>).name ?? 'unknown'),
          input: ((e.payload as Record<string, unknown>).input ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          startedAt: new Date(e.ts),
        })),
      });
    }

    for (const e of events) this.realtime.publish(runId, e);
    return { ok: true };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('runs/:id/complete')
  async complete(
    @CurrentRunner() runner: { id: string },
    @Param('id') runId: string,
    @Body() dto: RunCompleteRequest,
  ) {
    const run = await this.assertOwnership(runId, runner.id);
    const usage = dto.usage;

    await this.prisma.taskRun.update({
      where: { id: runId },
      data: {
        status: dto.status as RunStatus,
        result: dto.result,
        subtype: dto.subtype,
        error: dto.error,
        claudeSessionId: dto.claudeSessionId,
        numTurns: dto.numTurns ?? 0,
        costUsd: dto.costUsd ?? 0,
        sumInputTokens: usage?.input_tokens ?? 0,
        sumOutputTokens: usage?.output_tokens ?? 0,
        sumCacheRead: usage?.cache_read_input_tokens ?? 0,
        sumCacheWrite: usage?.cache_creation_input_tokens ?? 0,
        finishedAt: new Date(),
      },
    });

    if (dto.modelUsage) {
      const rows = Object.entries(dto.modelUsage).map(([model, mu]) => ({
        runId,
        model,
        inputTokens: mu.inputTokens ?? 0,
        outputTokens: mu.outputTokens ?? 0,
        cacheCreationInputTokens: mu.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: mu.cacheReadInputTokens ?? 0,
        costUsd: mu.costUSD ?? 0,
      }));
      if (rows.length > 0) await this.prisma.llmUsage.createMany({ data: rows });
    }

    const taskStatus: TaskStatus =
      dto.status === RunStatus.SUCCEEDED
        ? TaskStatus.SUCCEEDED
        : dto.status === RunStatus.CANCELLED
          ? TaskStatus.CANCELLED
          : TaskStatus.FAILED;
    await this.prisma.task.update({
      where: { id: run.taskId },
      data: { status: taskStatus },
    });

    this.realtime.publish(runId, {
      seq: Number.MAX_SAFE_INTEGER,
      type: RunEventType.STATUS,
      ts: new Date().toISOString(),
      payload: { status: dto.status, final: true },
    });
    return { ok: true };
  }

  private async assertOwnership(runId: string, runnerId: string) {
    const run = await this.prisma.taskRun.findUnique({ where: { id: runId } });
    if (!run || run.runnerId !== runnerId) {
      throw new ForbiddenException('run does not belong to this runner');
    }
    return run;
  }
}

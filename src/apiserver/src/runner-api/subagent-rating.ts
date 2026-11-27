import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  SUBAGENT_RATING_NOTE_MAX,
  type SubagentRatingRequest,
  type SubagentRatingResponse,
  uuidToBase62,
} from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { stripNul } from './strip-nul';

/**
 * The parent's rating of a SubAgent run it started (docs/subagent-design.md §7.1): `subagent_rate`, reached through
 * POST /runner/sessions/:id/subagents/:runId/rating. How useful the result was, 1 to 5, anchored to what the parent
 * did with it: 1 discarded it or redid the work, 3 usable after fixes, 5 used as-is. One rating per run; a later one
 * replaces it. The Model tiers view shows the ratings beside each model; routing never reads them.
 */

export class SubagentRatingDto implements SubagentRatingRequest {
  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;

  @IsOptional()
  @IsString()
  @MaxLength(SUBAGENT_RATING_NOTE_MAX)
  note?: string;
}

function stillRunning(): ConflictException {
  return new ConflictException({
    code: 'SUBAGENT_RUN_RUNNING',
    message: 'This SubAgent is still running: rate it once it has ended and you have used its result.',
  });
}

/**
 * Write the rating onto the run, with the rating parent's own engine, provider and model as the session runs now.
 * The run is matched by (id, the calling session) only, so another session's run — another account's included —
 * reads as not found. A run still running has no result to rate yet: 409 SUBAGENT_RUN_RUNNING. One statement,
 * guarded on the run having ended, so a rating can never land on a run that is still RUNNING.
 */
export async function rateSubagentRun(
  prisma: PrismaClient,
  sessionId: string,
  runId: string,
  dto: SubagentRatingRequest,
  now = new Date(),
): Promise<SubagentRatingResponse> {
  const run = await prisma.subagentRun.findFirst({
    where: { id: runId, sessionId },
    select: { status: true, ratedAt: true, session: { select: { engine: true, provider: true, model: true } } },
  });
  if (!run) throw new NotFoundException('SubAgent run not found');
  if (run.status === 'RUNNING') throw stillRunning();
  const note = dto.note === undefined ? null : stripNul(dto.note).trim() || null;
  const rater = { engine: run.session.engine ?? null, provider: run.session.provider, model: run.session.model ?? null };
  const written = await prisma.subagentRun.updateMany({
    where: { id: runId, sessionId, status: { not: 'RUNNING' } },
    data: {
      ratingScore: dto.score,
      ratingNote: note,
      ratedAt: now,
      raterEngine: rater.engine,
      raterProvider: rater.provider,
      raterModel: rater.model,
    },
  });
  // Resumed (back to RUNNING) between the read and the write.
  if (written.count === 0) throw stillRunning();
  return {
    runId: uuidToBase62(runId),
    score: dto.score,
    note,
    ratedAt: now.toISOString(),
    rater,
    replaced: run.ratedAt !== null,
  };
}

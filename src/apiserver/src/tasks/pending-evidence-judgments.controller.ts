import { BadRequestException, Controller, Get, Headers, Query, Res, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { ifNoneMatchHits } from '../sessions/open-list-version';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

/**
 * The read behind the decision rail: what one session is being asked to decide, right now.
 *
 * Its own controller because the question is not about one task — it is "which of this account's
 * tasks is waiting", which no `tasks/:taskId/...` prefix can express. The deciding session is
 * required rather than optional: every row carries whether THAT session may answer it, and a queue
 * that did not know who was reading it could only report a question, never whether the reader is
 * allowed to settle it.
 */
@UseGuards(JwtAuthGuard)
@Controller('tasks/evidence-decisions')
export class PendingEvidenceJudgmentsController {
  constructor(private readonly evidence: TaskCompletionEvidenceService) {}

  @PatScope('tasks:read', { workspaceConfinable: false })
  @Get('pending')
  async pending(
    @CurrentUser() user: AuthUser,
    @Query('decidingSessionId', PublicIdPipe) decidingSessionId: string | undefined,
    @Headers('if-none-match') ifNoneMatch?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    if (!decidingSessionId) {
      throw new BadRequestException('decidingSessionId names the session these rows are read for');
    }
    const queue = await this.evidence.pending(user.userId, decidingSessionId);
    if (res) {
      // Conditional, decided here for the reason the Open list's is: the global `Cache-Control:
      // no-cache` makes Express's own freshness check refuse, and its body-hash ETag would differ on
      // every read anyway, because the body carries the read's clock (`readAt`) and each row's age
      // (`ageSeconds`, `oldestAgeSeconds`). Those three move with time alone, so the ETag leaves
      // them out: a 304 means no question, row or decision changed.
      const etag = pendingEvidenceEtag(queue);
      res.setHeader('ETag', etag);
      if (ifNoneMatchHits(ifNoneMatch, etag)) {
        res.status(304);
        return undefined;
      }
    }
    return queue;
  }
}

const CLOCK_ONLY_FIELDS = new Set(['readAt', 'ageSeconds', 'oldestAgeSeconds']);

/** A weak ETag of the queue's bytes without the fields that change with the clock alone. */
function pendingEvidenceEtag(queue: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(queue, (key, value) => (CLOCK_ONLY_FIELDS.has(key) ? undefined : value)))
    .digest('base64url')
    .slice(0, 27);
  return `W/"pe1-${digest}"`;
}

import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  OUTCOME_SURFACE_LIMITS,
  redactOutcomePayload,
} from './outcome-payload-redaction';

function boundedRedacted<T>(value: T, maxBytes = OUTCOME_SURFACE_LIMITS.maxProjectionBytes): T {
  const safe = redactOutcomePayload(value) as T;
  if (Buffer.byteLength(JSON.stringify(safe), 'utf8') > maxBytes) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'OUTCOME_SURFACE_RESPONSE_TOO_LARGE',
    });
  }
  return safe;
}

/**
 * The owner's decision inbox, and nothing else.
 *
 * Two families of item used to arrive here and both were deleted with the machinery that produced
 * them: the canonical obligation projection went with the obligation algebra, and migration 0226
 * took the Failure Continuation owner-only route with the router that classified it. The shape is
 * unchanged and the route stays where the clients that poll it expect it; what it reports is
 * whatever a producer writes, which today is nothing. No stand-in queue is manufactured to fill it.
 */
@Injectable()
export class OutcomeSurfaceService {
  /** A fail-closed, bounded human surface. */
  async humanInbox(_tenantId: string, limit = 100): Promise<Record<string, unknown>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    // No producer writes into this surface any more, so the bounded, redacted assembly that used to
    // page candidates into it has nothing to page. The envelope is deliberately unchanged: clients
    // poll it for a count, and reporting an empty inbox is a different answer from 404 or 500.
    return boundedRedacted({
      schemaVersion: 2,
      actor: 'OWNER',
      surface: 'HUMAN_DECISION_INBOX',
      total: 0,
      items: [] as Array<Record<string, unknown>>,
      truncated: false,
      decisionTypeSeparation: {
        perItemJudgment: 'EVIDENCE_JUDGMENT',
      },
    });
  }
}

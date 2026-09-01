import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { FailureContinuationWakeClaim } from './failure-continuation';
import {
  type FailureContinuationObservation,
  type FailureContinuationRouteDecision,
  validateFailureContinuationObservation,
} from './failure-continuation-controller';

/**
 * Atomic adapter for migration 0211's deterministic route reducer.
 *
 * The stored function validates the live outbox lease, reads the immutable attempt receipt and a
 * single database snapshot of binding and capability state, serializes the fingerprint
 * lineage, and appends one decision. This service deliberately has no in-memory counters.
 */
@Injectable()
export class FailureContinuationControllerService {
  constructor(private readonly prisma: PrismaService) {}

  async routeClaim(
    claim: FailureContinuationWakeClaim,
    observedAt = new Date(),
    observation: FailureContinuationObservation = {},
  ): Promise<FailureContinuationRouteDecision> {
    validateFailureContinuationObservation(observation);
    const evidenceFacts = observation.evidenceFacts ?? {};
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT failure_continuation_route_claim(
        ${claim.outboxId}::uuid,
        ${claim.obligationId}::uuid,
        ${claim.leaseToken}::uuid,
        ${claim.leaseGeneration},
        ${observedAt},
        ${observation.failureNode ?? null},
        ${observation.ownerReason ?? null},
        ${observation.requiredCapability?.trim() || null},
        ${JSON.stringify(evidenceFacts)}::jsonb
      ) AS result
    `);
    if (!row?.result) throw new Error('FAILURE_CONTINUATION_ROUTE_RETURNED_NO_DECISION');
    return row.result as unknown as FailureContinuationRouteDecision;
  }
}

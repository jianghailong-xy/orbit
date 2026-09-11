/**
 * The planUsage a runner heartbeat writes, and the compare-and-set that writes it: the apiserver half
 * of §8 of docs/codex-rate-limit-reset-contract.md.
 *
 * A heartbeat's planUsage is stored as reported except for the Codex rate-limit reset block, which
 * only moves forwards. It replaces the stored block when orderCodexResetSnapshot accepts it and is
 * otherwise swapped for the stored one, so a block relayed by a process that did not read it, an
 * older read, an old process still reporting, or a heartbeat that arrives out of order never takes
 * the stored block back. The write is a compare-and-set on the value the merge was computed against:
 * when another heartbeat changed planUsage in between, the merge is redone against what that one
 * wrote instead of overwriting it.
 */
import { Prisma } from '@prisma/client';
import {
  codexRateLimitResetOf,
  codexRateLimitResetViolations,
  codexResetSnapshotAccepted,
  orderCodexResetSnapshot,
  type CodexResetSnapshotOrder,
  type PlanUsage,
  type PlanUsageRateLimitReset,
  type PlanUsageSnapshot,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';

/** How often a heartbeat re-reads and re-merges when other writers keep changing planUsage first. */
export const PLAN_USAGE_CAS_ATTEMPTS = 4;

export interface HeartbeatPlanUsageMerge {
  planUsage: PlanUsage;
  /** How the heartbeat's Codex reset block compared with the stored one; null without a Codex snapshot. */
  order: CodexResetSnapshotOrder | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `incoming` as it may be written over `stored`. A heartbeat without a Codex snapshot is written as
 * reported, and so is one whose block is accepted; otherwise its Codex snapshot keeps the stored
 * block if that is a v1 block, and no block if it is not. A refused block is never written.
 */
export function mergeHeartbeatPlanUsage(
  stored: unknown,
  incoming: PlanUsage,
  leaseOwner: string | null,
  now: Date,
): HeartbeatPlanUsageMerge {
  const codex: PlanUsageSnapshot | undefined = incoming.codex ?? (incoming.provider === 'codex' ? incoming : undefined);
  if (!codex) return { planUsage: incoming, order: null };
  const previous = isObject(stored) ? codexRateLimitResetOf(stored as PlanUsage) : undefined;
  const order = orderCodexResetSnapshot(previous, codex.rateLimitReset, leaseOwner, now);
  if (codexResetSnapshotAccepted(order)) return { planUsage: incoming, order };
  const { rateLimitReset: _refused, ...rest } = codex;
  const kept: PlanUsageSnapshot =
    previous !== undefined && codexRateLimitResetViolations(previous).length === 0 ? { ...rest, rateLimitReset: previous } : rest;
  return { planUsage: incoming.codex ? { ...incoming, codex: kept } : kept, order };
}

/**
 * Writes a heartbeat's planUsage by compare-and-set: merged against the stored value, and written only
 * while that is still the stored value. A lost race re-reads and merges again. Returns whether it
 * wrote; a runner row that is gone, or PLAN_USAGE_CAS_ATTEMPTS lost races, writes nothing and leaves
 * the next heartbeat to report again.
 */
export async function storeHeartbeatPlanUsage(
  prisma: PrismaService,
  runnerId: string,
  incoming: PlanUsage,
  leaseOwner: string | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < PLAN_USAGE_CAS_ATTEMPTS; attempt++) {
    const row = await prisma.runner.findUnique({ where: { id: runnerId }, select: { planUsage: true } });
    if (!row) return false;
    const { planUsage } = mergeHeartbeatPlanUsage(row.planUsage, incoming, leaseOwner, new Date());
    const written = await prisma.runner.updateMany({
      where: {
        id: runnerId,
        planUsage: row.planUsage === null ? { equals: Prisma.AnyNull } : { equals: row.planUsage as Prisma.InputJsonValue },
      },
      data: { planUsage: planUsage as Prisma.InputJsonValue },
    });
    if (written.count === 1) return true;
  }
  return false;
}

/**
 * Writes the block a REFRESHED result carried (§6.3) into the stored Codex snapshot, by the same
 * compare-and-set and under the same order: only when orderCodexResetSnapshot accepts it over the block
 * stored now, `leaseOwner` being the result's. The rest of the snapshot stays as the last heartbeat
 * reported it, and a runner with no stored Codex snapshot is given none — one holding nothing but a
 * reset block would read as usage data (§2). Returns whether it wrote.
 */
export async function storeRefreshedCodexResetBlock(
  prisma: PrismaService,
  runnerId: string,
  block: PlanUsageRateLimitReset,
  leaseOwner: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < PLAN_USAGE_CAS_ATTEMPTS; attempt++) {
    const row = await prisma.runner.findUnique({ where: { id: runnerId }, select: { planUsage: true } });
    if (!row || !isObject(row.planUsage)) return false;
    const stored = row.planUsage as PlanUsage;
    const codex: PlanUsageSnapshot | undefined = stored.codex ?? (stored.provider === 'codex' ? stored : undefined);
    if (!codex || !codexResetSnapshotAccepted(orderCodexResetSnapshot(codex.rateLimitReset, block, leaseOwner, new Date()))) {
      return false;
    }
    const planUsage: PlanUsage = stored.codex
      ? { ...stored, codex: { ...codex, rateLimitReset: block } }
      : { ...codex, rateLimitReset: block };
    const written = await prisma.runner.updateMany({
      where: { id: runnerId, planUsage: { equals: row.planUsage as Prisma.InputJsonValue } },
      data: { planUsage: planUsage as Prisma.InputJsonValue },
    });
    if (written.count === 1) return true;
  }
  return false;
}

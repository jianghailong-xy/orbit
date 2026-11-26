/**
 * The planUsage a runner heartbeat writes, and the compare-and-set that writes it: the apiserver half
 * of §8 and §12.2 of docs/codex-rate-limit-reset-contract.md.
 *
 * A heartbeat's planUsage is stored as reported except for the Codex rate-limit reset blocks — Default's
 * and each added account's, each ordered against its own account's alone — which only move forwards. It replaces the stored block when orderCodexResetSnapshot accepts it and is
 * otherwise swapped for the stored one, so a block relayed by a process that did not read it, an
 * older read, an old process still reporting, or a heartbeat that arrives out of order never takes
 * the stored block back. The write is a compare-and-set on the value the merge was computed against:
 * when another heartbeat changed planUsage in between, the merge is redone against what that one
 * wrote instead of overwriting it. How each offered block compared is counted
 * (orbit_codex_reset_snapshot_writes_total), so "old processes keep reporting older reads" is a number.
 */
import { Prisma } from '@prisma/client';
import {
  CODEX_DEFAULT_ACCOUNT,
  CODEX_DEFAULT_ACCOUNT_SLOT,
  codexAccountSnapshot,
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
import { sanitizePlanUsageAccounts } from '../providers/plan-usage-accounts';
import { countCodexResetSnapshotWrite } from '../runners/codex-reset-metrics';

/** How often a heartbeat re-reads and re-merges when other writers keep changing planUsage first. */
export const PLAN_USAGE_CAS_ATTEMPTS = 4;

export interface HeartbeatPlanUsageMerge {
  planUsage: PlanUsage;
  /** How each Codex reset block the heartbeat offered compared with the one stored for the same account:
   *  Default's first, when the heartbeat carries a Codex snapshot of Default's, then each added account's
   *  that has a block reported or stored. Empty without a Codex snapshot. */
  orders: CodexResetSnapshotOrder[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A reading's Codex snapshot: nested under `codex`, or the payload itself from an older runner. */
function codexSnapshot(usage: PlanUsage | undefined): PlanUsageSnapshot | undefined {
  return usage?.codex ?? (usage?.provider === 'codex' ? usage : undefined);
}

/**
 * Default's own part of a runner's Codex snapshot, where its reset block lives: none for a snapshot
 * holding only the runner's other accounts (codexAccountSnapshot).
 */
function defaultCodexSnapshot(usage: PlanUsage | undefined): PlanUsageSnapshot | undefined {
  const codex = codexSnapshot(usage);
  return codex && codexAccountSnapshot(codex, CODEX_DEFAULT_ACCOUNT) ? codex : undefined;
}

/** The block one account is stored with after offering `incoming` over `stored`: `incoming` when the
 *  order accepts it, else the stored block if that is a v1 block, else none. */
function orderedBlock(
  stored: PlanUsageRateLimitReset | undefined,
  incoming: PlanUsageRateLimitReset | undefined,
  leaseOwner: string | null,
  now: Date,
): { block: PlanUsageRateLimitReset | undefined; order: CodexResetSnapshotOrder } {
  const order = orderCodexResetSnapshot(stored, incoming, leaseOwner, now);
  if (codexResetSnapshotAccepted(order)) return { block: incoming, order };
  return { block: stored !== undefined && codexRateLimitResetViolations(stored).length === 0 ? stored : undefined, order };
}

/** `snapshot` carrying `block` as its reset block, or none; the same object when it already does. */
function withBlock(snapshot: PlanUsageSnapshot, block: PlanUsageRateLimitReset | undefined): PlanUsageSnapshot {
  if (snapshot.rateLimitReset === block) return snapshot;
  const { rateLimitReset: _replaced, ...rest } = snapshot;
  return block === undefined ? rest : { ...rest, rateLimitReset: block };
}

/**
 * `incoming` as it may be written over `stored`. Every Codex account's reset block is ordered on its
 * own, against the block stored for that same account (contract v2 §12.2): Default's beside the Codex
 * snapshot's windows, each added account's in its `accounts` entry. An accepted block is written as
 * reported; a refused one is never written, and that account keeps its stored block if that is a v1
 * block, and no block if it is not. One account's refusal changes nothing of another's. A snapshot
 * holding only the runner's other accounts is never given a block of Default's: with nothing of
 * Default's beside it, a block would read as usage data (§2). An account the heartbeat no longer
 * reports is not written at all, so its block goes with its entry. A heartbeat whose every block is
 * accepted is written as reported, the same object.
 */
export function mergeHeartbeatPlanUsage(
  stored: unknown,
  incoming: PlanUsage,
  leaseOwner: string | null,
  now: Date,
): HeartbeatPlanUsageMerge {
  const codex = codexSnapshot(incoming);
  if (!codex) return { planUsage: incoming, orders: [] };
  const previous = isObject(stored) ? (stored as PlanUsage) : undefined;
  const orders: CodexResetSnapshotOrder[] = [];
  let merged = codex;
  if (defaultCodexSnapshot(incoming)) {
    const { block, order } = orderedBlock(codexRateLimitResetOf(previous), codex.rateLimitReset, leaseOwner, now);
    orders.push(order);
    merged = withBlock(merged, block);
  }
  const reported = codex.accounts;
  if (isObject(reported)) {
    let accounts = reported;
    for (const [slot, entry] of Object.entries(reported) as Array<[string, PlanUsageSnapshot]>) {
      const before = codexRateLimitResetOf(previous, slot);
      // An account neither reporting nor holding a block has nothing to order: a runner that reads no
      // added account's credits is not counted refusing one on every heartbeat.
      if (typeof entry !== 'object' || entry === null || (entry.rateLimitReset === undefined && before === undefined)) continue;
      const { block, order } = orderedBlock(before, entry.rateLimitReset, leaseOwner, now);
      orders.push(order);
      const kept = withBlock(entry, block);
      if (kept !== entry) accounts = { ...accounts, [slot]: kept };
    }
    if (accounts !== reported) merged = { ...merged, accounts };
  }
  if (merged === codex) return { planUsage: incoming, orders };
  return { planUsage: incoming.codex ? { ...incoming, codex: merged } : merged, orders };
}

/**
 * Writes a heartbeat's planUsage by compare-and-set: merged against the stored value, and written only
 * while that is still the stored value. A lost race re-reads and merges again. Returns whether it
 * wrote; a runner row that is gone, or PLAN_USAGE_CAS_ATTEMPTS lost races, writes nothing and leaves
 * the next heartbeat to report again. Each Codex account is stored as its own snapshot
 * (sanitizePlanUsageAccounts), so no account's windows are written over another's.
 */
export async function storeHeartbeatPlanUsage(
  prisma: PrismaService,
  runnerId: string,
  incoming: PlanUsage,
  leaseOwner: string | null,
): Promise<boolean> {
  const reported = sanitizePlanUsageAccounts(incoming);
  for (let attempt = 0; attempt < PLAN_USAGE_CAS_ATTEMPTS; attempt++) {
    const row = await prisma.runner.findUnique({ where: { id: runnerId }, select: { planUsage: true } });
    if (!row) return false;
    const { planUsage, orders } = mergeHeartbeatPlanUsage(row.planUsage, reported, leaseOwner, new Date());
    const written = await prisma.runner.updateMany({
      where: {
        id: runnerId,
        planUsage: row.planUsage === null ? { equals: Prisma.AnyNull } : { equals: row.planUsage as Prisma.InputJsonValue },
      },
      data: { planUsage: planUsage as Prisma.InputJsonValue },
    });
    if (written.count === 1) {
      for (const order of orders) countCodexResetSnapshotWrite('heartbeat', order);
      return true;
    }
  }
  countCodexResetSnapshotWrite('heartbeat', 'cas_exhausted');
  return false;
}

/**
 * Writes the block a REFRESHED result carried (§6.3) into the stored Codex snapshot of the operation's
 * account (`accountSlot`, §12.2), by the same compare-and-set and under the same order: only when
 * orderCodexResetSnapshot accepts it over that account's block stored now, `leaseOwner` being the
 * result's. Never into another account's. The rest of the snapshot stays as the last heartbeat reported
 * it, and an account with no stored snapshot is given none: Default's needs a Codex snapshot of
 * Default's — one holding nothing but a reset block, or only the runner's other accounts beside it,
 * would read as usage data (§2) — and an added account needs its `accounts` entry. Returns whether it
 * wrote.
 */
export async function storeRefreshedCodexResetBlock(
  prisma: PrismaService,
  runnerId: string,
  block: PlanUsageRateLimitReset,
  leaseOwner: string,
  accountSlot: string = CODEX_DEFAULT_ACCOUNT_SLOT,
): Promise<boolean> {
  for (let attempt = 0; attempt < PLAN_USAGE_CAS_ATTEMPTS; attempt++) {
    const row = await prisma.runner.findUnique({ where: { id: runnerId }, select: { planUsage: true } });
    const stored = row && isObject(row.planUsage) ? (row.planUsage as PlanUsage) : undefined;
    const codex = accountSlot === CODEX_DEFAULT_ACCOUNT_SLOT ? defaultCodexSnapshot(stored) : codexSnapshot(stored);
    const entry = codex && accountSlot !== CODEX_DEFAULT_ACCOUNT_SLOT ? codexAccountSnapshot(codex, accountSlot) : codex;
    if (!row || !stored || !codex || !entry) {
      countCodexResetSnapshotWrite('refreshed', 'no_codex_snapshot');
      return false;
    }
    const order = orderCodexResetSnapshot(entry.rateLimitReset, block, leaseOwner, new Date());
    if (!codexResetSnapshotAccepted(order)) {
      countCodexResetSnapshotWrite('refreshed', order);
      return false;
    }
    const writtenCodex: PlanUsageSnapshot =
      accountSlot === CODEX_DEFAULT_ACCOUNT_SLOT
        ? { ...codex, rateLimitReset: block }
        : { ...codex, accounts: { ...codex.accounts, [accountSlot]: { ...entry, rateLimitReset: block } } };
    const planUsage: PlanUsage = stored.codex ? { ...stored, codex: writtenCodex } : writtenCodex;
    const written = await prisma.runner.updateMany({
      where: { id: runnerId, planUsage: { equals: row.planUsage as Prisma.InputJsonValue } },
      data: { planUsage: planUsage as Prisma.InputJsonValue },
    });
    if (written.count === 1) {
      countCodexResetSnapshotWrite('refreshed', order);
      return true;
    }
  }
  countCodexResetSnapshotWrite('refreshed', 'cas_exhausted');
  return false;
}

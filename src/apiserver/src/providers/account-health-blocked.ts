/**
 * What account health takes out of the choices made inside one credential (docs/routing-account-health-design.md
 * §7.6, §9 "Claude pool"): Automatic's account among a runner's sign-ins to one engine, and the member a pool's claim
 * runs on. Routing reads the same entries (model-routing.ts engineVerdict, bestPoolMember); this is the other half,
 * which holds with smart model selection off too, since neither choice is routing's.
 *
 * Only an entry on the whole account counts, in one of the three states that remove it (§7.1): blocked, cooling
 * down, or being tried by another run. A suspect account and one whose trial is due stay in. And a choice whose
 * every candidate is out is made as it was before health (accountBlockOn, withoutBlocked): health says which
 * account to prefer, never that a session may not run.
 */
import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AccountEngine } from '@orbit/shared';
import { ACCOUNT_ENGINES } from '../common/runner-engines';
import type { PrismaService } from '../prisma/prisma.service';
import type { RoutingHealthEntry } from '../tasks/model-routing';
import { accountsOn, type AccountBlock, type AccountBlockReason, type AccountRunner, type BlockedAccounts } from './account';
import { subjectKey, UNCLASSIFIED_ADMISSION, type AccountHealthSubject } from './account-health';
import { liveAccountHealth, routingHealthEntry } from './account-health.service';

type HealthDb = Prisma.TransactionClient | PrismaService;

const log = new Logger('AccountHealth');

/** The states that take an account out (§7.1); suspect and trial-due do not. */
const REMOVES: ReadonlySet<RoutingHealthEntry['state']> = new Set(['blocked', 'cooldown', 'trial-running']);

/** The block one subject's entries put on the whole account, or null when none of them removes it. */
export function accountBlockOf(entries: readonly RoutingHealthEntry[] | null | undefined): AccountBlock | null {
  const entry = entries?.find((candidate) => candidate.model === null && REMOVES.has(candidate.state));
  return entry ? { until: entry.until, reason: blockReason(entry) } : null;
}

function blockReason(entry: RoutingHealthEntry): AccountBlockReason {
  if (entry.state === 'trial-running') return 'trial';
  if (entry.kind === 'USAGE_LIMIT') return 'usage-limit';
  if (entry.kind === UNCLASSIFIED_ADMISSION) return 'failing';
  return 'needs-action';
}

/** Whether health takes `subject`'s whole account out: a pool member, a pool login or a runner's sign-in. */
export function subjectBlocked(health: ReadonlyMap<string, RoutingHealthEntry[]>, subject: AccountHealthSubject): boolean {
  return accountBlockOf(health.get(subjectKey(subject))) !== null;
}

/**
 * `runner` with what health says of its accounts (AccountRunner.blockedAccounts), from an owner's index by subject
 * key (routingHealthIndex): each of its sign-ins is the subject `runner:<runnerId>:<engine>:<account>`. The same
 * runner when none of them is out, or without a runner id to name them by.
 */
export function runnerWithHealth<R extends AccountRunner>(
  runner: R,
  runnerId: string | null | undefined,
  health: ReadonlyMap<string, RoutingHealthEntry[]> | null | undefined,
  now: Date,
): R {
  if (!runnerId || !health || health.size === 0) return runner;
  let blocked: BlockedAccounts | undefined;
  for (const engine of ACCOUNT_ENGINES as readonly AccountEngine[]) {
    for (const account of accountsOn(engine, runner, now) ?? []) {
      const block = accountBlockOf(health.get(subjectKey({ type: 'runner', runnerId, engine, account: account.id })));
      if (!block) continue;
      blocked ??= {};
      (blocked[engine] ??= {})[account.id] = block;
    }
  }
  return blocked ? { ...runner, blockedAccounts: blocked } : runner;
}

/**
 * The owner's live health by subject key, as routingHealthIndex reads it, less the trial `sessionId` itself holds:
 * the run routing sent to try an account is not to be moved off it by the claim that starts it.
 *
 * Health only says which account to prefer, so a read that fails answers no health, and the choice is made as it was
 * before health; it is logged, and never fails the create, claim or move that asked. Callers hand it the root client,
 * never their transaction: a failed statement inside one would abort the transaction it was caught in.
 */
export async function healthIndexFor(
  db: HealthDb,
  ownerId: string,
  now: Date,
  sessionId?: string | null,
): Promise<Map<string, RoutingHealthEntry[]>> {
  const index = new Map<string, RoutingHealthEntry[]>();
  try {
    for (const entry of await liveAccountHealth(db, ownerId, now)) {
      if (sessionId && entry.view === 'trial-running' && entry.trialSessionId === sessionId) continue;
      const list = index.get(entry.subjectKey) ?? [];
      list.push(routingHealthEntry(entry));
      index.set(entry.subjectKey, list);
    }
  } catch (error) {
    log.warn(`account health not read for an account choice: ${(error as Error)?.message ?? error}`);
    return new Map();
  }
  return index;
}

/**
 * runnerWithHealth, read for one runner: the owner's health is read only when one of the runner's engines has an
 * account to choose between, as activeSessionsOn counts sessions only then.
 */
export async function withAccountHealth<R extends AccountRunner>(
  db: HealthDb,
  ownerId: string,
  runnerId: string | null | undefined,
  runner: R,
  now: Date,
  sessionId?: string | null,
): Promise<R> {
  if (!runnerId || !ACCOUNT_ENGINES.some((engine) => (accountsOn(engine as AccountEngine, runner, now)?.length ?? 0) > 1)) return runner;
  return runnerWithHealth(runner, runnerId, await healthIndexFor(db, ownerId, now, sessionId), now);
}

/**
 * `items` without the ones health takes out, while one of the rest can run (`canRun`); otherwise `items` as they
 * came, so that a pool whose every member that can run is blocked is chosen from as before health, rather than
 * falling back to the runner's own login or waiting on a member that is merely spent.
 */
export function withoutBlocked<T>(items: readonly T[], blocked: (item: T) => boolean, canRun: (item: T) => boolean): readonly T[] {
  const kept = items.filter((item) => !blocked(item));
  return kept.length < items.length && kept.some(canRun) ? kept : items;
}

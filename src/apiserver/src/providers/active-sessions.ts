import type { Prisma } from '@prisma/client';
import { isAccountEngine, RunStatus, type AccountEngine, type RunnerEngineHealth } from '@orbit/shared';
import { ACCOUNT_ENGINES, engineKeepsAccounts } from '../common/runner-engines';
import { ACCOUNT_CHOICE, accountsOn, type AccountRunner, type ActiveSessions } from './account';
import { isBuiltinProvider } from './custom-provider';
import { accountBeforeDispatch, runAccount, type AccountMove, type AccountWorkspace } from './plan-usage-accounts';
import { recordedEngine } from './session-engine';

/**
 * How long a session between turns still counts as at work after its last: a coordinator between two
 * wakes, a conversation with somebody who is about to answer. What an account has to carry is the work
 * about to spend it, not only the turns running this second.
 */
const ACTIVE_SESSION_WINDOW_MS = 30 * 60_000;

type ActiveSessionsReader = { session: Pick<Prisma.TransactionClient['session'], 'findMany'> };

/**
 * How many sessions are at work on each account of each runner: the count Automatic's picks split evenly
 * (accountToStartOn, accountToMoveTo). A session is at work while it runs or waits to, while a retry is
 * armed for it, and for ACTIVE_SESSION_WINDOW_MS after its last turn; only one on the runner's own
 * sign-in to its engine spends an account. Each is on the account dispatch runs it on (runAccount), so a
 * session Orbit cannot move counts against the account it is pinned to.
 */
export async function activeSessionsOn(
  db: ActiveSessionsReader,
  runners: ReadonlyArray<AccountRunner & { id: string }>,
  now: Date,
): Promise<Map<string, ActiveSessions>> {
  const counted = new Map(runners.map((runner) => [
    runner.id,
    Object.fromEntries(ACCOUNT_ENGINES.map((engine) => [engine, {}])) as ActiveSessions,
  ]));
  // A share only ever chooses between accounts, so a runner with one has nothing to count.
  const choosing = runners.filter((runner) =>
    ACCOUNT_ENGINES.some((engine) => (accountsOn(engine as AccountEngine, runner, now)?.length ?? 0) > 1));
  if (choosing.length === 0) return counted;
  const sessions = await db.session.findMany({
    where: {
      assignedRunnerId: { in: choosing.map((runner) => runner.id) },
      deletedAt: null,
      OR: [
        { status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } },
        { retryAt: { not: null } },
        {
          status: { in: [RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED] },
          lastTurnAt: { gte: new Date(now.getTime() - ACTIVE_SESSION_WINDOW_MS) },
        },
      ],
    },
    select: {
      assignedRunnerId: true,
      provider: true,
      providerBuiltin: true,
      engine: true,
      codexAccount: true,
      claudeAccount: true,
      antigravityAccount: true,
      kimiAccount: true,
      cursorAccount: true,
      workspace: {
        select: { env: true, codexAccount: true, claudeAccount: true, antigravityAccount: true, kimiAccount: true, cursorAccount: true },
      },
    },
  });
  const byId = new Map(choosing.map((runner) => [runner.id, runner]));
  for (const session of sessions) {
    const engine = session.provider;
    const runner = session.assignedRunnerId ? byId.get(session.assignedRunnerId) : undefined;
    if (!runner || !isAccountEngine(engine) || !isBuiltinProvider(engine, session.providerBuiltin)) continue;
    if ((recordedEngine(session.engine) ?? engine) !== engine) continue;
    const column = ACCOUNT_CHOICE[engine];
    const account = runAccount(
      engine,
      session.workspace?.env,
      { [column]: session[column] ?? session.workspace?.[column] },
      runner,
      now,
    );
    const counts = counted.get(runner.id)![engine as AccountEngine]!;
    if (account) counts[account] = (counts[account] ?? 0) + 1;
  }
  return counted;
}

/** `runner` with its sessions counted (activeSessionsOn), for the picks that split them. */
export async function withActiveSessions<R extends AccountRunner>(
  db: ActiveSessionsReader,
  runnerId: string,
  runner: R,
  now: Date,
): Promise<R> {
  const counted = await activeSessionsOn(db, [{ ...runner, id: runnerId }], now);
  return { ...runner, activeSessions: counted.get(runnerId) };
}

/**
 * accountBeforeDispatch, with `runner`'s sessions counted for a move it has to make, which few turns do:
 * the session goes to an account below its share when there is one.
 */
export async function countedAccountBeforeDispatch<R extends AccountRunner>(
  db: ActiveSessionsReader,
  runnerId: string,
  engine: AccountEngine,
  session: { account?: string | null; pinned?: boolean },
  workspace: AccountWorkspace | null | undefined,
  runner: R,
  now: Date,
): Promise<AccountMove | null> {
  if (!accountBeforeDispatch(engine, session, workspace, runner, now)) return null;
  return accountBeforeDispatch(engine, session, workspace, await withActiveSessions(db, runnerId, runner, now), now);
}

/** `engines` as a client reads them: each account with its count, so that its own answer to "where does
 *  a new session start" is the server's (accountToStartOn). */
export function engineHealthWithActiveSessions(
  engines: RunnerEngineHealth[] | null,
  active: ActiveSessions | undefined,
): RunnerEngineHealth[] | null {
  if (!engines || !active) return engines;
  return engines.map((entry) => {
    if (!entry.accounts || !engineKeepsAccounts(entry.engine)) return entry;
    const counts = active[entry.engine as AccountEngine] ?? {};
    return {
      ...entry,
      accounts: entry.accounts.map((account) => ({ ...account, activeSessions: counts[account.id] ?? 0 })),
    };
  });
}

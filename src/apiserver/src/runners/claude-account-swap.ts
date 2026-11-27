/**
 * Set as default for Claude Code accounts, the apiserver's half (docs/claude-default-swap-contract.md §5).
 *
 * The owner makes an added Claude account the Default on a runner, and the runner swaps that account's login with the
 * one in ~/.claude. The relay is the account removal's: one request per runner on its row
 * (`runner.claude_account_swap_*`, migration 1000), handed over on every heartbeat while `pending`, answered by
 * POST /runner/claude-account-swap-result. While it is pending, no session on either account is handed new work —
 * its claim and its inbox hold it (claudeSwapHoldsSession, claudeSwapHolds) — and when it is done, everything Orbit
 * keys by the two account ids is swapped in one transaction (swapClaudeAccountRecords), so each record follows its
 * account into the account's new folder.
 */
import { Prisma } from '@prisma/client';
import type {
  ClaudeAccountSwapForeignProcess,
  PlanUsage,
  PlanUsageSnapshot,
  RunnerAccountRemoveSession,
  RunnerClaudeAccountSwapState,
} from '@orbit/shared';
import { DEFAULT_ACCOUNT } from '../providers/account';
import { reportedRunAccount } from '../providers/plan-usage-accounts';
import { FORMER_DEFAULT_KEY, sanitizeRunnerEngines } from '../common/runner-engines';
import { isReleased } from '../common/session-release';
import { LEGACY_STATUS_SELECT, legacySessionStatus, readLandingSettlements } from '../sessions/session-legacy-words';
import { sessionTurnStateSql, TURN_STATE_SELECT, turnStateOf } from '../sessions/session-turn-state';

/** Runner swaps an added Claude account's login with the one in ~/.claude (§5). One that does not declare it would
 *  never answer the request. */
export const CLAUDE_ACCOUNT_SWAP_V1 = 'claude-account-swap/v1';

/** What a runner too old to swap logins is refused with: words the owner can act on. */
export const CLAUDE_ACCOUNT_SWAP_TOO_OLD = 'Update the runner to set a default Claude Code account on it.';

/** Refused while a swap on the same runner is still pending: the runner may be in the middle of it. */
export const CLAUDE_ACCOUNT_SWAP_BUSY = 'A default is already being set on this runner. Wait for it to finish.';

/** The deadline's words, the removal's (§5). */
export const CLAUDE_ACCOUNT_SWAP_TIMED_OUT = 'Its sessions did not finish their turns in time — try again.';
export const CLAUDE_ACCOUNT_SWAP_NO_ANSWER = 'This runner did not answer — try again.';

/** The other account of the pair: Default for the added one, the added one for Default, null for any other. */
export function swappedAccount(account: string | null | undefined, added: string): string | null {
  if (account === DEFAULT_ACCOUNT) return added;
  if (account === added) return DEFAULT_ACCOUNT;
  return null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the owner, or the account's own record, calls an account of the pair before a swap: its alias, else the name
 *  the runner reports for its slot. Never a placeholder: Default with neither has no name, and the slot of a former
 *  Default reports the name the account now in ~/.claude was added under, which is not this account's. */
function nameOf(names: Record<string, unknown>, engines: unknown, account: string, formerDefault: boolean): string | null {
  const alias = names[account];
  if (typeof alias === 'string' && alias.trim()) return alias;
  if (formerDefault) return null;
  const reported = sanitizeRunnerEngines(engines)
    ?.find((entry) => entry.engine === 'claude')
    ?.accounts?.find((entry) => entry.id === account)?.name;
  return reported || null;
}

/**
 * `runner.account_names` with Claude's two names exchanged. Each name follows its account into the other folder, and
 * is written as an alias even where it was the reported one: the runner's own record of the added slot keeps the name
 * it was added under, which now belongs to the account in ~/.claude.
 *
 * Default's placeholder is not a name and does not move: a Default the owner never renamed lands in the added slot
 * with no name, marked as the former Default with `formerDefaultEmail` (the email the runner read there, or "" where
 * none), which the clients name it by — else "Former default". The account promoted to ~/.claude leaves its mark, if
 * it had one, behind: Default is called Default.
 */
export function swappedAccountNames(
  accountNames: unknown,
  engines: unknown,
  added: string,
  formerDefaultEmail: string | null = null,
): Prisma.InputJsonValue | null {
  const all = isObject(accountNames) ? { ...accountNames } : {};
  const claude = isObject(all.claude) ? { ...all.claude } : {};
  const kept = isObject(all[FORMER_DEFAULT_KEY]) ? { ...all[FORMER_DEFAULT_KEY] } : {};
  const former = isObject(kept.claude) ? { ...kept.claude } : {};
  const defaultName = nameOf(claude, engines, DEFAULT_ACCOUNT, false);
  const addedName = nameOf(claude, engines, added, added in former);
  delete claude[DEFAULT_ACCOUNT];
  delete claude[added];
  if (addedName) claude[DEFAULT_ACCOUNT] = addedName;
  if (defaultName) claude[added] = defaultName;
  all.claude = claude;
  delete former[DEFAULT_ACCOUNT];
  former[added] = formerDefaultEmail ?? '';
  kept.claude = former;
  all[FORMER_DEFAULT_KEY] = kept;
  return all as Prisma.InputJsonValue;
}

/** `runner.account_pauses` with Claude's two entries exchanged (a missing entry moves as a missing entry). */
export function swappedAccountPauses(accountPauses: unknown, added: string): Prisma.InputJsonValue | null {
  if (!isObject(accountPauses) || !isObject(accountPauses.claude)) return isObject(accountPauses) ? (accountPauses as Prisma.InputJsonValue) : null;
  const claude = { ...accountPauses.claude };
  const fromDefault = claude[DEFAULT_ACCOUNT];
  const fromAdded = claude[added];
  delete claude[DEFAULT_ACCOUNT];
  delete claude[added];
  if (fromAdded !== undefined) claude[DEFAULT_ACCOUNT] = fromAdded;
  if (fromDefault !== undefined) claude[added] = fromDefault;
  return { ...accountPauses, claude } as Prisma.InputJsonValue;
}

/**
 * `runner.plan_usage` with Claude's two accounts' quota exchanged: Default's is the Claude snapshot's own windows, an
 * added account's is its entry under `accounts` (plan-usage-accounts.ts). Until the runner's next report, each
 * account's quota is read where the account now is.
 */
export function swappedPlanUsage(planUsage: unknown, added: string): Prisma.InputJsonValue | null {
  if (!isObject(planUsage)) return null;
  const usage = planUsage as unknown as PlanUsage;
  const snapshot = usage.claude;
  if (!snapshot) return planUsage as Prisma.InputJsonValue;
  const { accounts: reported, ...own } = snapshot;
  const accounts: Record<string, PlanUsageSnapshot> = isObject(reported) ? { ...(reported as Record<string, PlanUsageSnapshot>) } : {};
  const ofAdded = accounts[added];
  delete accounts[added];
  if (Object.keys(own).length > 0) accounts[added] = own as PlanUsageSnapshot;
  const claude = {
    ...('provider' in own ? { provider: own.provider } : {}),
    ...(ofAdded ?? {}),
    ...(Object.keys(accounts).length > 0 ? { accounts } : {}),
  } as PlanUsageSnapshot;
  return { ...usage, claude } as unknown as Prisma.InputJsonValue;
}

/** The two accounts a pending swap holds work back on, or null when none is pending. */
type PendingSwap = { added: string };

function pendingSwapOf(row: { claudeAccountSwapStatus: string | null; claudeAccountSwapAccount: string | null } | null): PendingSwap | null {
  if (row?.claudeAccountSwapStatus !== 'pending' || !row.claudeAccountSwapAccount) return null;
  return { added: row.claudeAccountSwapAccount };
}

/** What a session's Claude account is read from: its own choice, its workspace's choice and env. */
type SwapSession = {
  provider: string;
  providerBuiltin: boolean;
  claudeAccount: string | null;
  workspace: { env: unknown; claudeAccount: string | null } | null;
};

/** The Claude account a session runs on, by the runner's report; null for one on no account of the runner (a key). */
function claudeAccountOf(session: SwapSession, engines: unknown, workspaceChoice = session.workspace?.claudeAccount ?? null): string | null {
  if (session.provider !== 'claude' || !session.providerBuiltin) return null;
  return reportedRunAccount(
    'claude',
    session.workspace?.env,
    { claudeAccount: session.claudeAccount ?? workspaceChoice },
    engines,
  ) ?? null;
}

const SWAP_SESSION_SELECT = {
  id: true,
  // The turn state's columns (sessions/session-turn-state.ts), the release column among them.
  ...TURN_STATE_SELECT,
  provider: true,
  providerBuiltin: true,
  claudeAccount: true,
  workspace: { select: { env: true, claudeAccount: true } },
} satisfies Prisma.SessionSelect;

/**
 * Whether a pending swap on the session's runner holds it back from a claim: it is on either of the swap's accounts.
 * Read off rows the caller already has (QueueService.pausedPendingSessions).
 */
export function claudeSwapHoldsSession(
  session: SwapSession,
  runner: { engines: unknown; claudeAccountSwapStatus: string | null; claudeAccountSwapAccount: string | null },
): boolean {
  const swap = pendingSwapOf(runner);
  return !!swap && swappedAccount(claudeAccountOf(session, runner.engines), swap.added) !== null;
}

/** Whether a pending swap holds this session's next turn: it is on either account of the swap. */
export async function claudeSwapHolds(prisma: Prisma.TransactionClient, runnerId: string, sessionId: string): Promise<boolean> {
  const runner = await prisma.runner.findUnique({
    where: { id: runnerId },
    select: { claudeAccountSwapStatus: true, claudeAccountSwapAccount: true, engines: true },
  });
  const swap = pendingSwapOf(runner);
  if (!swap) return false;
  const session = await prisma.session.findFirst({
    where: { id: sessionId, assignedRunnerId: runnerId },
    select: SWAP_SESSION_SELECT,
  });
  return !!session && swappedAccount(claudeAccountOf(session, runner!.engines), swap.added) !== null;
}

/** The live sessions a swap moved, for the caller to reload and hint once it commits. */
export interface ClaudeAccountSwapApplied {
  /** Live sessions on either account whose engine may still be warm: each was given a reload. */
  reload: string[];
  /** Every session on either account that is not ended, held or not: each is hinted after the commit. */
  release: string[];
}

/**
 * Apply a `done` swap: in one transaction, fenced on the swap still being the pending one (`account` + `attempt`), mark
 * it done and exchange everything Orbit keys by the two account ids — the runner's names, pauses and plan usage, its
 * workspaces' account choices, and each session's account column (its pin stays as it was). A session whose account
 * came from its workspace's choice follows that choice; one whose account was Default by nothing having chosen it is
 * given its account explicitly (unpinned), so it stays on it in the new folder. Answers null when the fence matches no
 * row: a redelivered `done`, or one about a swap the row has moved past.
 *
 * `formerDefaultEmail` is the email the runner read in the added folder after the swap (`now.accountEmail`): what the
 * former Default is called there until the owner renames it (swappedAccountNames).
 *
 * `reloadLocked` is called inside the transaction for each live session whose account column changed (the session
 * row is locked by the UPDATE that changed it), so its next turn starts in the new folder.
 */
export async function swapClaudeAccountRecords(
  tx: Prisma.TransactionClient,
  runnerId: string,
  added: string,
  attempt: Date,
  reloadLocked: (tx: Prisma.TransactionClient, sessionId: string) => Promise<void>,
  formerDefaultEmail: string | null = null,
): Promise<ClaudeAccountSwapApplied | null> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "runner"
     WHERE id = ${runnerId}::uuid
       AND "claude_account_swap_status" = 'pending'
       AND "claude_account_swap_account" = ${added}
       AND "claude_account_swap_at" = ${attempt}
     FOR UPDATE`;
  if (locked.length === 0) return null;
  const runner = await tx.runner.findUniqueOrThrow({
    where: { id: runnerId },
    select: { engines: true, accountNames: true, accountPauses: true, planUsage: true },
  });

  // Sessions whose account nothing chose, read before their workspaces' choices move: their account is the one the
  // old choices gave them.
  const unchosen = await tx.session.findMany({
    where: {
      claudeAccount: null,
      provider: 'claude',
      providerBuiltin: true,
      OR: [{ assignedRunnerId: runnerId }, { assignedRunnerId: null, workspace: { runnerId } }],
    },
    select: SWAP_SESSION_SELECT,
  });

  await tx.runner.update({
    where: { id: runnerId },
    data: {
      claudeAccountSwapStatus: 'done',
      claudeAccountSwapMessage: null,
      claudeAccountSwapWaiting: [],
      claudeAccountSwapForeign: Prisma.DbNull,
      accountNames: swappedAccountNames(runner.accountNames, runner.engines, added, formerDefaultEmail) ?? Prisma.DbNull,
      accountPauses: swappedAccountPauses(runner.accountPauses, added) ?? Prisma.DbNull,
      planUsage: swappedPlanUsage(runner.planUsage, added) ?? Prisma.DbNull,
    },
  });

  await tx.$executeRaw`
    UPDATE "workspace"
       SET "claude_account" = CASE WHEN "claude_account" = ${DEFAULT_ACCOUNT} THEN ${added} ELSE ${DEFAULT_ACCOUNT} END
     WHERE "runner_id" = ${runnerId}::uuid
       AND "claude_account" IN (${DEFAULT_ACCOUNT}, ${added})`;

  // Every session that chose one of the two, on this runner or bound for it: its choice names the account's new folder.
  const chosen = await tx.$queryRaw<Array<{ id: string; finishedAt: Date | null; queued: boolean }>>`
    UPDATE "session" s
       SET "claude_account" = CASE WHEN s."claude_account" = ${DEFAULT_ACCOUNT} THEN ${added} ELSE ${DEFAULT_ACCOUNT} END
     WHERE s."claude_account" IN (${DEFAULT_ACCOUNT}, ${added})
       AND (s."assigned_runner_id" = ${runnerId}::uuid
            OR (s."assigned_runner_id" IS NULL
                AND EXISTS (SELECT 1 FROM "workspace" w WHERE w.id = s."workspace_id" AND w."runner_id" = ${runnerId}::uuid)))
    RETURNING s.id, s.finished_at AS "finishedAt", (${sessionTurnStateSql('s')} IS NOT DISTINCT FROM 'QUEUED') AS queued`;

  // Every session on either account, whether its own column moved or its workspace's choice carries it: its account's
  // folder changed under it, so a live one is reloaded into the new one.
  // Queued: the turn state QUEUED (what PENDING said), read through sessions/session-turn-state.ts.
  const affected = new Map<string, { finishedAt: Date | null; queued: boolean }>(chosen.map((row) => [row.id, row]));
  for (const session of unchosen) {
    const target = swappedAccount(claudeAccountOf(session, runner.engines), added);
    if (!target) continue;
    affected.set(session.id, { finishedAt: session.finishedAt, queued: turnStateOf(session) === 'QUEUED' });
    const followsWorkspace = claudeAccountOf(
      session, runner.engines, swappedAccount(session.workspace?.claudeAccount, added) ?? session.workspace?.claudeAccount ?? null,
    );
    if (followsWorkspace !== target) {
      await tx.session.update({ where: { id: session.id }, data: { claudeAccount: target } });
    }
  }

  const reload: string[] = [];
  const release: string[] = [];
  for (const [id, session] of affected) {
    if (isReleased(session)) continue;
    release.push(id);
    // A queued session is started by its next claim, which reads its account then.
    if (session.queued) continue;
    await reloadLocked(tx, id);
    reload.push(id);
  }
  return { reload, release };
}

/** The session ids a pending report names, kept only when they are ids, and a bounded number of them. */
export function swapWaitingOn(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && uuid.test(id)))].slice(0, 50);
}

/** The foreign processes a pending report names, as they are kept: a pid and a short command name, at most 20. */
export function swapForeignProcesses(value: unknown): ClaudeAccountSwapForeignProcess[] {
  if (!Array.isArray(value)) return [];
  const out: ClaudeAccountSwapForeignProcess[] = [];
  for (const entry of value) {
    if (out.length === 20) break;
    if (!isObject(entry) || !Number.isInteger(entry.pid) || (entry.pid as number) <= 0) continue;
    const command = typeof entry.command === 'string' ? entry.command.replace(/\p{Cc}/gu, '').slice(0, 80) : '';
    out.push({ pid: entry.pid as number, command });
  }
  return out;
}

/** The state served on the runner, for the page that asked. */
export function claudeAccountSwapStateOf(
  r: {
    claudeAccountSwapAccount?: string | null;
    claudeAccountSwapStatus?: string | null;
    claudeAccountSwapMessage?: string | null;
    claudeAccountSwapForeign?: unknown;
  },
  waitingOn: RunnerAccountRemoveSession[] = [],
): RunnerClaudeAccountSwapState {
  const status = (r.claudeAccountSwapStatus as RunnerClaudeAccountSwapState['status']) ?? null;
  return {
    account: status ? (r.claudeAccountSwapAccount ?? null) : null,
    status,
    message: status === 'failed' ? (r.claudeAccountSwapMessage ?? null) : null,
    waitingOn: status === 'pending' ? waitingOn : [],
    foreignProcesses: status === 'pending' ? swapForeignProcesses(r.claudeAccountSwapForeign) : [],
  };
}

/** The sessions each runner's pending swap waits on, by title, as far as the viewer can see them. */
export async function claudeAccountSwapWaitingOf(
  prisma: Prisma.TransactionClient,
  ownerId: string | undefined,
  runners: Array<{ id: string; claudeAccountSwapStatus?: string | null; claudeAccountSwapWaiting?: string[] | null }>,
): Promise<Map<string, RunnerAccountRemoveSession[]>> {
  const out = new Map<string, RunnerAccountRemoveSession[]>();
  const named = runners.filter((r) => r.claudeAccountSwapStatus === 'pending' && (r.claudeAccountSwapWaiting?.length ?? 0) > 0);
  if (named.length === 0) return out;
  const rows = await prisma.session.findMany({
    where: {
      ...(ownerId ? { ownerId } : {}),
      OR: named.map((r) => ({ assignedRunnerId: r.id, id: { in: r.claudeAccountSwapWaiting ?? [] } })),
    },
    // What the word each one reads on the wire is derived from (sessions/session-legacy-words.ts).
    select: { id: true, title: true, ...LEGACY_STATUS_SELECT, assignedRunnerId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const landings = await readLandingSettlements(prisma, rows);
  for (const row of rows) {
    if (!row.assignedRunnerId) continue;
    const list = out.get(row.assignedRunnerId) ?? [];
    list.push({ id: row.id, title: row.title, status: legacySessionStatus(row, landings.get(row.id)) });
    out.set(row.assignedRunnerId, list);
  }
  return out;
}

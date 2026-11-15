/**
 * Who hears about a run, and what waits on the owner (docs/scheduled-tasks-design.md §6.4, §7.3).
 *
 *   | Run ends                         | Notified | Where                                  |
 *   | NO_CHANGE                        | no       |                                        |
 *   | CHANGED, new key                 | once     | push, opens the run's session          |
 *   | CHANGED, known key               | no       | lastSeenRunId moves and links merge    |
 *   | FAILED                           | yes      | push and Waiting on you                |
 *   | HELD, AWAITING_APPROVAL          | yes      | push and Waiting on you                |
 *   | the run ended its own schedule   | once     | push, opens the schedule               |
 *   | a ONCE slot MISSED (§5.2)        | once     | push, opens the schedule               |
 *
 * WAITING ON YOU is the owner-request channel (owner-requests/): four kinds no session can file, written here in the
 * transaction that decides them, each keyed so a replay writes one row (`clientRequestId` under its asking session):
 *
 *   SCHEDULE_FAILED    one per schedule, the latest failure; closed when a later run succeeds or the schedule ends.
 *   SCHEDULE_HELD      the hold; closed when the schedule is resumed or ends.
 *   SCHEDULE_APPROVAL  one per card a run stopped at; closed when the card is answered or the run ends.
 *   SCHEDULE_WIDEN     a run's request for a wider envelope; closed when it is allowed, declined or superseded.
 *
 * Closing is WITHDRAWN ("no longer needed", with the reason) when the matter settled by itself, and DONE when the owner
 * answered what the item pointed at. Neither delivers a turn to the asking session: a run's session is not waiting on
 * these (owner-requests.service.ts leaves the SCHEDULE_* kinds out of its resolution deliveries).
 *
 * Pushes are sent after the transaction commits, through the ScheduleNotifier port, so a spec reads what was sent and
 * production sends it through PushService.
 */
import type { Prisma } from '@prisma/client';

export const SCHEDULE_ITEM_KINDS = ['SCHEDULE_FAILED', 'SCHEDULE_HELD', 'SCHEDULE_APPROVAL', 'SCHEDULE_WIDEN'] as const;
export type ScheduleItemKind = (typeof SCHEDULE_ITEM_KINDS)[number];

export function isScheduleItemKind(kind: string): kind is ScheduleItemKind {
  return (SCHEDULE_ITEM_KINDS as readonly string[]).includes(kind);
}

export type ScheduleAlertKind =
  | 'FINDING'
  | 'FAILED'
  | 'HELD'
  | 'AWAITING_APPROVAL'
  | 'WIDEN'
  | 'GOAL_REACHED'
  | 'ONCE_MISSED';

/** One push. `opens` is where a tap goes: the run's session, or the schedule. */
export interface ScheduleAlert {
  kind: ScheduleAlertKind;
  ownerId: string;
  scheduleId: string;
  runId: string | null;
  opens: { sessionId: string } | { scheduleId: string };
  /** The Waiting on you item this push announces, for the kinds that file one. */
  ownerRequestId: string | null;
  title: string;
  body: string;
  /** A replay of the same alert replaces the banner rather than stacking a second one. */
  collapseId: string;
}

export interface ScheduleNotifier {
  notify(alert: ScheduleAlert): Promise<void>;
}

export const SCHEDULE_NOTIFIER = Symbol('SCHEDULE_NOTIFIER');

/** Send each alert, never throwing: the rows are the fact, the banner only a reader of them. */
export async function sendAlerts(
  notifier: ScheduleNotifier | undefined,
  alerts: readonly ScheduleAlert[],
  warn: (message: string) => void,
): Promise<void> {
  if (!notifier) return;
  for (const alert of alerts) {
    try {
      await notifier.notify(alert);
    } catch (error) {
      warn(`schedule alert ${alert.kind} for ${alert.scheduleId} was not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------------------------

const BODY_MAX = 180;

function line(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** What a failure reason means, in a clause. */
export function failureClause(reason: string, ctx: { summary?: string | null; runLimitMinutes?: number }): string {
  switch (reason) {
    case 'REPORTED_FAILED':
      return ctx.summary ? `it reported a failure: ${line(ctx.summary, 120)}` : 'it reported a failure';
    case 'NO_REPORT':
      return 'it ended without reporting';
    case 'ENGINE_CRASHED':
      return 'its engine stopped';
    case 'APPROVAL_TIMEOUT':
      return 'an approval waited 2 hours with no answer';
    case 'RUN_LIMIT':
      return `it ran past its ${ctx.runLimitMinutes ?? 30}-minute limit`;
    default:
      return `it failed (${reason})`;
  }
}

/** Why a schedule is held, in a clause (§6.1's reasons). */
export function heldClause(reason: string): string {
  switch (reason) {
    case 'WORKSPACE_NOT_OWNED':
      return 'its workspace is no longer yours';
    case 'WORKSPACE_DELETED':
      return 'its workspace was deleted';
    case 'WORKSPACE_DISABLED':
      return 'its workspace is disabled';
    case 'AGENT_MISSING':
      return 'its agent no longer exists';
    case 'AGENT_DISABLED':
      return 'its agent is disabled';
    case 'OUTSIDE_ENVELOPE':
      return 'it no longer fits what you allowed';
    case 'ACCESS_NOT_ENFORCEABLE':
      return 'the engine it would run on cannot enforce its access level';
    case 'MODE_WIDER_THAN_ACCOUNT_DEFAULT':
      return "its access is wider than your account's default mode";
    case 'NO_REPOSITORY':
      return 'its workspace has no repository to open a PR in';
    case 'SESSION_REFUSED':
      return "its run's session could not be opened";
    default:
      return `a start check failed (${reason})`;
  }
}

export function failedCopy(title: string, consecutive: number, clause: string): { title: string; body: string } {
  const body = consecutive >= 3
    ? `It failed ${consecutive} runs in a row; the last time ${clause}.`
    : `The last run failed: ${clause}.`;
  return { title: line(`${title} failed`, 120), body: line(body) };
}

export function heldCopy(title: string, reason: string): { title: string; body: string } {
  return {
    title: line(`${title} is on hold`, 120),
    body: line(`It won't run until you resume it: ${heldClause(reason)}.`),
  };
}

/** The approval item's text says what Always allow writes and what it means for later runs (§6.4). */
export function approvalCopy(title: string, toolName: string): { title: string; body: string; why: string } {
  return {
    title: line(`${title} needs your approval`, 120),
    body: line(`A run is waiting to use ${toolName}.`),
    why:
      `A run of "${title}" is waiting for your approval to use ${toolName}. `
      + 'Always allow writes a rule for this workspace (a workspace permission rule), so later runs won\'t ask for this. '
      + 'With no answer in 2 hours the run fails.',
  };
}

export function widenCopy(title: string, widens: readonly string[]): { title: string; body: string } {
  const parts = widens.map((w) => WIDEN_WORDS[w] ?? w.toLowerCase()).join(', ');
  return {
    title: line(`${title} asks to do more`, 120),
    body: line(`A run asked to change ${parts || 'what it may do'}. Nothing changes unless you allow it.`),
  };
}

const WIDEN_WORDS: Readonly<Record<string, string>> = {
  WORKSPACE: 'where it runs',
  ACCESS_LEVEL: 'what it may do',
  RUNS_PER_WEEK: 'how often it runs',
  RUN_LIMIT: 'how long a run may take',
};

export function findingCopy(title: string, summary: string): { title: string; body: string } {
  return { title: line(title, 120), body: line(summary) };
}

export function goalReachedCopy(title: string): { title: string; body: string } {
  return {
    title: line(`${title} ended itself`, 120),
    body: 'A run found nothing left to watch and ended this scheduled task. Undo resumes it.',
  };
}

export function onceMissedCopy(title: string): { title: string; body: string } {
  return {
    title: line(`${title} did not run`, 120),
    body: 'Its one run was missed, and nothing else will run.',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Filing and closing, inside the caller's transaction
// ---------------------------------------------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

export interface ScheduleItemFiling {
  kind: ScheduleItemKind;
  ownerId: string;
  /** Who the item is shown beside: the run's session, or the conversation the schedule came from. */
  askedBySessionId: string;
  scheduleId: string;
  scheduleRunId?: string | null;
  approvalId?: string | null;
  scheduleChangeRequestId?: string | null;
  workspaceId?: string | null;
  /** One row per key under its asking session, whatever the replays. */
  key: string;
  title: string;
  why: string;
}

/** File an item; null when its key was already filed (a replay), so the owner is told once. */
export async function fileScheduleItem(tx: Tx, filing: ScheduleItemFiling): Promise<string | null> {
  const [row] = await tx.ownerRequest.createManyAndReturn({
    data: [{
      ownerId: filing.ownerId,
      askedBySessionId: filing.askedBySessionId,
      kind: filing.kind,
      state: 'PENDING',
      title: filing.title,
      why: filing.why,
      scheduleId: filing.scheduleId,
      scheduleRunId: filing.scheduleRunId ?? null,
      approvalId: filing.approvalId ?? null,
      scheduleChangeRequestId: filing.scheduleChangeRequestId ?? null,
      workspaceId: filing.workspaceId ?? null,
      clientRequestId: filing.key,
    }],
    skipDuplicates: true,
    select: { id: true },
  });
  return row?.id ?? null;
}

export interface ScheduleItemMatch {
  scheduleId: string;
  kinds: readonly ScheduleItemKind[];
  scheduleRunId?: string;
  approvalIds?: readonly string[];
  /** Approval items whose card is NOT one of these. */
  approvalIdsNotIn?: readonly string[];
  scheduleChangeRequestId?: string;
}

/** Close the PENDING items that match: WITHDRAWN with why, or DONE when the owner answered what they pointed at. */
export async function closeScheduleItems(
  tx: Tx,
  match: ScheduleItemMatch,
  how: { state: 'WITHDRAWN' | 'DONE'; note: string; byUserId?: string | null; now: Date },
): Promise<number> {
  const closed = await tx.ownerRequest.updateMany({
    where: {
      scheduleId: match.scheduleId,
      state: 'PENDING',
      kind: { in: [...match.kinds] },
      ...(match.scheduleRunId ? { scheduleRunId: match.scheduleRunId } : {}),
      ...(match.approvalIds ? { approvalId: { in: [...match.approvalIds] } } : {}),
      ...(match.approvalIdsNotIn ? { approvalId: { notIn: [...match.approvalIdsNotIn] } } : {}),
      ...(match.scheduleChangeRequestId ? { scheduleChangeRequestId: match.scheduleChangeRequestId } : {}),
    },
    data: {
      state: how.state,
      resolvedAt: how.now,
      resolutionNote: how.note,
      ...(how.byUserId ? { resolvedByUserId: how.byUserId } : {}),
    },
  });
  return closed.count;
}

/**
 * The session a schedule's item is shown beside when no run's session is: the conversation it came from, else the
 * latest run's. Null only for a schedule no session ever touched; its items are then pushed and not filed.
 */
export async function scheduleHomeSession(
  tx: Tx,
  schedule: { id: string; createdFromSessionId: string | null },
): Promise<string | null> {
  if (schedule.createdFromSessionId) return schedule.createdFromSessionId;
  const last = await tx.scheduleRun.findFirst({
    where: { scheduleId: schedule.id, sessionId: { not: null } },
    orderBy: { plannedAt: 'desc' },
    select: { sessionId: true },
  });
  return last?.sessionId ?? null;
}

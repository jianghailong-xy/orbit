/**
 * Who hears about a run, and what waits on the owner (docs/scheduled-tasks-design.md §6.4, §7.3).
 *
 *   | Run ends                         | Notified | Where                                  |
 *   | NO_CHANGE                        | no       |                                        |
 *   | CHANGED, new key                 | once     | push, opens the run's session          |
 *   | CHANGED, known key               | no       | lastSeenRunId moves and links merge    |
 *   | FAILED                           | yes      | push and Waiting on you                |
 *   | inferred failure, reported late  | once     | push replacing the failure's banner    |
 *   | HELD, AWAITING_APPROVAL          | yes      | push and Waiting on you                |
 *   | the run ended its own schedule   | once     | push, opens the schedule               |
 *   | a ONCE slot MISSED (§5.2)        | once     | push, opens the schedule               |
 *   | a slot MISSED over budget (§4)   | once     | push, opens the schedule; once a row   |
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
import {
  SCHEDULE_COPY,
  bashCommandRules,
  scheduleApprovalWaiting,
  scheduleEnvelopeTitle,
  scheduleFailedPush,
  scheduleFailedWaiting,
  scheduleGoalReachedPushTitle,
  scheduleReportedLatePushTitle,
  scheduleHeldClause,
  scheduleHeldWaiting,
  scheduleStoppedAsPlannedText,
  scheduleWidenWaitingText,
  type ScheduleEnvelope,
  type ScheduleEnvelopePart,
  type ScheduleRule,
} from '@orbit/shared';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

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
  | 'REPORTED_LATE'
  | 'ONCE_MISSED'
  | 'OVER_BUDGET'
  | 'PLANNED_END';

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

/** A banner's body; an item's text is longer and only made one line (WHY_MAX). */
const BODY_MAX = 180;
const WHY_MAX = 1_000;

function line(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** A run's reasonText (§4): the shared sentence for a slot over budget; null otherwise, so a client words the rest. */
export function runReasonText(run: { failureReason: string | null }): string | null {
  // No count: the envelope may have changed since, and the row should stay true.
  return run.failureReason === 'OVER_BUDGET' ? SCHEDULE_COPY.runReasonTexts.OVER_BUDGET : null;
}

/** The push for a slot over budget, told once (§4, §7.3). */
export function overBudgetCopy(title: string, runsPerWeek: number): { title: string; body: string } {
  const runs = `${runsPerWeek} run${runsPerWeek === 1 ? '' : 's'}`;
  return {
    title: line(`${title} skipped a run`, 120),
    body: line(
      `A run was not started: it had already started ${runs} in the past 7 days, as many as you allowed. `
      + 'Its slots run again as older runs leave the 7 days; Run now still starts one.',
    ),
  };
}

/**
 * Why a schedule is held, in a clause (§6.1's reasons), for a refusal's message: the boards' clause with "its agent",
 * "its workspace" for the names a refusal does not carry.
 */
export function heldClause(reason: string): string {
  return scheduleHeldClause(reason)?.clause ?? `a start check failed (${reason})`;
}

export interface ScheduleCopy {
  title: string;
  /** The push's body. */
  body: string;
  /** The Waiting on you item's text. */
  why: string;
}

/**
 * A failure: the item is the board's card ("The last run ended without a report (Nov 14, 02:00). It keeps running on
 * schedule until you pause it. …"), the push its shorter banner. Times are in the schedule's zone.
 */
export function failedCopy(input: {
  title: string;
  consecutiveFailures: number;
  failureReason: string;
  /** What the run reported; a REPORTED_FAILED item and push say it. */
  summary?: string | null;
  plannedAt: Date;
  timezone: string;
}): ScheduleCopy {
  const waiting = {
    title: input.title,
    consecutiveFailures: input.consecutiveFailures,
    run: {
      failureReason: input.failureReason,
      reasonText: null,
      summary: input.summary ?? null,
      plannedAt: input.plannedAt.toISOString(),
    },
    timezone: input.timezone,
  };
  const push = scheduleFailedPush(waiting);
  return {
    title: line(push.title, 120),
    body: line(push.body),
    why: line(scheduleFailedWaiting(waiting).body, WHY_MAX),
  };
}

/** A hold: "Weekly dependency audit is held", naming the agent or the workspace that holds it. */
export function heldCopy(input: {
  title: string;
  reason: string;
  plannedAt: Date;
  agentName: string | null;
  workspaceName: string | null;
  now: Date;
  timezone: string;
}): ScheduleCopy {
  const text = scheduleHeldWaiting({
    title: input.title,
    heldReason: input.reason,
    plannedAt: input.plannedAt.toISOString(),
    agentName: input.agentName,
    workspaceName: input.workspaceName,
    now: input.now,
    timezone: input.timezone,
  });
  return { title: line(text.title, 120), body: line(text.body), why: line(text.body, WHY_MAX) };
}

/** What Always allow would write for a card, as the card's rule names it ("psql:*", "WebFetch"); '' for none. */
export function approvalPattern(toolName: string, input: unknown, checkOnly = false): string {
  if (toolName === 'AskUserQuestion') return '';
  if (toolName !== 'Bash') return toolName;
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined;
  const exact = checkOnly || (input as { orbitScheduleCheckOnly?: boolean } | null)?.orbitScheduleCheckOnly === true;
  return typeof command === 'string' ? exact ? command : bashCommandRules(command).map((r) => r.ruleContent || r.toolName).join(', ') : '';
}

/**
 * A run's card (§6.4): "Nightly pg spec sweep wants to run a command" / "If nobody answers by 04:00 this run fails; the
 * next one starts tomorrow." The item adds what Always allow covers and what that means for later runs.
 */
export function approvalCopy(input: {
  title: string;
  deadline: Date;
  nextAt: Date | null;
  pattern: string;
  workspaceName: string;
  now: Date;
  timezone: string;
}): ScheduleCopy {
  const text = scheduleApprovalWaiting({
    ...input,
    deadline: input.deadline.toISOString(),
    nextAt: input.nextAt?.toISOString() ?? null,
  });
  const why = input.pattern && input.workspaceName ? `${text.body} ${text.alwaysAllow}` : text.body;
  return { title: line(text.title, 120), body: line(text.body), why: line(why, WHY_MAX) };
}

/** A run's widen: "Let Codex stable check open PRs?" with its Now and Asked. */
export function widenCopy(input: {
  title: string;
  reason: string | null;
  widens: readonly ScheduleEnvelopePart[];
  now: ScheduleEnvelope;
  asked: ScheduleEnvelope;
  ruleNow: ScheduleRule | null;
  ruleAsked: ScheduleRule | null;
  workspaceNames: Record<string, string>;
}): ScheduleCopy {
  const text = scheduleWidenWaitingText({ ...input, reason: input.reason ?? '' });
  const title = scheduleEnvelopeTitle(input.title, input.widens, input.workspaceNames[input.asked.workspaceId], input.asked.accessLevel);
  return { title: line(title, 120), body: line(text), why: line(text, WHY_MAX) };
}

/**
 * The collapse id of a finding's push. The key is free text up to 200 characters, so it is digested with the
 * schedule's id: the same key on the same schedule still collapses to one banner, and the id stays at 49 bytes,
 * inside APNs's 64.
 */
export function findingCollapseId(scheduleId: string, key: string): string {
  return `schedule-finding-${createHash('sha256').update(JSON.stringify([scheduleId, key])).digest('hex').slice(0, 32)}`;
}

export function findingCopy(title: string, summary: string): { title: string; body: string } {
  return { title: line(title, 120), body: line(summary) };
}

export function goalReachedCopy(title: string): { title: string; body: string } {
  return {
    title: line(scheduleGoalReachedPushTitle(title), 120),
    body: 'A run found nothing left to watch and ended this scheduled task. Undo resumes it.',
  };
}

/**
 * A run failed NO_REPORT or ENGINE_CRASHED that reported after the owner stepped in (§7.1): what it reported, over the
 * failure's banner.
 */
export function reportedLateCopy(title: string, summary: string): { title: string; body: string } {
  return { title: line(scheduleReportedLatePushTitle(title), 120), body: line(summary) };
}

/** §8.5: the one push for a planned end reached, "Stopped as planned after 12 runs". */
export function plannedEndCopy(title: string, runs: number): { title: string; body: string } {
  return { title: line(title, 120), body: scheduleStoppedAsPlannedText(runs) };
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

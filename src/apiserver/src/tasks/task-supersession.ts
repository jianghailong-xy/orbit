/**
 * Task supersession (contract §13.6 SU1–SU5): everything about "this attempt was replaced by that
 * one" that is a pure function of stated facts.
 *
 * Kept out of the service for the reason `project-acceptance.ts` is: the rules here are read by the
 * service, by the runner API, by the CLI's own validation and by tests, and a rule that needs Nest
 * and Prisma standing up in order to be checked is a rule each caller reimplements.
 *
 * What the database enforces and this file does NOT duplicate: the acyclicity walk and the tenant
 * check, which are migration 0128's trigger. What this file exists for is the other half — turning
 * a refusal into a sentence the caller can act on, and deciding what a terminal reason means when
 * the successor it named has since been deleted.
 */

/**
 * §13.6 SU1's closed set, the same two values migration 0128's CHECK freezes.
 *
 * Two, not four. `FAILED` and `CANCELLED` are already `TaskStatus`, and a column that restates its
 * neighbour is a column that can disagree with it. This one answers only the question the status
 * cannot: a CANCELLED task that was replaced and a CANCELLED task that was dropped are the same
 * status and opposite facts.
 */
export const TASK_TERMINAL_REASONS = ['SUPERSEDED', 'ABANDONED'] as const;

export type TaskTerminalReason = (typeof TASK_TERMINAL_REASONS)[number];

/** The statuses SU4 allows a successor to be named from. Linking writes nothing to `status`: the
 *  original outcome is the fact being preserved, not the one being tidied away. */
export const TASK_SUPERSEDABLE_STATUSES: ReadonlySet<string> = new Set(['CANCELLED', 'FAILED']);

/** How far a successor chain is followed before the reader gives up. The database refuses to build
 *  one longer than 256 hops, so a walk that reaches this has found data no writer here produced. */
export const TASK_SUPERSESSION_MAX_HOPS = 256;

export interface TaskSupersessionFacts {
  status: string;
  supersededByTaskId: string | null;
  supersededAt: Date | null;
  terminalReason: string | null;
}

/**
 * Why there is no successor id, when the row nonetheless says it was superseded.
 *
 * `SUCCESSOR_DELETED` is a real state and not a bug: 0128's FK is ON DELETE SET NULL, so deleting
 * the successor takes the pointer and leaves the reason. Reporting that as "never superseded" would
 * be the one wrong answer — it is the difference between "nothing replaced this" and "something
 * did, and the record of what has been deleted".
 */
export function supersededByAbsentReason(
  facts: Pick<TaskSupersessionFacts, 'supersededByTaskId' | 'terminalReason'>,
): 'NOT_SUPERSEDED' | 'SUCCESSOR_DELETED' | null {
  if (facts.supersededByTaskId != null) return null;
  return facts.terminalReason === 'SUPERSEDED' ? 'SUCCESSOR_DELETED' : 'NOT_SUPERSEDED';
}

/**
 * The one word a client shows for how this task ended.
 *
 * Deliberately derived rather than stored: `status` and `terminalReason` are each authoritative
 * about their own question, and a third column holding their combination is a third thing that can
 * be wrong. Every client — web, iOS, the CLI — asks this same function shape, so "failed",
 * "cancelled" and "superseded" cannot come out meaning different things in different places.
 */
export type TaskOutcome =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
  | 'SUPERSEDED'
  | 'ABANDONED';

export function taskOutcome(facts: Pick<TaskSupersessionFacts, 'status' | 'terminalReason'>): TaskOutcome {
  if (facts.terminalReason === 'SUPERSEDED') return 'SUPERSEDED';
  if (facts.terminalReason === 'ABANDONED') return 'ABANDONED';
  switch (facts.status) {
    case 'OPEN':
    case 'IN_PROGRESS':
    case 'DONE':
    case 'FAILED':
    case 'CANCELLED':
      return facts.status;
    default:
      // An unrecognised status must read as itself, never as a healthy default.
      return facts.status as TaskOutcome;
  }
}

export interface SupersessionLinkInput {
  taskId: string;
  /** The task's status AFTER this write — one call may cancel and supersede at once, and judging
   *  SU4 against the status the row had before it would refuse the second half of a write whose
   *  first half made it legal. */
  status: string;
  successor: { id: string; ownerId: string; projectId: string | null } | null;
  ownerId: string;
  projectId: string | null;
}

/**
 * SU2–SU4 as sentences. The database checks all of these again and would refuse anyway; this exists
 * so the caller is told which rule it broke instead of receiving a constraint name.
 *
 * Returns null when the link is allowed.
 */
export function supersessionRefusal(input: SupersessionLinkInput): string | null {
  const { successor } = input;
  if (successor === null) return null;
  if (successor.id === input.taskId) {
    return 'A task cannot supersede itself';
  }
  if (!TASK_SUPERSEDABLE_STATUSES.has(input.status)) {
    return (
      `Only a CANCELLED or FAILED task can name a successor — this one is ${input.status}. ` +
      'Supersession records that an attempt was replaced; it never rewrites how the attempt ended'
    );
  }
  if (successor.ownerId !== input.ownerId) {
    return 'The successor task belongs to a different owner';
  }
  if ((successor.projectId ?? null) !== (input.projectId ?? null)) {
    return (
      'The successor must be in the same project as the task it replaces — work towards a ' +
      'different goal is not a later attempt at this one'
    );
  }
  return null;
}

/**
 * Follow `supersededByTaskId` forward until it runs out: the attempt that is actually live.
 *
 * `edges` maps a task to its successor. The walk stops on a cycle rather than looping — 0128's
 * trigger makes one unwritable, and a reader that hangs on data it was told is impossible is worse
 * than one that reports what it found.
 */
export function successorChain(
  from: string,
  edges: ReadonlyMap<string, string | null>,
): { chain: string[]; truncated: boolean } {
  const chain: string[] = [];
  const seen = new Set<string>([from]);
  let cursor = edges.get(from) ?? null;
  while (cursor != null) {
    if (seen.has(cursor) || chain.length >= TASK_SUPERSESSION_MAX_HOPS) {
      return { chain, truncated: true };
    }
    seen.add(cursor);
    chain.push(cursor);
    cursor = edges.get(cursor) ?? null;
  }
  return { chain, truncated: false };
}

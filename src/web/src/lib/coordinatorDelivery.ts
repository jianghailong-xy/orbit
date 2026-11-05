import {
  COORDINATOR_DELIVERY_KINDS,
  type CoordinatorDeliveryCard,
  type CoordinatorDeliveryKind,
} from '@orbit/shared';

/**
 * A turn Orbit wrote to tell a session about a committed fact, as the control plane recorded it beside
 * the turn's echo (`coordinatorDelivery`, apiserver projects/coordinator-delivery-card.ts) — the reading
 * `CoordinatorDeliveryLine` is drawn from: a fact a project's coordinator is told, or the answer to a
 * session's criteria proposal.
 *
 * The turn's words are written for the AGENT — `From Orbit · project “…” has a revision of completion
 * evidence for you to decide`, then paragraphs of protocol. Until this card existed they were the only
 * thing recorded for the turn, so it was drawn as a bubble the owner had typed.
 *
 * The sentence the line says is written here, from the card's fields, and nowhere else on the web
 * (design: docs/mocks/coordinator-delivery-line/, approved 2026-10-31). The native clients write the same words
 * (OrbitKit `CoordinatorDelivery`, Android `CoordinatorDeliveryLine`), and their parity tests hold
 * every entry below to theirs.
 */

/**
 * What each line says, by kind. `{task}` is the title of the task the fact names, `{revision}` the
 * evidence revision, and `{count}` what the fact counts, said as `COORDINATOR_DELIVERY_COUNTS` says it.
 * A kind needs exactly the fields its sentence names: a card without one is no card.
 */
export const COORDINATOR_DELIVERY_SENTENCES: Readonly<Record<CoordinatorDeliveryKind, string>> = {
  EVIDENCE_SUBMITTED: 'Evidence revision {revision} submitted: {task}',
  EVIDENCE_MOVED_IN: 'Evidence revision {revision} moved in: {task}',
  DEPENDENT_READY: 'Can start now: {task}',
  TASK_DISPATCH_REFUSED: 'Could not start: {task}',
  PROJECT_BLOCKER_RAISED: 'Blocker raised: {task}',
  TASK_RUN_STOPPED: 'Run stopped: {task}',
  CRITERION_UNLANDED: 'Work not on main yet: {count}',
  ACCEPTANCE_LANDED: '{count} landed',
  ACCEPTANCE_LANDED_HELD: '{count} landed, Done held back',
  ACCEPTANCE_LANDED_DONE: '{count} landed, recorded Done',
  LOOKS_FINISHED: 'Looks finished, not recorded Done',
  SETTLED_UNMERGED: 'Settled with work not on main: {count}',
  CRITERIA_APPROVED: 'Criteria proposal approved',
  CRITERIA_REJECTED: 'Criteria proposal rejected',
};

/** How `{count}` is said, by what is counted: `one` when there is one, `many` (with `{n}`) otherwise. */
const TASKS = { one: '1 task', many: '{n} tasks' } as const;
const CRITERIA = { one: 'The only criterion', many: 'All {n} criteria' } as const;
const COMMITS = { one: '1 commit', many: '{n} commits' } as const;
export const COORDINATOR_DELIVERY_COUNTS: Readonly<Partial<Record<CoordinatorDeliveryKind, { one: string; many: string }>>> = {
  CRITERION_UNLANDED: TASKS,
  ACCEPTANCE_LANDED: CRITERIA,
  ACCEPTANCE_LANDED_HELD: CRITERIA,
  ACCEPTANCE_LANDED_DONE: CRITERIA,
  SETTLED_UNMERGED: COMMITS,
};

/** What the sticky bar calls the turn once it has been scrolled past: the reply under it answers it. */
export const COORDINATOR_DELIVERY_STICKY_LABEL = 'From Orbit';

/** The link at the foot of the opened line, to the task the fact names. */
export const COORDINATOR_DELIVERY_ITS_TASK = 'Its task ↗';

/**
 * Where the line says it was sent, and the heading the words open under, when this conversation is not
 * the project's coordinator (`toCoordinator: false`): the owner's answer to a criteria proposal a task's
 * run filed. Every other card says `Sent to the coordinator` and opens to `What the coordinator was told`.
 */
export const COORDINATOR_DELIVERY_SENT_TO_SESSION = 'Sent to this session';
export const COORDINATOR_DELIVERY_SESSION_TOLD = 'What this session was told';

/** The sentence the line says, before `Sent to the coordinator · 07:30 PM`. */
export function coordinatorDeliverySentence(card: CoordinatorDeliveryCard): string {
  const counts = COORDINATOR_DELIVERY_COUNTS[card.kind];
  const count = counts && card.count !== null
    ? (card.count === 1 ? counts.one : counts.many).replace('{n}', String(card.count))
    : '';
  // Replaced by a function, and the title last: a title is the owner's words, and `$&` or `{count}`
  // in one is text, never a pattern.
  return COORDINATOR_DELIVERY_SENTENCES[card.kind]
    .replace('{revision}', () => String(card.revision ?? ''))
    .replace('{count}', () => count)
    .replace('{task}', () => card.task?.title ?? '');
}

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Read the way `parseOwnerAnswer` reads its card: the shape is checked, and a payload that is not a
 * card parses as NOTHING rather than as half a card, which leaves the turn drawn exactly as it was
 * before this existed. Nothing is derived from the words.
 *
 * Only the server's own `false` says this conversation is not the coordinator: a card stored before
 * `toCoordinator` existed was drawn as the coordinator's, and reads as it was.
 */
export function parseCoordinatorDelivery(payload: unknown): CoordinatorDeliveryCard | null {
  const raw = (payload as { coordinatorDelivery?: unknown } | null)?.coordinatorDelivery;
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  const kind = card.kind as CoordinatorDeliveryKind;
  if (!(COORDINATOR_DELIVERY_KINDS as readonly unknown[]).includes(kind)) return null;
  if (typeof card.deliveredAt !== 'string' || Number.isNaN(Date.parse(card.deliveredAt))) return null;
  const sentence = COORDINATOR_DELIVERY_SENTENCES[kind];
  const task = card.task as Record<string, unknown> | null | undefined;
  const named = task && typeof task === 'object'
    && typeof task.id === 'string' && task.id !== ''
    && typeof task.title === 'string' && task.title.trim() !== ''
    ? { id: task.id, title: task.title }
    : null;
  // Each field the sentence names is required, and one it does not name is left out.
  if (sentence.includes('{task}') && !named) return null;
  if (sentence.includes('{revision}') && !positive(card.revision)) return null;
  if (sentence.includes('{count}') && !positive(card.count)) return null;
  return {
    kind,
    task: sentence.includes('{task}') ? named : null,
    revision: sentence.includes('{revision}') ? card.revision as number : null,
    count: sentence.includes('{count}') ? card.count as number : null,
    deliveredAt: card.deliveredAt,
    toCoordinator: card.toCoordinator !== false,
  };
}

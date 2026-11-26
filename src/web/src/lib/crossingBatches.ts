import type { ProjectCrossingRow } from './attribution';
import {
  MOVE_TASK_APPROVE_CONSEQUENCE,
  MOVE_TASK_CRITERION_GONE,
  MOVE_TASK_OUT_APPROVE_CONSEQUENCE,
  MOVE_TASK_REQUESTED_CRITERION_LABEL,
  MOVE_TASK_WITHDRAWN_CRITERION_LABEL,
} from '../components/ProjectCrossingsCard';

/**
 * CROSS-PROJECT REQUESTS AS ONE DECISION CARD PER BATCH
 * =====================================================
 * An agent that asks to move eight tasks into a project files eight crossings, and the owner used
 * to be sent to the project page to find eight raw ids. The coordinator conversation of the target
 * project draws them instead as ONE card in the criteria decision card's shape (owner-approved board
 * docs/mocks/handoff-in-chat, 2026-11-11): one batch is the crossings of one source project, one
 * kind, asked while an earlier one of them was still waiting — and one Approve answers all of them,
 * each through the existing decision door with its own crossing key.
 *
 * The rule is the same on every client (OrbitKit `CrossingBatches`, Android `CrossingBatches`), so a
 * phone and a browser draw the same cards from the same read.
 */

export type CrossingKind = 'MOVE_TASK' | 'FILE_TASK' | 'DEPEND_ON_TASK';

export interface CrossingBatch {
  /** `crossing-batch-<first row's id>`: the card's DOM id and its key everywhere. */
  id: string;
  kind: string;
  fromProjectId: string;
  /** The source project by name, never by id. */
  sourceTitle: string;
  /** A request to take tasks out of every project (`toProjectId` null), drawn in the SOURCE
   *  project's coordinator conversation because it has no target to be drawn in. */
  out: boolean;
  /** Oldest first. */
  rows: ProjectCrossingRow[];
  /** The first row's requestedAt: where the card is drawn in the conversation. */
  moment: string;
  /** The target project by name, in a conversation that does not coordinate it (the session that
   *  asked for the moves); absent where the target is this conversation's own project. */
  targetTitle?: string | null;
}

/**
 * The task moves one session draws as one card, as `GET /sessions/:id/task-moves` serves them: one
 * asker, one source project, one target project. While waiting it is every PENDING move of the
 * three; once answered, the moves one answer settled. The same batch is read by the session that
 * asked and by the target project's coordinator, and answered by one
 * `POST /sessions/:id/task-moves/decision` with every move and its crossing key.
 */
export interface TaskMoveBatch {
  batchKey: string;
  requestedBySessionId: string;
  fromProjectId: string;
  /** null: the moves take their tasks out of every project, answered by the source's coordinator. */
  toProjectId: string | null;
  state: string;
  since: string;
  decidedAt: string | null;
  /** Whether this session asked for these moves, coordinates the project they go into, or both. */
  drawnAs: ReadonlyArray<'REQUESTER' | 'TARGET_COORDINATOR'>;
  moves: ProjectCrossingRow[];
}

/** The card id a batch of moves keeps from waiting to answered: its oldest move's. */
function batchId(first: ProjectCrossingRow): string {
  return `crossing-batch-${first.publicId ?? first.id}`;
}

/** The session read's batches of task moves as the decision card draws them, oldest first. */
export function moveBatches(read: readonly TaskMoveBatch[]): CrossingBatch[] {
  return read
    .filter((batch) => batch.moves.length > 0)
    .map((batch) => {
      const rows = [...batch.moves].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
      const first = rows[0];
      return {
        id: batchId(first),
        kind: 'MOVE_TASK',
        fromProjectId: batch.fromProjectId,
        sourceTitle: first.fromProject?.title ?? UNNAMED_PROJECT,
        rows,
        moment: first.requestedAt,
        out: batch.toProjectId == null,
        targetTitle: batch.toProjectId == null || batch.drawnAs.includes('TARGET_COORDINATOR')
          ? null
          : first.toProject?.title ?? UNNAMED_PROJECT,
      };
    })
    .sort((a, b) => a.moment.localeCompare(b.moment));
}

/** The batch answer: every waiting move with the crossing key the card was drawn from. */
export function moveBatchAnswer(
  batch: CrossingBatch,
  decision: 'APPROVE' | 'DENY',
): { decision: 'APPROVE' | 'DENY'; moves: Array<{ handoffId: string; crossingKey: string }> } {
  return {
    decision,
    moves: pendingRows(batch).map((row) => ({ handoffId: row.publicId ?? row.id, crossingKey: row.crossingKey })),
  };
}

export const UNNAMED_PROJECT = 'unnamed project';
/** Who wrote the card, not where the tasks come from: the From/To lines under it say that. */
export const CROSSING_PROVENANCE = 'Written by Orbit — not the requesting agent.';
export const CROSSING_TO_THIS_PROJECT = 'this project';
export const CROSSING_APPROVE_LABEL = 'Approve';
export const CROSSING_REFUSE_LABEL = 'Refuse';
export const CROSSING_NO_PROJECT = 'No project';
/** The project page's confirm prompt says the same of one task. */
export const MOVE_OUT_APPROVE_CONSEQUENCE = MOVE_TASK_OUT_APPROVE_CONSEQUENCE;
export const MOVE_OUT_MANY_APPROVE_CONSEQUENCE =
  "Confirming takes the tasks out of this project as soon as you answer; no project's acceptance counts them any more.";
export const CROSSING_LINK_LIVE = 'View details & act';
export const CROSSING_LINK_ANSWERED = 'View details';
export const CROSSING_RECORDED = 'Decision recorded';
export const CROSSING_NOT_RECORDED = 'That answer was not recorded';
export const CROSSING_SHOWN_ROWS = 3;
export const MOVE_TASKS_APPROVE_CONSEQUENCE =
  'Confirming is the move: the tasks join the target project as soon as you answer, and nobody has to send the request again.';
export const FILE_APPROVE_CONSEQUENCE =
  'The writer may then file this work under the target project. It is not filed by this answer.';

/** Whether a row names this project as its target, by either spelling of the id. */
function targets(row: ProjectCrossingRow, projectId: string): boolean {
  return row.toProjectId === projectId || row.toProjectPublicId === projectId;
}

/** A request to take a task out of every project, asked about this one: it has no target, so the
 *  source's coordinator conversation draws it (the server's `crossingCardSessionId`). */
function movesOutOf(row: ProjectCrossingRow, projectId: string): boolean {
  return row.toProjectId == null && row.kind === 'MOVE_TASK'
    && (row.fromProjectId === projectId || row.fromProjectPublicId === projectId);
}

/** A batch is still open at `at` while any member is undecided, or was decided after `at`. */
function openAt(rows: ProjectCrossingRow[], at: string): boolean {
  return rows.some((row) => row.decidedAt == null || row.decidedAt > at);
}

/** The cards one coordinator conversation draws for the crossings into its project, oldest first. */
export function crossingBatches(
  rows: readonly ProjectCrossingRow[],
  projectId: string,
): CrossingBatch[] {
  const groups = new Map<string, ProjectCrossingRow[]>();
  for (const row of rows) {
    const out = movesOutOf(row, projectId);
    if (!out && !targets(row, projectId)) continue;
    const key = `${row.fromProjectId}\u0000${row.kind}\u0000${out ? 'out' : 'in'}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const batches: CrossingBatch[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    let current: ProjectCrossingRow[] | null = null;
    for (const row of group) {
      if (current && openAt(current, row.requestedAt)) {
        current.push(row);
      } else {
        current = [row];
        const first = row;
        batches.push({
          id: batchId(first),
          kind: first.kind,
          fromProjectId: first.fromProjectId,
          sourceTitle: first.fromProject?.title ?? UNNAMED_PROJECT,
          out: first.toProjectId == null,
          rows: current,
          moment: first.requestedAt,
        });
      }
    }
  }
  return batches.sort((a, b) => a.moment.localeCompare(b.moment));
}

export function pendingRows(batch: CrossingBatch): ProjectCrossingRow[] {
  return batch.rows.filter((row) => row.state === 'PENDING');
}

export function isLive(batch: CrossingBatch): boolean {
  return pendingRows(batch).length > 0;
}

export type CrossingVerdict = 'APPROVED' | 'REFUSED' | 'MIXED';

/** Which way a fully answered batch went. */
export function batchVerdict(batch: CrossingBatch): CrossingVerdict {
  const approved = batch.rows.filter((row) => row.state === 'APPROVED' || row.state === 'APPLIED').length;
  if (approved === batch.rows.length) return 'APPROVED';
  if (approved === 0 && batch.rows.every((row) => row.state === 'DENIED')) return 'REFUSED';
  return 'MIXED';
}

/** The latest decision in the batch, or null. */
export function batchDecidedAt(batch: CrossingBatch): string | null {
  return batch.rows.reduce<string | null>(
    (latest, row) => (row.decidedAt && (!latest || row.decidedAt > latest) ? row.decidedAt : latest),
    null,
  );
}

// ── copy ────────────────────────────────────────────────────────────────────────────────────────

/** The card's question. `target` names the project the moves go into when it is not this
 *  conversation's own (the session that asked for them); `out` is a request to take tasks out of
 *  every project. */
export function crossingTitle(kind: string, count: number, target?: string | null, out = false): string {
  const one = count === 1;
  if (out) return one ? 'Take this task out of the project?' : 'Take these tasks out of the project?';
  if (kind === 'FILE_TASK') return one ? 'File this task here?' : 'File these tasks here?';
  if (kind === 'DEPEND_ON_TASK') return one ? 'Allow this dependency?' : 'Allow these dependencies?';
  if (target) return one ? `Move this task to ${target}?` : `Move these tasks to ${target}?`;
  return one ? 'Move this task here?' : 'Move these tasks here?';
}

/** An answered card's heading: what happened, no longer a question. A mixed answer says only that. */
export function answeredTitle(
  kind: string,
  count: number,
  verdict: CrossingVerdict,
  target?: string | null,
  out = false,
): string {
  const one = count === 1;
  const noun = kind === 'DEPEND_ON_TASK' ? (one ? 'Dependency' : 'Dependencies') : one ? 'Task' : 'Tasks';
  if (verdict === 'MIXED') return one ? 'Request answered' : 'Requests answered';
  if (verdict === 'REFUSED') {
    if (out) return `${noun} kept in the project`;
    if (kind === 'FILE_TASK') return one ? 'Filing refused' : 'Filings refused';
    if (kind === 'DEPEND_ON_TASK') return `${noun} refused`;
    return one ? 'Move refused' : 'Moves refused';
  }
  if (out) return `${noun} taken out of the project`;
  if (kind === 'FILE_TASK') return `${noun} filed here`;
  if (kind === 'DEPEND_ON_TASK') return `${noun} allowed`;
  if (target) return `${noun} moved to ${target}`;
  return `${noun} moved here`;
}

/** The label over the quoted reasons: they are the agent's words, under a card Orbit wrote. */
export function reasonsHead(count: number): string {
  return count === 1 ? 'Reason given by the requesting agent' : 'Reasons given by the requesting agent';
}

export function crossingBadge(kind: string): string {
  if (kind === 'FILE_TASK') return 'file';
  if (kind === 'DEPEND_ON_TASK') return 'depend';
  return 'move';
}

export function answeredBadge(kind: string, verdict: CrossingVerdict, out = false): string {
  if (verdict === 'REFUSED') return 'refused';
  if (verdict === 'MIXED') return 'answered';
  if (out) return 'taken out';
  return kind === 'MOVE_TASK' ? 'moved' : 'approved';
}

export function crossingNoun(kind: string, count: number): string {
  if (kind === 'DEPEND_ON_TASK') return count === 1 ? 'dependency' : 'dependencies';
  return count === 1 ? 'task' : 'tasks';
}

export function crossingListHead(kind: string, out = false): string {
  if (out) return 'Tasks to take out';
  if (kind === 'FILE_TASK') return 'Tasks to file';
  if (kind === 'DEPEND_ON_TASK') return 'Tasks waited on';
  return 'Tasks to move';
}

/** The criteria a batch asks for, by number: `4–11` when they are a run, else `4, 6, 9`. */
export function criteriaRange(ordinals: readonly number[]): string {
  const numbers = [...new Set(ordinals)].sort((a, b) => a - b);
  const contiguous = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  if (numbers.length > 1 && contiguous) return `${numbers[0]}–${numbers[numbers.length - 1]}`;
  return numbers.join(', ');
}

type NamedCriterion = { text: string | null; ordinal?: number | null };

/** What a person calls a criterion: `Criterion 4`, or its words from a server that sends no
 *  number. Never its key, which is an opaque id. Null when it has neither (deleted). */
export function criterionName(criterion: NamedCriterion): string | null {
  if (criterion.ordinal != null) return `Criterion ${criterion.ordinal}`;
  return criterion.text?.trim() || null;
}

export function crossingSummary(batch: CrossingBatch): string {
  const count = batch.rows.length;
  if (batch.out) return `${count} ${crossingNoun(batch.kind, count)} to take out of ${batch.sourceTitle}`;
  const head = `${count} ${crossingNoun(batch.kind, count)} from ${batch.sourceTitle}`;
  const distinct = new Map<string, NamedCriterion>();
  for (const row of batch.rows) {
    if (row.requestedCriterion) distinct.set(row.requestedCriterion.key, row.requestedCriterion);
  }
  const criteria = [...distinct.values()];
  const ordinals = criteria.flatMap((c) => (c.ordinal != null ? [c.ordinal] : []));
  const texts = criteria.flatMap((c) => (c.ordinal == null && c.text?.trim() ? [`“${c.text.trim()}”`] : []));
  const named = new Set(ordinals).size + texts.length;
  if (named === 0) return head;
  const parts = [...(ordinals.length ? [criteriaRange(ordinals)] : []), ...texts];
  return `${head} · for ${named === 1 ? 'criterion' : 'criteria'} ${parts.join(', ')}`;
}

export function waitingLine(batch: CrossingBatch): string {
  return `${crossingBadge(batch.kind)} · ${pendingRows(batch).length} waiting`;
}

export function subjectTitle(row: ProjectCrossingRow): string {
  return row.kind === 'FILE_TASK' ? row.title : row.subjectTask?.title ?? row.title;
}

export function requestedCriterionLine(row: ProjectCrossingRow): string | null {
  const requested = row.requestedCriterion;
  if (!requested) return null;
  return `${MOVE_TASK_REQUESTED_CRITERION_LABEL}: ${criterionName(requested) ?? MOVE_TASK_CRITERION_GONE}`;
}

export function withdrawnCriterionLine(row: ProjectCrossingRow): string | null {
  const withdrawn = row.withdrawnCriterion;
  if (!withdrawn) return null;
  const name = criterionName(withdrawn);
  return name ? `${MOVE_TASK_WITHDRAWN_CRITERION_LABEL}: ${name}` : null;
}

/** Each distinct reason given, once. */
export function batchReasons(batch: CrossingBatch): string[] {
  return [...new Set(batch.rows.map((row) => row.reason?.trim() ?? '').filter(Boolean))];
}

export function approveConsequence(batch: CrossingBatch): string {
  if (batch.out) return batch.rows.length === 1 ? MOVE_OUT_APPROVE_CONSEQUENCE : MOVE_OUT_MANY_APPROVE_CONSEQUENCE;
  if (batch.kind !== 'MOVE_TASK') return FILE_APPROVE_CONSEQUENCE;
  return batch.rows.length === 1 ? MOVE_TASK_APPROVE_CONSEQUENCE : MOVE_TASKS_APPROVE_CONSEQUENCE;
}

/** The two buttons, in the words of what they do: a request to take tasks out says so. */
export function decisionLabels(batch: CrossingBatch): { approve: string; refuse: string } {
  if (!batch.out) return { approve: CROSSING_APPROVE_LABEL, refuse: CROSSING_REFUSE_LABEL };
  return batch.rows.length === 1
    ? { approve: 'Take it out', refuse: 'Keep it here' }
    : { approve: 'Take them out', refuse: 'Keep them here' };
}

export function showMore(hidden: number): string {
  return `Show ${hidden} more`;
}

export function notRecordedNote(count: number): string {
  return count === 1 ? '1 answer was not recorded' : `${count} answers were not recorded`;
}

function verdictWord(verdict: CrossingVerdict): string {
  return verdict === 'APPROVED' ? 'Approved' : verdict === 'REFUSED' ? 'Refused' : 'Answered';
}

/** The receipt's clock: hours and minutes in the reader's locale, as the criteria receipt says it. */
export function crossingReceiptClock(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** `✓ Approved by you at 17:34` — the verdict half of the receipt. */
export function receiptVerdict(verdict: CrossingVerdict, at: string): string {
  return `✓ ${verdictWord(verdict)} by you at ${crossingReceiptClock(at)}`;
}

export function anotherEndLine(verdict: CrossingVerdict): string {
  return `${verdictWord(verdict)} at another end`;
}

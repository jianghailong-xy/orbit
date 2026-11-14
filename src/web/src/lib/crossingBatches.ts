import type { ProjectCrossingRow } from './attribution';
import {
  MOVE_TASK_APPROVE_CONSEQUENCE,
  MOVE_TASK_CRITERION_GONE,
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
  /** Oldest first. */
  rows: ProjectCrossingRow[];
  /** The first row's requestedAt: where the card is drawn in the conversation. */
  moment: string;
}

export const UNNAMED_PROJECT = 'unnamed project';
export const CROSSING_PROVENANCE = 'From Orbit — not the requesting agent.';
export const CROSSING_TO_THIS_PROJECT = 'this project';
export const CROSSING_APPROVE_LABEL = 'Approve';
export const CROSSING_REFUSE_LABEL = 'Refuse';
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
    if (!targets(row, projectId)) continue;
    const key = `${row.fromProjectId}\u0000${row.kind}`;
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
          id: `crossing-batch-${first.publicId ?? first.id}`,
          kind: first.kind,
          fromProjectId: first.fromProjectId,
          sourceTitle: first.fromProject?.title ?? UNNAMED_PROJECT,
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

export function crossingTitle(kind: string, count: number): string {
  const one = count === 1;
  if (kind === 'FILE_TASK') return one ? 'File this task here?' : 'File these tasks here?';
  if (kind === 'DEPEND_ON_TASK') return one ? 'Allow this dependency?' : 'Allow these dependencies?';
  return one ? 'Move this task here?' : 'Move these tasks here?';
}

export function crossingBadge(kind: string): string {
  if (kind === 'FILE_TASK') return 'file';
  if (kind === 'DEPEND_ON_TASK') return 'depend';
  return 'move';
}

export function answeredBadge(kind: string, verdict: CrossingVerdict): string {
  if (verdict === 'REFUSED') return 'refused';
  if (verdict === 'MIXED') return 'answered';
  return kind === 'MOVE_TASK' ? 'moved' : 'approved';
}

export function crossingNoun(kind: string, count: number): string {
  if (kind === 'DEPEND_ON_TASK') return count === 1 ? 'dependency' : 'dependencies';
  return count === 1 ? 'task' : 'tasks';
}

export function crossingListHead(kind: string): string {
  if (kind === 'FILE_TASK') return 'Tasks to file';
  if (kind === 'DEPEND_ON_TASK') return 'Tasks waited on';
  return 'Tasks to move';
}

/** The criteria a batch asks for: `4–11` when they are a run of numbers, else a list. */
export function criteriaRange(keys: readonly string[]): string {
  const distinct = [...new Set(keys)];
  const numeric = distinct.every((key) => /^\d+$/.test(key));
  if (numeric) {
    const numbers = distinct.map(Number).sort((a, b) => a - b);
    const contiguous = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
    if (numbers.length > 1 && contiguous) return `${numbers[0]}–${numbers[numbers.length - 1]}`;
    return numbers.join(', ');
  }
  return distinct.sort((a, b) => a.localeCompare(b)).join(', ');
}

export function crossingSummary(batch: CrossingBatch): string {
  const count = batch.rows.length;
  const head = `${count} ${crossingNoun(batch.kind, count)} from ${batch.sourceTitle}`;
  const keys = batch.rows.flatMap((row) => (row.requestedCriterion ? [row.requestedCriterion.key] : []));
  if (keys.length === 0) return head;
  const distinct = new Set(keys).size;
  return `${head} · for ${distinct === 1 ? 'criterion' : 'criteria'} ${criteriaRange(keys)}`;
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
  return `${MOVE_TASK_REQUESTED_CRITERION_LABEL}: ${requested.key}${
    requested.text == null ? ` — ${MOVE_TASK_CRITERION_GONE}` : ''
  }`;
}

export function withdrawnCriterionLine(row: ProjectCrossingRow): string | null {
  return row.withdrawnCriterion
    ? `${MOVE_TASK_WITHDRAWN_CRITERION_LABEL}: ${row.withdrawnCriterion.key}`
    : null;
}

/** Each distinct reason given, once. */
export function batchReasons(batch: CrossingBatch): string[] {
  return [...new Set(batch.rows.map((row) => row.reason?.trim() ?? '').filter(Boolean))];
}

export function approveConsequence(batch: CrossingBatch): string {
  if (batch.kind !== 'MOVE_TASK') return FILE_APPROVE_CONSEQUENCE;
  return batch.rows.length === 1 ? MOVE_TASK_APPROVE_CONSEQUENCE : MOVE_TASKS_APPROVE_CONSEQUENCE;
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

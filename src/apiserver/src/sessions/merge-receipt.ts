/**
 * The Orbit merge receipt (contract §13.7 MR1-MR5): everything about "this branch was merged" that
 * is a pure function of stated facts — the closed sets, the SHA normalisation, and the key that
 * makes recording the same merge twice a no-op.
 *
 * Kept out of the service so the CLI, the runner path and the tests can all derive the same
 * idempotency key without a database. Two writers that disagree about the key do not collide —
 * they each insert a row, which is the exact failure this key exists to prevent.
 */

import { createHash } from 'node:crypto';

/**
 * §13.7 MR2's closed set, the same four values migration 0128's CHECK freezes.
 *
 * `ALREADY_MERGED` is a RESULT and not a no-op. It is the answer in the case this whole table was
 * built for — a branch an agent merged itself with a fast-forward, discovered afterwards — and in
 * every re-run of a merge that already happened. Folding it into `MERGED` would erase the only
 * fact that tells "this merge moved the target" from "the target already contained it".
 */
export const MERGE_RECEIPT_RESULTS = ['MERGED', 'ALREADY_MERGED', 'CONFLICT', 'ERROR'] as const;

export type MergeReceiptResult = (typeof MERGE_RECEIPT_RESULTS)[number];

/** WHO recorded it. Provenance, never an input to a decision. */
export const MERGE_RECEIPT_RECORDERS = ['RUNNER', 'AGENT', 'USER'] as const;

export type MergeReceiptRecorder = (typeof MERGE_RECEIPT_RECORDERS)[number];

/** How many conflicting paths one receipt carries before the rest are dropped. A conflict with
 *  four hundred files is a fact about the merge, not four hundred facts. */
export const MERGE_RECEIPT_MAX_CONFLICTS = 200;

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * A full, lowercase, 40-hex object name — or a refusal.
 *
 * Abbreviated SHAs are rejected rather than expanded. This row's whole purpose is to still be
 * checkable a month from now, and an abbreviation is ambiguous by construction: it resolves against
 * a repository that has since gained objects, so the value that verified today can name a different
 * commit later, silently.
 */
export function normalizeSha(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return null;
  if (!SHA_RE.test(trimmed)) {
    throw new Error(
      `${field} must be a full 40-character git object name — an abbreviated SHA cannot be ` +
        're-checked against a repository that has moved on',
    );
  }
  return trimmed;
}

/**
 * What makes re-recording the same merge a no-op rather than a second row (MR4).
 *
 * The four facts that make two reports the SAME report: which session's branch, which commit, into
 * which branch, and what happened. Deliberately NOT the target tip — a merge re-reported after the
 * target moved on is still the same merge, and keying on a moving value would mint a new receipt
 * every time somebody asked again.
 */
export function mergeReceiptIdempotencyKey(input: {
  sessionId: string;
  sourceSha: string;
  targetBranch: string;
  result: MergeReceiptResult;
}): string {
  return createHash('sha256')
    .update(
      ['mr:v1', input.sessionId, input.sourceSha.toLowerCase(), input.targetBranch, input.result].join(
        ' ',
      ),
    )
    .digest('hex');
}

/** Whether this result means the source is in the target. Both landed states say yes — that is what
 *  makes the external fast-forward case stop reading as "never merged". */
export function resultLanded(result: MergeReceiptResult): boolean {
  return result === 'MERGED' || result === 'ALREADY_MERGED';
}

/**
 * The live `session.merge_status` this receipt implies.
 *
 * The receipt is the durable record and that column stays what it always was: the state of the
 * Merge button. Deriving one from the other rather than storing a second copy is what stops the
 * two from disagreeing — and it is the whole fix for a branch merged outside Orbit, whose button
 * used to sit blank forever because nothing had ever written to it.
 */
export function mergeStatusForResult(result: MergeReceiptResult): 'merged' | 'conflict' | 'error' {
  if (resultLanded(result)) return 'merged';
  return result === 'CONFLICT' ? 'conflict' : 'error';
}

/** One receipt as every reader sees it. Exported so the project's own read can serve the same
 *  shape without taking a dependency on the sessions module — two spellings of one row is how a
 *  client ends up handling `landed` in one place and re-deriving it in another. */
export interface MergeReceiptRow {
  id: string;
  sessionId: string;
  taskId: string | null;
  projectId: string | null;
  result: string;
  sourceBranch: string;
  sourceSha: string;
  targetBranch: string;
  targetShaBefore: string | null;
  targetShaAfter: string | null;
  rebaseBaseSha: string | null;
  conflicts: string[];
  recordedBy: string;
  detail: unknown;
  idempotencyKey: string;
  createdAt: Date;
}

export function mergeReceiptRow(r: MergeReceiptRow) {
  return {
    id: r.id,
    sessionId: r.sessionId,
    taskId: r.taskId,
    projectId: r.projectId,
    result: r.result,
    landed: resultLanded(r.result as MergeReceiptResult),
    sourceBranch: r.sourceBranch,
    sourceSha: r.sourceSha,
    targetBranch: r.targetBranch,
    targetShaBefore: r.targetShaBefore,
    targetShaAfter: r.targetShaAfter,
    rebaseBaseSha: r.rebaseBaseSha,
    // NULL is neither "not rebased" nor "unknown" without saying which, so it says which.
    rebaseBaseShaAbsentReason: r.rebaseBaseSha === null ? ('NOT_REBASED' as const) : null,
    conflicts: r.conflicts,
    recordedBy: r.recordedBy,
    detail: r.detail,
    idempotencyKey: r.idempotencyKey,
    createdAt: r.createdAt,
  };
}

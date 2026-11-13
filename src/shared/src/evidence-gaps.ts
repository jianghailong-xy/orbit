/**
 * The gaps of a completion-evidence envelope, and the clauses they hit
 * (docs/evidence-always-has-an-addressee-design.md §6, owner decision D4).
 *
 * `gaps` stays what it always was: an array of strings, each one sentence of what the evidence
 * does NOT establish. Released iOS/macOS, Android and web clients render it as text and drop
 * anything in it that is not a string, so it is never turned into objects.
 *
 * Beside it the envelope may carry `gapClauses`, an optional parallel array. Each entry points at
 * one gap by its index and says which clause of the task's standard that gap leaves unproven, and,
 * once one is filed, the task that will prove it:
 *
 *     "gaps": ["Physical devices were not checked."],
 *     "gapClauses": [{ "gap": 0, "criterionClause": "works on a phone", "followUpTaskId": "34w9…" }]
 *
 * - `gap` is a 0-based index into `gaps`; at most one entry per gap.
 * - `criterionClause` quotes or names the clause of the task's standard (its declared project
 *   criterion, else its own acceptance criteria) the gap hits. Whether the mark is honest is the
 *   decider's judgment, as every other part of the evidence is.
 * - `followUpTaskId` is the task that will prove the clause: it has to exist and be in the same
 *   project as the task the evidence is for (both in no project counts as the same).
 *
 * The decision door refuses CONFIRM while any entry has no `followUpTaskId`: a gap that hits the
 * standard can be accepted only by naming who proves it later. SEND_BACK is not affected. A gap
 * with no entry is a plain-text gap and is read as before.
 *
 * The pending-evidence row (`PendingEvidenceJudgment`) carries the same `gapClauses` beside its
 * `gaps`, empty when there are none; clients that do not know the field ignore it.
 */
export interface EvidenceGapClause {
  /** 0-based index into the envelope's `gaps`. */
  gap: number;
  /** The clause of the task's standard this gap leaves unproven. */
  criterionClause: string;
  /** The task, in the same project, that will prove the clause. Absent until one is filed. */
  followUpTaskId?: string;
}

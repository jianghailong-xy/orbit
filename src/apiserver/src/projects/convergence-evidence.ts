import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json';
import { SeverityTrend } from './convergence-contract';
import { ProgressVector, normalizeFailureText } from './convergence-progress';

/**
 * `[K4]`: where a progress vector COMES FROM, and what makes two actions the same action.
 *
 * `[K1]` proved `strictlyImproves` decides whether a task moved; it takes two vectors and asks no
 * questions about where they came from. That is the last place the incident (§0) can still live: a
 * caller that computes its own vector can claim any improvement it likes, and the four "since last
 * progress" counters zero themselves on its word. §1's table already says the vector is
 * *「由证据推导，无人手写」* — this module is that sentence as code.
 *
 * Two things it adds to §4, neither of which is a new vector dimension (PV1 forbids that, and
 * `convergence-contract.spec.ts` refuses the specific additions that would re-admit activity):
 *
 *  - **Freshness (PV6)** is a precondition on USING a measurement, not a measurement. Evidence
 *    older than the attempt it claims to describe cannot show what that attempt did, and a snapshot
 *    with nothing in it reads as all-zeros — which is indistinguishable from "every defect was
 *    fixed" to a comparison that only sees numbers. Both are refused the progress claim here rather
 *    than in the comparison, because both are questions about the EVIDENCE and not about the move.
 *  - **Action identity (§5.1)** is the failure fingerprint's other half. §8 bounds repeats of the
 *    same failure; the incident never repeated one, because every error carried a fresh session id,
 *    and the normalization that fixed that for failures is the same normalization an action needs.
 */

export type FindingSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['P0', 'P1', 'P2', 'P3'];

/** One stated acceptance criterion of the task's CURRENT revision. Migration 0229 removed the
 *  judgment, so there is nothing to say about it beyond that it was read. */
export interface AcceptanceEvidence {
  id: string;
  observedAt: Date;
}

/**
 * One finding, as §6 will spell it (`[K5]` owns the table; this owns what it means for progress).
 *
 * `regression` is separate from `severity` because §4 counts them separately: a P0 that was always
 * broken and a P1 that used to pass are different facts about whether the work is converging, and
 * the second one says the last change made things worse.
 */
export interface FindingEvidence {
  fingerprint: string;
  severity: FindingSeverity;
  resolved: boolean;
  regression: boolean;
  observedAt: Date;
}

export interface BlockerEvidence {
  key: string;
  resolved: boolean;
  observedAt: Date;
}

/** §7: only an `ACCEPTED` checkpoint is a known-good baseline. A `WIP_RED` one is not evidence. */
export interface CheckpointEvidence {
  sha: string;
  accepted: boolean;
  observedAt: Date;
}

export interface EvidenceSnapshot {
  scopeHash: string;
  acceptance: readonly AcceptanceEvidence[];
  findings: readonly FindingEvidence[];
  blockers: readonly BlockerEvidence[];
  checkpoint: CheckpointEvidence | null;
  /** When this snapshot was taken. Freshness is measured against it, never against a clock. */
  asOf: Date;
  /**
   * The earliest observation this snapshot may rest on — in practice the attempt's start.
   *
   * `null` means the caller is not judging one attempt's work (a first look at a task, a periodic
   * sweep), and only the absolute horizon applies.
   */
  notBefore: Date | null;
}

export type EvidenceFreshness = 'FRESH' | 'STALE' | 'UNMEASURED';

/** The freshness reading, kept beside the vector so a ledger row can say why it did not count. */
export interface EvidenceReading {
  freshness: EvidenceFreshness;
  /** The OLDEST observation in the snapshot — the one that decides the reading. */
  evidenceAsOf: Date | null;
  /** Which items were older than the fence, so a blocker can name them instead of "somewhere". */
  staleItems: readonly string[];
}

export interface DerivedProgress extends EvidenceReading {
  vector: ProgressVector;
  digest: string;
}

/**
 * How old the oldest piece of evidence may be before a snapshot stops being a measurement of now.
 *
 * A day rather than an hour: the fence that does the real work is `notBefore` (the attempt's own
 * start), and this one is the backstop for the case with no attempt to measure against — a task
 * nobody has looked at since yesterday is a task whose vector is a memory.
 */
export const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * §4, derived: the vector, plus whether it may be believed.
 *
 * The weakest link decides. A snapshot is a single measurement of one world, and one stale reading
 * inside it is enough to make the whole thing a claim about a world that has moved — the closed
 * criterion may have been re-opened by the change that is being judged, and nothing in the numbers
 * would show it. Re-reading everything is what a verification run does anyway; being allowed to
 * re-read PART of it and keep the rest is how a vector improves without the work improving.
 */
export function deriveProgressVector(
  snapshot: EvidenceSnapshot,
  maxAgeMs: number = EVIDENCE_MAX_AGE_MS,
): DerivedProgress {
  const open = snapshot.findings.filter((f) => !f.resolved);
  const vector: ProgressVector = {
    scopeHash: snapshot.scopeHash,
    acceptanceTotal: snapshot.acceptance.length,
    openP0: open.filter((f) => f.severity === 'P0').length,
    openP1: open.filter((f) => f.severity === 'P1').length,
    regressions: open.filter((f) => f.regression).length,
    openBlockers: snapshot.blockers.filter((b) => !b.resolved).length,
    // §7 CP1/CP3: a red checkpoint is not a baseline, so it is not the vector's `knownGoodSha`
    // either. Reading it as one would let "I saved my work" count as "there is a good state".
    knownGoodSha: snapshot.checkpoint?.accepted ? snapshot.checkpoint.sha : null,
  };

  const items = evidenceItems(snapshot);
  const fence = Math.max(
    snapshot.notBefore?.getTime() ?? Number.NEGATIVE_INFINITY,
    snapshot.asOf.getTime() - maxAgeMs,
  );
  const stale = items.filter((item) => item.at.getTime() < fence);
  const oldest = items.reduce<Date | null>(
    (acc, item) => (acc === null || item.at < acc ? item.at : acc),
    null,
  );

  return {
    vector,
    digest: sha256(canonicalJson(vector)),
    // An empty snapshot is UNMEASURED rather than FRESH. It is the reading a broken evidence
    // pipeline produces, and its vector is all zeros — which compares as "every defect closed".
    freshness: items.length === 0 ? 'UNMEASURED' : stale.length > 0 ? 'STALE' : 'FRESH',
    evidenceAsOf: oldest,
    staleItems: stale.map((item) => item.id),
  };
}

/**
 * PV6: may this reading be used to claim strict progress?
 *
 * Only a FRESH one. This is deliberately NOT symmetric — a stale reading still counts against the
 * budget through the counters, because "we could not measure" is a pass that produced no progress
 * and §0's loop was made of exactly those. What it may not do is REFRESH `lastProgressAt`, which is
 * the one thing that buys another five attempts.
 */
export function evidenceSupportsProgress(reading: EvidenceReading | undefined | null): boolean {
  return !reading || reading.freshness === 'FRESH';
}

/** §5.1: what an action is, for the purpose of noticing it is being done again. */
export interface ActionFacts {
  /** What is being done: `DISPATCH_ATTEMPT`, `FILE_DEFECT`, `RETRY`, … The caller's vocabulary. */
  kind: string;
  /** What it is being done to — a branch, a file, a task. Null when the kind says it all. */
  target: string | null;
  /** Why the actor believes it will work this time. Empty when it did not say. */
  hypothesis: string;
  scopeHash: string;
}

/**
 * §5.1: the identity of an action, normalized the way §5 normalizes a failure.
 *
 * Same normalization, same reason. The incident's error text differed every round by a session id,
 * so no two failures were ever "the same"; its actions differed every round by the same ids, in
 * the same sentences, and calling those different actions is how a loop of one action counts as
 * dozens of distinct plans.
 *
 * Numbers normalize away too, and that is a judgment rather than an oversight: "raise the timeout
 * to 30s" after "raise the timeout to 5s" is the same hypothesis with a knob moved, and a breaker
 * that let a constant buy a fresh budget would never close on the one shape it exists to stop.
 */
export function actionIdentity(facts: ActionFacts): string {
  return sha256(canonicalJson({
    kind: normalizeFailureText(facts.kind),
    target: facts.target === null ? null : normalizeFailureText(facts.target),
    hypothesis: normalizeFailureText(facts.hypothesis),
    scopeHash: facts.scopeHash,
  }));
}

/**
 * §5.1: the identity of a hypothesis alone, for `[K3]`'s "this attempt must try something new".
 *
 * Scope-bound for §5 FP3's reason: after a re-plan the same sentence is a proposal about a
 * different question, and refusing it as already-tried would deny the new revision its first
 * attempt.
 */
export function hypothesisIdentity(hypothesis: string, scopeHash: string): string {
  return sha256(canonicalJson({ h: normalizeFailureText(hypothesis), scopeHash }));
}

/**
 * §4 PV7: what happened to the defect load, as the repair counter reads it.
 *
 * `NONE` when nothing is open: there is no defect load to reduce, so a round that reduced none of
 * it is not a repair that repaired nothing — it is a task whose findings are not counted in P0/P1.
 * Incomparable vectors (PV3) read as `NONE` for the same reason: a measurement against a different
 * target says nothing about this one's defects.
 */
export function severityTrend(before: ProgressVector, after: ProgressVector): SeverityTrend {
  if (before.scopeHash !== after.scopeHash) return 'NONE';
  const now = after.openP0 + after.openP1;
  if (now < before.openP0 + before.openP1) return 'DROPPED';
  return now > 0 ? 'HELD' : 'NONE';
}

function evidenceItems(snapshot: EvidenceSnapshot): Array<{ id: string; at: Date }> {
  const items: Array<{ id: string; at: Date }> = [
    ...snapshot.acceptance.map((a) => ({ id: `acceptance:${a.id}`, at: a.observedAt })),
    ...snapshot.findings.map((f) => ({ id: `finding:${f.fingerprint}`, at: f.observedAt })),
    ...snapshot.blockers.map((b) => ({ id: `blocker:${b.key}`, at: b.observedAt })),
  ];
  if (snapshot.checkpoint) {
    items.push({ id: `checkpoint:${snapshot.checkpoint.sha}`, at: snapshot.checkpoint.observedAt });
  }
  return items;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * `[K6]` §7: the checkpoint, and the gate that decides whether a commit may leave the branch.
 *
 * `[K1]` froze §7's two kinds and its five refusal codes; `[K3]` left `task_attempt` carrying the
 * POINTER half of a checkpoint (a sha, a kind, a digest) and said in as many words that the table
 * and the merge gate were a later unit. This is that unit's pure half. What it adds to the pointer
 * is the three things a pointer cannot answer:
 *
 *   - **what the checkpoint IS** — commit, tree and base, so another machine can rebuild the exact
 *     state rather than a branch name that has since moved;
 *   - **what makes it known-good** — the test evidence, digested, so "verified" is a checkable
 *     claim and not an adjective somebody typed;
 *   - **where the work lives when it is known-RED** — a cross-runner artifact (CP2). The incident's
 *     shape is a `git stash` on one machine: the work is neither lost nor reachable, so the next
 *     generation silently starts from a baseline that is missing it. A stash is nameable here
 *     precisely so that naming one is a typed refusal instead of a missing field.
 *
 * Everything here is pure. `task-checkpoint.service` is what lands it, migration 0143 is what
 * holds it when a future writer forgets, and the two gates that consult it — the API server's
 * merge dispatch and the runner's own worktree effect — both come through `decideMergeGate` and
 * `landedVerdict` so there is one spelling of "already there" rather than two that can drift.
 */

import { createHash } from 'node:crypto';
import { CheckpointKind, MergeGateRefusal } from './convergence-contract';

export { CheckpointKind, MergeGateRefusal };

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * CP2's artifact kinds — how a checkpoint's tree is recovered on a machine that has never seen it.
 *
 * `LOCAL_STASH` is in the set on purpose and is never storable. It is what the incident actually
 * used, and a closed set that simply omitted it would turn "the work is in a stash on runner-7"
 * into a missing-field error whose message names a column instead of the mistake. Recording one is
 * `CHECKPOINT_ARTIFACT_NOT_PORTABLE`, which says the thing worth saying.
 */
export const CHECKPOINT_ARTIFACT_KINDS = ['GIT_BUNDLE', 'LOCAL_STASH'] as const;

export type CheckpointArtifactKind = (typeof CHECKPOINT_ARTIFACT_KINDS)[number];

/** The kinds that survive leaving the machine that produced them. CP2's whole requirement. */
export const PORTABLE_ARTIFACT_KINDS: readonly CheckpointArtifactKind[] = ['GIT_BUNDLE'];

export interface CheckpointArtifact {
  kind: CheckpointArtifactKind;
  /** The handle another runner fetches it by — a bundle id, an object-store key. */
  ref: string;
  /** sha256 of the artifact's bytes, so "the same bundle" stays checkable after transport. */
  digest: string;
}

/**
 * What the checkpoint IS, spelled so a second machine can rebuild it.
 *
 * `treeSha` is not redundant with `commitSha`. A commit carries an author, a date and a parent; two
 * runners that replay the same work produce two commits and one tree, and it is the TREE that
 * answers "is this the same state". `baseSha` is what the commit is a delta FROM, which is what a
 * bundle needs in order to be applicable anywhere at all.
 */
export interface CheckpointCommit {
  branch: string;
  commitSha: string;
  treeSha: string;
  baseSha: string;
}

/**
 * §7's "有测试证据" as a row rather than an adjective.
 *
 * `treeSha` is the tree the suite ACTUALLY ran against, and it is the field that does the work: a
 * green result recorded against a different tree than the checkpoint's is the exact shape of "we
 * tested it, then committed one more thing", which is how an unverified commit becomes a known-good
 * baseline without anybody lying.
 */
export interface CheckpointTestEvidence {
  suite: string;
  treeSha: string;
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * The digest §7 CP3's `TEST_EVIDENCE_MISMATCH` compares.
 *
 * Over the counts AND the tree, because either one alone is forgeable by accident: the same counts
 * on a different tree is the stale-evidence case, and the same tree with different counts is a
 * second run that disagreed with the first.
 */
export function checkpointEvidenceDigest(evidence: CheckpointTestEvidence): string {
  return createHash('sha256')
    .update(
      [
        'cpe:v1',
        evidence.suite,
        evidence.treeSha.toLowerCase(),
        String(evidence.passed),
        String(evidence.failed),
        String(evidence.skipped),
      ].join(' '),
    )
    .digest('hex');
}

/**
 * Whether this evidence says the state is good.
 *
 * `passed > 0` as well as `failed === 0`, because a suite that ran nothing also reports no
 * failures, and "we ran no tests" is the most common way a red tree passes for green.
 */
export function evidenceIsGreen(evidence: CheckpointTestEvidence): boolean {
  return evidence.failed === 0 && evidence.passed > 0;
}

/** What a caller asks to record. The KIND is not among the fields — see `planCheckpoint`. */
export interface CheckpointRequest {
  projectId: string;
  taskId: string;
  /** The revision the recorder measured against. Compared with the task's, never trusted (FD4). */
  scopeRevision: number;
  commit: CheckpointCommit;
  /** Null is legal and means known-red: a checkpoint saved so the work is not lost. */
  evidence: CheckpointTestEvidence | null;
  /** CP2. Required for anything that is not accepted; an accepted point needs none, because its
   *  commit is already reachable on a branch every runner can fetch. */
  artifact: CheckpointArtifact | null;
}

export type CheckpointRecordRefusal =
  /** §7's first row: an `ACCEPTED` point is one with test evidence. There is no other kind of it. */
  | 'CHECKPOINT_EVIDENCE_REQUIRED'
  /** CP2: known-red work with nowhere to be recovered from is work that is about to be lost. */
  | 'CHECKPOINT_ARTIFACT_REQUIRED'
  /** CP2, said precisely: a stash is a place, not an artifact. */
  | 'CHECKPOINT_ARTIFACT_NOT_PORTABLE'
  /** Evidence that was measured against a different tree than the one being checkpointed. */
  | 'CHECKPOINT_EVIDENCE_TREE_MISMATCH'
  /** FD4's rule for checkpoints: a conclusion about a question nobody is asking any more. */
  | 'SCOPE_REVISION_MISMATCH'
  /** A sha that cannot be re-checked later is not evidence (the merge receipt's rule, MR1). */
  | 'CHECKPOINT_SHA_MALFORMED';

export const CHECKPOINT_RECORD_REFUSALS: readonly CheckpointRecordRefusal[] = [
  'CHECKPOINT_EVIDENCE_REQUIRED',
  'CHECKPOINT_ARTIFACT_REQUIRED',
  'CHECKPOINT_ARTIFACT_NOT_PORTABLE',
  'CHECKPOINT_EVIDENCE_TREE_MISMATCH',
  'SCOPE_REVISION_MISMATCH',
  'CHECKPOINT_SHA_MALFORMED',
];

export interface PlannedCheckpoint {
  kind: CheckpointKind;
  commit: CheckpointCommit;
  evidence: CheckpointTestEvidence | null;
  evidenceDigest: string | null;
  artifact: CheckpointArtifact | null;
  /** CP1's identity: the content, hashed. Two records of the same content are one checkpoint. */
  dedupKey: string;
  contentDigest: string;
}

/**
 * §7's first table, decided before anything is written.
 *
 * The KIND is derived and never supplied. A caller that could name its own kind could call a red
 * tree `ACCEPTED`, and every property below it — what a later task may start from, what may reach
 * main — would rest on that word. What the caller supplies is what it MEASURED; §7's first row is
 * then a fact about the measurement rather than a claim about the work.
 */
export function planCheckpoint(
  request: CheckpointRequest,
  taskScopeRevision: number,
): PlannedCheckpoint | CheckpointRecordRefusal {
  if (request.scopeRevision !== taskScopeRevision) return 'SCOPE_REVISION_MISMATCH';

  const commit: CheckpointCommit = {
    branch: request.commit.branch.trim(),
    commitSha: request.commit.commitSha.trim().toLowerCase(),
    treeSha: request.commit.treeSha.trim().toLowerCase(),
    baseSha: request.commit.baseSha.trim().toLowerCase(),
  };
  if (
    !SHA_RE.test(commit.commitSha) ||
    !SHA_RE.test(commit.treeSha) ||
    !SHA_RE.test(commit.baseSha) ||
    commit.branch === ''
  ) {
    return 'CHECKPOINT_SHA_MALFORMED';
  }

  const evidence = request.evidence;
  if (evidence && evidence.treeSha.trim().toLowerCase() !== commit.treeSha) {
    return 'CHECKPOINT_EVIDENCE_TREE_MISMATCH';
  }
  const kind: CheckpointKind = evidence && evidenceIsGreen(evidence) ? 'ACCEPTED' : 'WIP_RED';

  const artifact = request.artifact
    ? {
        kind: request.artifact.kind,
        ref: request.artifact.ref.trim(),
        digest: request.artifact.digest.trim().toLowerCase(),
      }
    : null;
  // Portability first, and the order is not cosmetic: a stash with a perfectly well-formed ref is
  // still a stash, so reporting the ref would send somebody to fix the field that is not the
  // problem. `CHECKPOINT_ARTIFACT_NOT_PORTABLE` is the answer that names the mistake.
  if (artifact && !PORTABLE_ARTIFACT_KINDS.includes(artifact.kind)) {
    return 'CHECKPOINT_ARTIFACT_NOT_PORTABLE';
  }
  if (artifact && (artifact.ref === '' || !DIGEST_RE.test(artifact.digest))) {
    return 'CHECKPOINT_ARTIFACT_REQUIRED';
  }
  if (kind === 'WIP_RED') {
    // CP2. A red checkpoint's commit sits on a branch nobody will merge and that a worktree GC is
    // entitled to reclaim, so the artifact is the only thing that makes it recoverable elsewhere.
    if (!artifact) return 'CHECKPOINT_ARTIFACT_REQUIRED';
  } else if (!evidence) {
    return 'CHECKPOINT_EVIDENCE_REQUIRED';
  }

  const evidenceDigest = evidence ? checkpointEvidenceDigest(evidence) : null;
  const contentDigest = checkpointContentDigest({ kind, commit, evidenceDigest, artifact });
  return {
    kind,
    commit,
    evidence,
    evidenceDigest,
    artifact,
    contentDigest,
    dedupKey: checkpointDedupKey(
      request.projectId,
      request.taskId,
      request.scopeRevision,
      contentDigest,
    ),
  };
}

/**
 * CP1 in one value: every field of the checkpoint, hashed.
 *
 * "改一个字段等于新建一个 checkpoint" is a rule about identity, so identity is spelled over the
 * whole content. Recording the same thing twice therefore collides and writes nothing; recording
 * anything different is a different checkpoint, and the row that already exists is never touched.
 */
export function checkpointContentDigest(input: {
  kind: CheckpointKind;
  commit: CheckpointCommit;
  evidenceDigest: string | null;
  artifact: CheckpointArtifact | null;
}): string {
  return createHash('sha256')
    .update(
      [
        'cpc:v1',
        input.kind,
        input.commit.branch,
        input.commit.commitSha,
        input.commit.treeSha,
        input.commit.baseSha,
        input.evidenceDigest ?? '-',
        input.artifact?.kind ?? '-',
        input.artifact?.ref ?? '-',
        input.artifact?.digest ?? '-',
      ].join(' '),
    )
    .digest('hex');
}

/** FD1's shape, for checkpoints: project-scoped, task-scoped, revision-scoped, content-keyed. */
export function checkpointDedupKey(
  projectId: string,
  taskId: string,
  scopeRevision: number,
  contentDigest: string,
): string {
  return `pc:v1:${projectId}:checkpoint:${taskId}:${scopeRevision}:${contentDigest}`;
}

/**
 * CP4: the merge receipt's identity, keyed on the CHECKPOINT rather than on the session.
 *
 * The receipt's own key (MR4) is `(session, sourceSha, target, result)`, which makes a redelivery
 * from the same session a no-op and is the right answer for a merge nobody planned. It is the
 * wrong answer here for one reason: a checkpoint outlives the session that produced it, so a
 * merge re-reported by a SECOND session — a takeover, a recovery on another runner, the retry of a
 * request whose response was lost — mints a second receipt for one landing. Keying on the
 * checkpoint makes those the same fact. `result` stays in the key because a conflict and a
 * successful merge of the same checkpoint are two things that happened, not one reported twice.
 */
export function checkpointMergeReceiptKey(input: {
  checkpointId: string;
  targetBranch: string;
  result: string;
}): string {
  return createHash('sha256')
    .update(['cpm:v1', input.checkpointId, input.targetBranch, input.result].join(' '))
    .digest('hex');
}

/** The half of a checkpoint the gate reads. */
export interface MergeGateCheckpoint {
  id: string;
  kind: CheckpointKind;
  scopeRevision: number;
  commitSha: string;
  evidenceDigest: string | null;
}

export interface MergeGateRequest {
  /** The frozen full source SHA this merge would take. Never a branch name: a name is a value
   *  that moves, and every refusal below is about a specific commit. */
  branchTipSha: string;
  /** The task's CURRENT scope revision, read from the task row. */
  taskScopeRevision: number;
  /** The evidence digest the caller brings, when it brings one. Null makes no claim. */
  evidenceDigest: string | null;
}

export type MergeGateDecision =
  | { decision: 'ALLOWED'; checkpointId: string }
  | { decision: MergeGateRefusal; checkpointId: string | null; detail: string };

/**
 * §7 CP3, in the document's own order.
 *
 * The order is fixed for TH1's reason: two conditions can hold at once — a `WIP_RED` checkpoint on
 * a stale revision is both — and a gate that reports whichever it noticed first gives two answers
 * to one question when it is replayed. Earlier is more specific: "the checkpoint you named is the
 * red one" tells somebody what to do, and "the branch tip is not the checkpoint" tells them the
 * same thing three steps later and about the wrong object.
 *
 * There is no sixth answer and no fallback. A gate that fell back to "allow, but log it" is how
 * §0's incident merged twenty-two commits nobody had verified.
 */
export function decideMergeGate(
  checkpoint: MergeGateCheckpoint | null,
  request: MergeGateRequest,
): MergeGateDecision {
  if (!checkpoint) {
    return {
      decision: 'NO_CHECKPOINT',
      checkpointId: null,
      detail: 'this task has recorded no checkpoint, so there is nothing verified to merge',
    };
  }
  if (checkpoint.kind !== 'ACCEPTED') {
    return {
      decision: 'CHECKPOINT_NOT_ACCEPTED',
      checkpointId: checkpoint.id,
      detail: `checkpoint is ${checkpoint.kind}: known-red work is saved, not merged`,
    };
  }
  if (checkpoint.scopeRevision !== request.taskScopeRevision) {
    return {
      decision: 'SCOPE_REVISION_MISMATCH',
      checkpointId: checkpoint.id,
      detail:
        `checkpoint was verified against scope revision ${checkpoint.scopeRevision}, ` +
        `the task now asks revision ${request.taskScopeRevision}`,
    };
  }
  if (checkpoint.commitSha !== request.branchTipSha.trim().toLowerCase()) {
    return {
      decision: 'BRANCH_TIP_MISMATCH',
      checkpointId: checkpoint.id,
      detail:
        `the branch tip is ${request.branchTipSha} but the verified commit is ` +
        `${checkpoint.commitSha} — the commits after it carry no evidence`,
    };
  }
  // A caller that brings no digest contradicts nothing: the checkpoint's own evidence is what makes
  // it `ACCEPTED`, and it was already required to have some. What this refuses is a caller that
  // brings a DIFFERENT one, which is a second measurement disagreeing with the recorded one.
  const claimed = request.evidenceDigest?.trim().toLowerCase() ?? null;
  if (claimed !== null && claimed !== checkpoint.evidenceDigest) {
    return {
      decision: 'TEST_EVIDENCE_MISMATCH',
      checkpointId: checkpoint.id,
      detail: 'the evidence presented is not the evidence this checkpoint was accepted on',
    };
  }
  return { decision: 'ALLOWED', checkpointId: checkpoint.id };
}

/**
 * "Is this source already in that target" — the question both gates ask before touching anything.
 *
 * Written as a pure function over two facts a caller supplies because the API server and the runner
 * learn them differently (one from committed receipts, one from `git merge-base`) and must reach
 * the same conclusion. §0's sibling incident is what happens when neither of them asks: the source
 * and the target were the SAME commit, the branch names differed, so the only guard in the path —
 * "you cannot merge a branch into itself" — did not fire, and the merge replayed twenty-two commits
 * from a base recorded days earlier onto a target that already contained every one of them. Every
 * conflict it reported was between a commit and itself.
 */
export type LandedVerdict = 'TARGET_IS_SOURCE' | 'TARGET_CONTAINS_SOURCE' | 'NOT_LANDED';

export function landedVerdict(
  sourceSha: string,
  targetSha: string | null,
  targetContainsSource: boolean,
): LandedVerdict {
  const source = sourceSha.trim().toLowerCase();
  const target = targetSha?.trim().toLowerCase() ?? '';
  if (source !== '' && source === target) return 'TARGET_IS_SOURCE';
  return targetContainsSource ? 'TARGET_CONTAINS_SOURCE' : 'NOT_LANDED';
}

export function verdictIsLanded(verdict: LandedVerdict): boolean {
  return verdict !== 'NOT_LANDED';
}

/**
 * May the control plane believe this reported landing?
 *
 * Decided from what the SERVER persisted when it authorised the merge, never from what the runner
 * sent back. `requiredSourceSha` rides on the command because the runner is the only party that can
 * compare a commit against a working tree — but an older runner does not read it, a broken one can
 * ignore it, and either would then report a merge of some other commit. Without this, the control
 * plane writes `branch_merged`, `merged_source_sha` and a receipt for that commit, and because no
 * checkpoint matches it the receipt carries a NULL `checkpoint_id`, which is exactly the shape
 * §7's own trigger lets through. An unverified tip would end up recorded as landed, and every
 * downstream reader — the baseline, the acceptance evidence, the dependent task — would believe it.
 *
 * Fail-closed on every uncertainty, and the uncertainties are the point:
 *
 *   - a managed task whose merge names no checkpoint at all is refused rather than waved through,
 *     because the queue-time gate would not have authorised one;
 *   - a landing that names no source commit is refused, because "it merged something" is not a
 *     statement anybody can re-check;
 *   - a source that is not the verified commit is refused, whatever else is true about it.
 *
 * Unmanaged work — every merge Orbit records today — has no expectation and is untouched (AC11).
 */
export type ReportedLandingDecision =
  | { decision: 'ALLOWED'; checkpointId: string | null }
  | { decision: MergeGateRefusal; checkpointId: string | null; detail: string };

export function authorizeReportedLanding(
  expected: { id: string; kind: CheckpointKind; commitSha: string } | null,
  managed: boolean,
  reportedSourceSha: string | null,
): ReportedLandingDecision {
  if (!expected) {
    if (!managed) return { decision: 'ALLOWED', checkpointId: null };
    return {
      decision: 'NO_CHECKPOINT',
      checkpointId: null,
      detail:
        'this task is under convergence management and has no accepted checkpoint, so no commit ' +
        'of it may be recorded as landed',
    };
  }
  if (expected.kind !== 'ACCEPTED') {
    return {
      decision: 'CHECKPOINT_NOT_ACCEPTED',
      checkpointId: expected.id,
      detail: `the merge was authorised for a ${expected.kind} checkpoint`,
    };
  }
  const reported = reportedSourceSha?.trim().toLowerCase() ?? '';
  if (reported === '') {
    return {
      decision: 'BRANCH_TIP_MISMATCH',
      checkpointId: expected.id,
      detail: 'the runner named no source commit, so this landing cannot be re-checked',
    };
  }
  if (reported !== expected.commitSha) {
    return {
      decision: 'BRANCH_TIP_MISMATCH',
      checkpointId: expected.id,
      detail:
        `the runner reports it merged ${reported}, but this merge was authorised for the ` +
        `verified commit ${expected.commitSha}`,
    };
  }
  return { decision: 'ALLOWED', checkpointId: expected.id };
}

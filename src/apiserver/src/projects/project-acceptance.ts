import { createHash } from 'node:crypto';

/**
 * Everything about project acceptance that is a pure function of stated facts — the digest AE1
 * freezes, the criteria parser the per-criterion record is built from, and the closed set of
 * refusal codes the DONE gate answers with.
 *
 * Kept out of the service on purpose: `acceptanceDigest` is the identity of a body of evidence, so
 * it has to be computable by anything that wants to check a claim — a test, a CLI, a future
 * verifier — without standing up Nest, Prisma or a database.
 */

/** Bumped only when the digest's INPUT SHAPE changes, so an old record cannot silently match a new
 *  reading of the same world. It is inside the hash, not beside it. */
/**
 * Version 2 (§13.6 SU6): `taskSet` carries each task's successor and terminal reason.
 *
 * It had to. AE1's whole promise is that a recorded digest identifies the WORLD a conclusion was
 * reached about, and supersession is a fact about that world which the previous three columns could
 * not see: an attempt linked to its successor after an acceptance was opened changed which tasks
 * count as unfinished — the DONE gate reads it, aggregation reads it, §11's detectors read it —
 * while the digest stayed byte-identical. A run frozen before the link would have passed on
 * evidence about a different world and reported nothing amiss.
 *
 * BOTH columns, for the reason SU6 gives everywhere else: `superseded_by_task_id` and
 * `terminal_reason` move independently. Deleting a successor takes the pointer and leaves the
 * reason; re-pointing a `SUCCESSOR_DELETED` row at a new attempt moves the pointer and not the
 * reason. A digest carrying one of them agrees about worlds that differ in the other, and — worse —
 * disagrees with `hashDecisionInput`, which carries the whole task row. Two hashes over one change
 * must not reach two answers about whether the world moved.
 *
 * `superseded_at` is deliberately NOT here, and the rule that excludes it is the same one that
 * excludes `updated_at`: it is AUDIT, not semantics. No gate reads it — retirement is decided by
 * the other two columns and by nothing else — so including it would make an acceptance go stale on
 * a re-statement that changed nothing anybody consults. (`hashDecisionInput` does carry it, because
 * that hash is "the snapshot I read", not "the facts my conclusion depends on"; `updated_at` is in
 * that one too and in neither of the reasons anything decides.)
 *
 * The consequence of the bump is deliberate and is the recoverable one: every acceptance run open
 * at deploy time re-digests differently and its DONE is refused `ACCEPTANCE_EVIDENCE_STALE`, which
 * names itself and is answered by opening a new attempt. The alternative — leaving the shape alone
 * — is a digest that silently agrees about worlds that differ.
 */
export const ACCEPTANCE_DIGEST_VERSION = 2;

/**
 * Why a DONE was refused. Two of the three are frozen by the contract (§13.4 AE2 step 3); the third
 * is this unit's, and it is separate on purpose — "your evidence does not match the world" and
 * "the world still has something unfinished in it" send the caller to two different places.
 */
export const ACCEPTANCE_MISSING = 'ACCEPTANCE_MISSING';
export const ACCEPTANCE_EVIDENCE_STALE = 'ACCEPTANCE_EVIDENCE_STALE';
export const ACCEPTANCE_BLOCKED = 'ACCEPTANCE_BLOCKED';

export type AcceptanceRefusalCode =
  | typeof ACCEPTANCE_MISSING
  | typeof ACCEPTANCE_EVIDENCE_STALE
  | typeof ACCEPTANCE_BLOCKED;

/** The four projections of §13.4 AE1, already sorted and stringified. Tuples rather than objects
 *  because a tuple has no key order to disagree about between two writers of this file. */
export interface AcceptanceFacts {
  /** sha256 of `project.acceptance_criteria ?? ''` — one edited character changes it. */
  criteriaRevision: string;
  /**
   * (taskId, status, completionPolicy, terminalReason, supersededByTaskId) — `status` is in it so
   * DONE → OPEN moves the digest, and the last two are in it so being REPLACED, being UNLINKED, or
   * having a successor deleted each move it too. Both are the empty string when absent, which keeps
   * the tuple fixed-width and keeps "nothing here" from rendering as the same JSON as some future
   * value spelled `null`. See `ACCEPTANCE_DIGEST_VERSION` for why `supersededAt` is not among them.
   */
  taskSet: Array<[string, string, string, string, string]>;
  /** (verifierTaskId, verifiesTaskId, verdict) — a verdict that changes changes the digest. */
  verdicts: Array<[string, string, string]>;
  /** (requirementId, targetBranch, contentHash, refGeneration) — §13.4 AE9's authoritative row. */
  mergeEvidence: Array<[string, string, string, string]>;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** JSON with every object key in a fixed order, so two writers hashing the same facts agree.
 *  Arrays keep their order — the callers sort them, and a sort here would hide one that forgot. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** Sort tuples by their rendered form: one comparator for all four projections, and one that
 *  cannot disagree with itself about which column is more significant. */
function sortTuples<T extends readonly string[]>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const x = JSON.stringify(a);
    const y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * §13.4 AE1, literally. The value a DONE is checked against, and the value an acceptance run
 * records so that "this evidence is about THAT world" is a comparison rather than a belief.
 */
export function acceptanceDigest(projectId: string, facts: AcceptanceFacts): string {
  return sha256(
    canonical({
      v: ACCEPTANCE_DIGEST_VERSION,
      projectId,
      criteriaRevision: facts.criteriaRevision,
      taskSet: sortTuples(facts.taskSet),
      verdicts: sortTuples(facts.verdicts),
      mergeEvidence: sortTuples(facts.mergeEvidence),
    }),
  );
}

/** The digest of what a run CONCLUDED, over the ordered per-criterion pairs. Separate from the
 *  input digest for the reason §7.4 EC2-b separates the action's two: what was judged and what the
 *  judgement was are two questions, and one hash covering both can answer neither. */
export function acceptanceResultDigest(
  runId: string,
  outcomes: Array<{ ordinal: number; criterionKey: string; verdict: string }>,
): string {
  return sha256(
    canonical({
      v: ACCEPTANCE_DIGEST_VERSION,
      runId,
      outcomes: [...outcomes]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((o) => [o.ordinal, o.criterionKey, o.verdict]),
    }),
  );
}

export interface ParsedCriterion {
  ordinal: number;
  key: string;
  text: string;
}

/** List markers a person writes criteria with. Stripped so that renumbering a list does not change
 *  a criterion's identity, while its words still do. */
const LIST_MARKER = /^\s*(?:[-*+•]|\(?\d+[.)、]|\d+\s*[.)、]|[（(]\d+[）)]|第\s*\d+\s*[条项点])\s*/u;

/**
 * The stated criteria, one row each (§13.4 clause 2: "逐条核对").
 *
 * A project's acceptance criteria are free text, and this is the one place that decides what "one
 * criterion" means — deliberately, because a run that judges a different decomposition than the
 * gate expects is a run that can be complete and incomplete at the same time. The rule is the
 * simplest one that survives the way people actually write these: one non-blank line is one
 * criterion, list markers are cosmetic, and a criteria field with no line breaks is one criterion
 * rather than none.
 *
 * `key` is content-addressed, so reordering the list keeps each criterion recognisable across runs
 * while editing its words correctly makes it a different criterion.
 */
export function parseCriteria(criteria: string | null | undefined): ParsedCriterion[] {
  const text = (criteria ?? '').replace(/\r\n?/g, '\n');
  const out: ParsedCriterion[] = [];
  for (const raw of text.split('\n')) {
    const stripped = raw.replace(LIST_MARKER, '').trim();
    if (stripped === '') continue;
    out.push({ ordinal: out.length + 1, key: sha256(stripped).slice(0, 32), text: stripped });
  }
  return out;
}

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

/**
 * Bumped only when the digest's INPUT SHAPE changes, so an old record cannot silently match a new
 * reading of the same world. It is inside the hash, not beside it.
 *
 * Version 4: project completion is a claim about the acceptance criteria, not about the task list.
 * `taskSet` and task-verification verdicts therefore leave the input shape entirely. A project may
 * satisfy every criterion with OPEN nice-to-have tasks, while a project whose tasks are all DONE
 * may still fail a criterion. Keeping task state in this digest made those two independent facts
 * invalidate one another and made a task backlog an accidental second definition of DONE.
 *
 * Merge evidence remains because it is evidence cited by a criterion, not a tally of work left.
 * Open blockers are deliberately outside the digest and are checked explicitly by the gate: they
 * mean "known unfinished fact", not "there are tasks left".
 */
export const ACCEPTANCE_DIGEST_VERSION = 4;

/** The routing rule shared by DONE refusals and settled-project write refusals. */
export const ACCEPTANCE_FINDING_ROUTING =
  'A new finding belongs to this project only if it changes an acceptance criterion: return that ' +
  'criterion to non-PASS and re-run acceptance. If it changes no criterion, create a separate project.';

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

/** The acceptance projections, already sorted and stringified. Tuples rather than objects because
 * a tuple has no key order to disagree about between two writers of this file. */
export interface AcceptanceFacts {
  /** sha256 of the unordered multiset of current criterion content hashes. */
  criteriaRevision: string;
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

/** Sort tuples by their rendered form: one comparator for every row projection, and one that
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

/** The editable definition shape as read from
 * `project_acceptance_criterion_definition`. Kept structural so pure acceptance code and tests do
 * not need Prisma's generated model types. */
export interface AcceptanceCriterionDefinitionLike {
  id: string;
  ordinal: number;
  text: string;
  revision: number;
  contentHash?: string;
}

/** One criterion frozen into a run. `definitionId` is absent only for runs that predate the
 * structured authoring model, or for a compatibility fallback while a rolling migration is still
 * backfilling its definition rows. */
export interface StatedAcceptanceCriterion extends ParsedCriterion {
  definitionId: string | null;
  definitionRevision: number | null;
  contentHash: string;
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

/** Turn current definition rows into the exact checklist a run snapshots. */
export function criteriaFromDefinitions(
  definitions: AcceptanceCriterionDefinitionLike[],
): StatedAcceptanceCriterion[] {
  return [...definitions]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((definition, index) => {
      const text = definition.text.trim();
      const contentHash = sha256(text);
      return {
        ordinal: index + 1,
        key: contentHash.slice(0, 32),
        text,
        definitionId: definition.id,
        definitionRevision: definition.revision,
        contentHash,
      };
    });
}

/** Compatibility checklist for a project whose 0172 definition rows are not visible yet. */
export function criteriaFromLegacy(
  criteria: string | null | undefined,
): StatedAcceptanceCriterion[] {
  return parseCriteria(criteria).map((criterion) => {
    const contentHash = sha256(criterion.text);
    return {
      ...criterion,
      definitionId: null,
      definitionRevision: null,
      contentHash,
    };
  });
}

/**
 * Which of the two shapes states a project's criteria: the 0172 definition rows when it has any,
 * and the legacy text otherwise.
 *
 * One spelling, because there is now more than one reader — `ProjectAcceptanceService.statedCriteria`
 * judges a run against these, and unit T6's `refuseTaskOpening` checks a declared `criterionKey`
 * against them. Two copies of the fallback is how a coordinator ends up refused for naming a
 * criterion the acceptance run would have recognised.
 */
export function statedCriteriaFrom(
  definitions: AcceptanceCriterionDefinitionLike[],
  legacy: string | null | undefined,
): StatedAcceptanceCriterion[] {
  return definitions.length > 0 ? criteriaFromDefinitions(definitions) : criteriaFromLegacy(legacy);
}

/** The legacy text projection old clients continue to read. The numbered Markdown is a projection,
 * never a parser contract: structured callers own the item boundaries before this is rendered. */
export function criteriaLegacyProjection(
  criteria: Array<{ text: string }>,
): string | null {
  if (criteria.length === 0) return null;
  return criteria.map((criterion, index) => `${index + 1}. ${criterion.text.trim()}`).join('\n');
}

/** Identity of the semantic criterion MULTISET. Order is excluded because project PASS is the
 * conjunction of its criteria; moving a row in the UI changes presentation, not the proposition
 * being judged. Full content hashes keep duplicates countable and make the comma join unambiguous. */
export function criteriaSemanticRevision(
  criteria: Array<{ text: string }>,
): string {
  const hashes = criteria.map((criterion) => sha256(criterion.text.trim())).sort();
  return sha256(hashes.join(','));
}

import { createHash } from 'node:crypto';
import { uuidToBase62 } from '@orbit/shared';

/**
 * Everything about a project's acceptance CRITERIA that is a pure function of what was authored:
 * the checklist a reader checks the project against, and its content identity.
 *
 * Migration 0229 removed the judging half of this file with the machine it served — the evidence
 * digest, the result digest and the DONE gate's refusal codes all described runs, conclusions and
 * an accepted-run pointer that no longer exist. What is left is the declaration, which is what the
 * account owner asked to keep: 274 criteria across 41 projects, stated precisely, with nothing in
 * Orbit that evaluates them.
 *
 * Kept out of the service on purpose: the criterion key is the identity of a stated condition, so
 * it has to be computable by anything that wants to name one — a test, a CLI, a future evaluator —
 * without standing up Nest, Prisma or a database.
 */

/** The rule for where a newly discovered problem belongs, shared by the settled-project write
 *  refusal and by anything else that has to say "not in this project". */
export const ACCEPTANCE_FINDING_ROUTING =
  'A new finding belongs to this project only if it changes an acceptance criterion: edit that ' +
  'criterion. If it changes no criterion, create a separate project.';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The editable definition shape as read from
 * `project_acceptance_criterion_definition`. Kept structural so pure acceptance code and tests do
 * not need Prisma's generated model types. */
export interface AcceptanceCriterionDefinitionLike {
  id: string;
  ordinal: number;
  text: string;
  /** The procedure a person follows to decide this assertion. Absent only for legacy/test rows. */
  verificationMethod?: string | null;
  completionCriterionOverrideReason?: string | null;
  revision: number;
  contentHash?: string;
}

/** One authored criterion, as a reader sees it. `key` is the definition's own id and `revision`
 * beside it is what the words are on, so reordering the list and rewording a criterion are two
 * separately readable facts rather than one string that answers for both. */
export interface StatedAcceptanceCriterion {
  ordinal: number;
  key: string;
  text: string;
  definitionId: string;
  definitionRevision: number;
  verificationMethod: string | null;
  completionCriterionOverrideReason: string | null;
  contentHash: string;
}

/**
 * The name a caller uses for one stated criterion: the definition's own id.
 *
 * It was `contentHash.slice(0, 32)` until this unit, which made one string carry two intents —
 * "the same criterion after a reorder" and "a different criterion after an edit" — and coupled
 * everybody holding a key to the exact words. `(key, revision)` states them apart: the id survives
 * an edit, the revision counts them. The content hash is still stored and still returned; nothing
 * derives this from it any more.
 *
 * Spelled base62, because `key` is not a name `PUBLIC_ID_FIELDS` classifies and so nothing
 * downstream would encode it: a raw uuid here would be the one value in the response a reader
 * could not hand straight back, sitting beside an `id` and a `publicId` that are the same row in
 * the other spelling. An id that is not a uuid (a unit-test row) passes through unchanged — the
 * same rule the response encoder applies to a value it cannot decode.
 */
export function criterionKeyOf(definitionId: string): string {
  try {
    return uuidToBase62(definitionId);
  } catch {
    return definitionId;
  }
}

/** Turn current definition rows into the checklist every reader of this project checks. */
export function criteriaFromDefinitions(
  definitions: AcceptanceCriterionDefinitionLike[],
): StatedAcceptanceCriterion[] {
  return [...definitions]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((definition, index) => {
      const text = definition.text.trim();
      const contentHash = definition.contentHash ?? sha256(text);
      return {
        ordinal: index + 1,
        key: criterionKeyOf(definition.id),
        text,
        definitionId: definition.id,
        definitionRevision: definition.revision,
        verificationMethod:
          typeof definition.verificationMethod === 'string' && definition.verificationMethod.trim()
            ? definition.verificationMethod.trim()
            : null,
        completionCriterionOverrideReason:
          definition.completionCriterionOverrideReason?.trim() || null,
        contentHash,
      };
    });
}

/** Identity of the semantic criterion MULTISET. Order is excluded because a project's acceptance
 * is the conjunction of its criteria; moving a row in the UI changes presentation, not the
 * proposition being stated. Full content hashes keep duplicates countable and make the comma join
 * unambiguous. */
export function criteriaSemanticRevision(
  criteria: Array<{
    text: string;
    contentHash?: string;
    id?: string | null;
    definitionId?: string | null;
    revision?: number | null;
    definitionRevision?: number | null;
  }>,
): string {
  const hashes = criteria
    .map((criterion) => {
      const contentHash = criterion.contentHash ?? sha256(criterion.text.trim());
      const definitionId = criterion.definitionId ?? criterion.id;
      const definitionRevision = criterion.definitionRevision ?? criterion.revision;
      return definitionId && definitionRevision != null
        ? `${definitionId}:${definitionRevision}:${contentHash}`
        : contentHash;
    })
    .sort();
  return sha256(hashes.join(','));
}

/**
 * ── The standard set as a VERSION, which is what a confirmation is about ───────────────────────
 *
 * `CONFIRM_ACCEPTANCE_CRITERIA` is HUMAN_ONLY because whoever moves the ruler can make any
 * conclusion come out right. A confirmation that named no version would move with the ruler and
 * so would protect nothing: the point of the tier is that a set the owner approved cannot become
 * a different set without being approved again.
 *
 * The version is `criteriaSemanticRevision` above — the multiset of
 * `definitionId:revision:contentHash` — and not a second spelling of it. Both halves of an edit
 * are covered: `project_acceptance_definition_normalize` advances `revision` when either the
 * assertion or the verification method changes, and rewrites `content_hash` from both.
 */

/** One criterion as a confirmation names it: exactly the three values the digest is taken over. */
export interface ConfirmedCriterionVersion {
  definitionId: string;
  revision: number;
  contentHash: string;
}

/** Which version of a project's stated criteria is on the table, in both spellings. */
export interface StandardSetVersion {
  /** Is it still this one? */
  digest: string;
  /** Which one was it? Ordered by definition id so two readers produce the same array. */
  material: ConfirmedCriterionVersion[];
}

export function standardSetVersion(criteria: StatedAcceptanceCriterion[]): StandardSetVersion {
  return {
    digest: criteriaSemanticRevision(criteria),
    material: criteria
      .map((criterion) => ({
        definitionId: criterion.definitionId,
        revision: criterion.definitionRevision,
        contentHash: criterion.contentHash,
      }))
      .sort((a, b) => (a.definitionId < b.definitionId ? -1 : a.definitionId > b.definitionId ? 1 : 0)),
  };
}

/**
 * Where a project stands on owner confirmation.
 *
 * Three states rather than a boolean, because "nobody has ever said this" and "somebody said it
 * about criteria that have since been rewritten" are different things to show a reader — and
 * because only the second one has a version to display. Neither of them is confirmed.
 */
export type StandardSetConfirmationState = 'UNCONFIRMED' | 'CONFIRMED' | 'STALE';

/** A recorded confirmation, narrowed to what deciding the standing needs. */
export interface RecordedStandardSetConfirmation {
  criteriaDigest: string;
  criteriaMaterial: ConfirmedCriterionVersion[];
  confirmedAt: Date;
  confirmedById: string;
}

export interface StandardSetConfirmationStanding {
  state: StandardSetConfirmationState;
  /** `state === 'CONFIRMED'`, carried beside it so a caller cannot get the comparison wrong. */
  confirmed: boolean;
  /** The version standing today — what a confirmation would have to name to be current. */
  currentVersion: StandardSetVersion;
  /** The newest confirmation on record, current or not. Null when there has never been one. */
  confirmation: RecordedStandardSetConfirmation | null;
}

/**
 * The whole rule: a confirmation counts while, and only while, it names the version that stands.
 *
 * Decided at READ time from two facts that are both stored, rather than by a flag somebody has to
 * remember to clear when the criteria are edited. An edit therefore cannot leave a stale
 * confirmation behind it — there is nothing to forget.
 */
export function standardSetConfirmationStanding(
  currentVersion: StandardSetVersion,
  confirmation: RecordedStandardSetConfirmation | null,
): StandardSetConfirmationStanding {
  const state: StandardSetConfirmationState = confirmation === null
    ? 'UNCONFIRMED'
    : confirmation.criteriaDigest === currentVersion.digest ? 'CONFIRMED' : 'STALE';
  return { state, confirmed: state === 'CONFIRMED', currentVersion, confirmation };
}

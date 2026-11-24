import { createHash } from 'node:crypto';
import {
  type ConfirmedCriterionReading,
  type CriteriaChangesSinceConfirmed,
  type CriteriaChangesSinceConfirmedAbsentReason,
  PROJECT_REOPEN_TOOL,
  type ProjectStartRecord,
  uuidToBase62,
} from '@orbit/shared';
import { classifyCriteriaEdit } from './criteria-edit-classification';

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

/** The next step every settled-project refusal names (docs/project-reopen-request-design.md §4.4): asking the account
 *  owner to reopen it with project_request_reopen, then retrying the refused write once the request is answered. */
export const REQUEST_REOPEN_NEXT_STEP =
  `To ask them, call ${PROJECT_REOPEN_TOOL} with the project id, why, and the work you plan to add, then retry ` +
  'this write once the request is answered.';

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
  /**
   * What the start this confirmation was part of left the project running with
   * (`started_with`), or null for a confirmation that started nothing — a re-confirmation, or one
   * made before starts recorded their settings. Only the confirmation read carries it: it is what
   * the receipt of a start says the project was started with, and whether a receipt says "started"
   * or "confirmed" at all.
   */
  startedWith?: ProjectStartRecord | null;
  /** The words stored with it (`criteria_wording`, 1200), or null on an older row. Only the
   *  confirmation read carries it, and the view turns it into `criteria` rather than publishing it. */
  criteriaWording?: ConfirmedCriterionWording[] | null;
  /** What it changed since the confirmation before it (`criteria_changes`, 1200): null when there
   *  was none before it, or on an older row. */
  changes?: CriteriaChangesSinceConfirmed | null;
  /** What each confirmed criterion said and whether it has moved since — the receipt's list,
   *  resolved by the view (`confirmedCriteriaReadings`). */
  criteria?: ConfirmedCriterionReading[];
  /** Whether the words were stored with it. False on a row older than 1200, whose `criteria` show
   *  today's words where the hash still matches and none where it does not. */
  wordingRecorded?: boolean;
}

/** One criterion's words as a confirmation stored them (`criteria_wording`). */
export interface ConfirmedCriterionWording {
  definitionId: string;
  ordinal: number;
  text: string;
  verificationMethod: string | null;
}

/** The words a confirmation of `stated` stores. */
export function criteriaWordingOf(stated: StatedAcceptanceCriterion[]): ConfirmedCriterionWording[] {
  return stated.map((criterion) => ({
    definitionId: criterion.definitionId,
    ordinal: criterion.ordinal,
    text: criterion.text,
    verificationMethod: criterion.verificationMethod,
  }));
}

/**
 * What each criterion of a recorded confirmation said, and whether it has moved since.
 *
 * The words are the stored ones. A row older than 1200 has none stored, so a criterion whose content
 * hash still matches the one confirmed shows its words today — the hash is the database's own over
 * the words and the method, so a match means the same words — and one that moved shows none, because
 * nothing kept them. Ordered as the confirmed set was; a criterion with no place left goes last.
 */
export function confirmedCriteriaReadings(
  confirmed: ConfirmedCriterionVersion[],
  wording: ConfirmedCriterionWording[] | null,
  stated: StatedAcceptanceCriterion[],
): ConfirmedCriterionReading[] {
  const now = new Map(stated.map((criterion) => [criterion.definitionId, criterion]));
  const words = new Map((wording ?? []).map((item) => [item.definitionId, item]));
  const readings = confirmed.map((item): ConfirmedCriterionReading => {
    const current = now.get(item.definitionId);
    const since = !current ? 'REMOVED' : current.contentHash === item.contentHash ? 'UNCHANGED' : 'EDITED';
    const stored = words.get(item.definitionId);
    const key = criterionKeyOf(item.definitionId);
    if (stored) {
      return { key, ordinal: stored.ordinal, text: stored.text, verificationMethod: stored.verificationMethod, since };
    }
    if (current && since === 'UNCHANGED') {
      return { key, ordinal: current.ordinal, text: current.text, verificationMethod: current.verificationMethod, since };
    }
    return { key, ordinal: current?.ordinal ?? null, text: null, verificationMethod: null, since };
  });
  return readings.sort((a, b) => (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER));
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

/**
 * The standing as `GET /projects/:id/acceptance/confirmation` reports it, and as its `POST`
 * answers: beside it, what changed since the confirmation it names — the "Confirm the new
 * criteria?" card's "What changed". Null, with the reason beside it, when nothing was ever
 * confirmed; all `unchanged` once the set that stands is confirmed.
 */
export interface StandardSetConfirmationView extends StandardSetConfirmationStanding {
  changesSinceConfirmed: CriteriaChangesSinceConfirmed | null;
  changesSinceConfirmedAbsentReason: CriteriaChangesSinceConfirmedAbsentReason | null;
}

/**
 * What changed since a confirmation, criterion by criterion, off the material it stored.
 *
 * Every criterion that stands now is matched to the version confirmed by its definition id: with no
 * match it is ADDED, and with the same `contentHash` it is unchanged. Both hashes are the
 * database's own — one on the row, one stored on the confirmation — so they are compared here and
 * never recomputed, which is the one thing this must not do: `project_acceptance_definition_content_hash`
 * hashes the words and the method together, and a TypeScript recipe would call every criterion
 * rewritten.
 *
 * A hash that moved is STRICTER when `classifyCriteriaEdit` calls going from the confirmed version
 * to this one a tightening — the judgement every edit is routed by, so this card and the write path
 * cannot disagree about which edits needed nobody. The confirmed version is in `confirmedMethods`:
 * for a criterion whose words are the ones confirmed and whose confirmed method was a rung of the
 * ladder, that rung, found by the database (`ProjectAcceptanceService`). That is the only shape a
 * tightening that landed on its own can have. Anything else that moved is `revised`.
 */
export function criteriaChangesSinceConfirmed(
  stated: StatedAcceptanceCriterion[],
  confirmed: ConfirmedCriterionVersion[],
  confirmedMethods: ReadonlyMap<string, string>,
): CriteriaChangesSinceConfirmed {
  const gone = new Map(confirmed.map((item) => [item.definitionId, item]));
  const changes: CriteriaChangesSinceConfirmed = {
    added: [], stricter: [], revised: [], removed: [], unchanged: [],
  };
  for (const criterion of stated) {
    const was = gone.get(criterion.definitionId);
    gone.delete(criterion.definitionId);
    const { key, ordinal, text, verificationMethod } = criterion;
    if (!was) {
      changes.added.push({ key, ordinal, text });
      continue;
    }
    if (was.contentHash === criterion.contentHash) {
      changes.unchanged.push(ordinal);
      continue;
    }
    const confirmedVerificationMethod = confirmedMethods.get(criterion.definitionId);
    if (
      confirmedVerificationMethod !== undefined
      && verificationMethod !== null
      && classifyCriteriaEdit(
        [{ id: criterion.definitionId, text, verificationMethod: confirmedVerificationMethod }],
        [{ id: criterion.definitionId, text, verificationMethod }],
      ) === 'ADDITIVE'
    ) {
      changes.stricter.push({ key, ordinal, verificationMethod, confirmedVerificationMethod });
      continue;
    }
    changes.revised.push({ key, ordinal, text });
  }
  changes.removed = [...gone.keys()].map(criterionKeyOf);
  return changes;
}

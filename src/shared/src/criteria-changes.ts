/**
 * What changed in a project's acceptance criteria since the account owner last confirmed them: the
 * "Confirm the new criteria?" card, drawn from `changesSinceConfirmed` on the apiserver's
 * `GET /projects/:id/acceptance/confirmation` (and on the answer to its `POST`).
 *
 * Two kinds of edit land without asking anybody, so a started project's criteria can move under
 * its confirmation: a criterion ADDED, and a criterion whose check is made STRICTER — its
 * verification method moved up the HUMAN → VERIFICATION → EXECUTABLE ladder, its words untouched.
 * Anything looser is held as a proposal the owner decides on its own card. So the card lists those
 * two kinds and numbers the rest.
 *
 * Every criterion that stands now is in exactly one of `added`, `stricter`, `revised` and
 * `unchanged`, and `removed` names the confirmed ones that no longer stand. `revised` and `removed`
 * are empty on the path the card was drawn for. They fill only when a proposal the owner approved
 * landed while the confirmation was already behind — approving carries a confirmation forward only
 * from the version it names — and a criterion changed that way is listed rather than counted as
 * unchanged.
 */

/** A criterion stated since the confirmation. */
export interface CriterionAddedSinceConfirmed {
  /** The criterion's own key, as `acceptanceCriteriaItems` spells it. */
  key: string;
  /** Where it stands in the list now, from 1. */
  ordinal: number;
  text: string;
}

/** A criterion whose words are the ones confirmed and whose check is stricter than the one that was. */
export interface CriterionStricterSinceConfirmed {
  key: string;
  ordinal: number;
  /** The check it has now. */
  verificationMethod: string;
  /** The check the owner confirmed — the card's "was: …". */
  confirmedVerificationMethod: string;
}

/** A criterion changed since the confirmation some other way: reworded, or its check rewritten or
 *  loosened, which only an approved proposal lands. */
export interface CriterionRevisedSinceConfirmed {
  key: string;
  ordinal: number;
  /** Its words now. */
  text: string;
}

export interface CriteriaChangesSinceConfirmed {
  added: CriterionAddedSinceConfirmed[];
  stricter: CriterionStricterSinceConfirmed[];
  revised: CriterionRevisedSinceConfirmed[];
  /** The keys of confirmed criteria that are no longer stated. */
  removed: string[];
  /** The ordinals of the criteria that read exactly as they were confirmed. */
  unchanged: number[];
}

/**
 * Why `changesSinceConfirmed` is null: nothing has ever been confirmed, so there is nothing to
 * compare with. Not a set with no changes — a project confirmed a moment ago has one of those.
 */
export type CriteriaChangesSinceConfirmedAbsentReason = 'NEVER_CONFIRMED';

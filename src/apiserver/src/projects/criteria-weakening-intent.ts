/**
 * What a LOOSENING edit to a project's acceptance criteria becomes instead of taking effect.
 *
 * The other half of "the ruler may only walk toward strictness on its own" is this one: an edit
 * `classifyCriteriaEdit` calls `WEAKENING` does not reach `replaceAcceptanceDefinitions` at all.
 * Nothing is written to the definitions, the seal does not move, and the criteria the caller was
 * working to are still the criteria the caller is working to. What IS written is a proposal — one
 * `project_ratified_action_intent` row (0195) — for the account owner to decide later.
 *
 * WHY THAT TABLE AND NOT A NEW ONE
 * --------------------------------
 * It already holds exactly the four things a held proposal needs and had no application writer:
 * `action`/`action_digest` for what is being asked, `commit_token` for the one-time key the
 * decision needs, `UNIQUE(owner_id, project_id, idempotency_key)`, and a BEFORE UPDATE OR DELETE
 * trigger that makes a filed proposal unrewritable — which is the point, since the party proposing
 * a looser ruler is the party that must not be able to edit the proposal after it is read.
 *
 * The `Approval` table was considered and is the wrong table: it has no project, no action and no
 * digest column, so it can record that somebody said yes but not WHAT they said yes to.
 *
 * WHAT THE DIGEST IS TAKEN OVER, AND WHY IT IS ONLY THAT
 * -----------------------------------------------------
 * `actionDigest = sha256(canonicalJson(action.request))` — the REQUEST and nothing else. The row
 * also carries the baseline it was composed against and, when it displaced one, the proposal it
 * displaced; neither is in the digest, because the digest answers "is this the same thing being
 * asked for" and a reader has to be able to recompute it from the request alone. `action.request`
 * therefore holds only values derivable from what the caller sent: a criterion the caller RETAINED
 * appears under its own id, and a criterion the caller ADDED appears with `id: null`, because the
 * id such a criterion would get is a fresh uuid the request never named.
 *
 * WHY THE COMMIT TOKEN IS NOT IN THE RESPONSE
 * -------------------------------------------
 * The proposer gets the proposal's id — an address, so it can say which proposal it filed and read
 * the answer later. It does not get `commitToken`: that is the second key, and handing both to the
 * party asking for a looser ruler would make the decision a formality it can perform on itself.
 */
import { canonicalJson } from './canonical-json';
import { type ConfirmedCriterionVersion, sha256 } from './project-acceptance';

/**
 * `effect_class` for every proposal this file describes, and the predicate that finds them again.
 * The column is free text on a table that has no other application writer; this constant is what
 * makes "the weakening proposals of this project" a set rather than a convention.
 */
export const CRITERIA_WEAKENING_EFFECT_CLASS = 'PROJECT_CRITERIA_WEAKENING';

/** One criterion as the request states it. `id` is null for one the request is adding. */
export interface ProposedCriterion {
  id: string | null;
  ordinal: number;
  text: string;
  verificationMethod: string;
  completionCriterionOverrideReason: string | null;
}

/** Exactly what the caller asked for — the whole of what `actionDigest` is taken over. */
export interface CriteriaWeakeningRequest {
  kind: typeof CRITERIA_WEAKENING_EFFECT_CLASS;
  projectId: string;
  proposed: ProposedCriterion[];
}

/** The standard set the proposal was composed against, which is also the one still in force. */
export interface CriteriaWeakeningBaseline {
  seal: string;
  material: ConfirmedCriterionVersion[];
}

/** The proposal this one displaced, and why it was displaced. */
export interface CriteriaWeakeningSupersession {
  intentId: string;
  actionDigest: string;
  reason: string;
}

/** The `action` JSONB of a held proposal. */
export interface CriteriaWeakeningAction {
  request: CriteriaWeakeningRequest;
  baseline: CriteriaWeakeningBaseline;
  /** Null when this proposal displaced nothing — the project had no pending one. */
  supersedes: CriteriaWeakeningSupersession | null;
}

/** What the caller asked for, in the shape the digest is taken over. */
export function criteriaWeakeningRequest(
  projectId: string,
  proposed: readonly ProposedCriterion[],
): CriteriaWeakeningRequest {
  return { kind: CRITERIA_WEAKENING_EFFECT_CLASS, projectId, proposed: [...proposed] };
}

/** The identity of a proposal: recomputable by anyone holding the request that made it. */
export function criteriaWeakeningActionDigest(request: CriteriaWeakeningRequest): string {
  return sha256(canonicalJson(request));
}

/**
 * Why a pending proposal stopped being pending.
 *
 * Composed here rather than asked of the caller: the caller cannot know this better than the
 * server does, and a reason field on the write path would be a field every existing client would
 * have to learn to send before it could propose anything at all. It names the digest of what
 * replaced it, so a reader of the displaced proposal can see that the ask actually changed rather
 * than being told only that it is stale.
 */
export function criteriaWeakeningSupersessionReason(replacementDigest: string): string {
  return 'a later weakening edit to the same project replaced this proposal with '
    + `${replacementDigest}: a project holds at most one pending criteria proposal, so the newest `
    + 'statement of what the owner is being asked to approve is the one that stands';
}

/**
 * What the caller is told, in the response to the very write that was held.
 *
 * It has to say three things, because a caller that reads only "200" will otherwise go on working
 * to criteria that were never adopted: the edit did NOT take effect, the criteria in this same
 * response are the ones in force, and there is a proposal on record to point at.
 *
 * It does NOT say the edit made anything easier, which would be a claim the classification cannot
 * support: most held edits are held because their direction cannot be read, not because a
 * loosening was demonstrated. Telling an author their rewording "loosened the ruler" would be
 * telling them something false about their own words.
 */
export function criteriaUnchangedNotice(intentId: string): string {
  return 'This edit was NOT applied, because it is not one that plainly tightens the ruler: an '
    + 'edit that drops a criterion, or whose direction cannot be read at all, is held rather than '
    + 'applied. The project\'s stated criteria are therefore unchanged — the ones in this '
    + 'response are the ones already on record and the ones still in force, and work should go on '
    + `being judged against them. The edit is on record as proposal ${intentId} for the account `
    + 'owner to decide; nothing about the criteria moves unless and until they decide it.';
}

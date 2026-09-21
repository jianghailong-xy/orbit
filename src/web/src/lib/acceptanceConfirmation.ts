import { api } from '../api';

/**
 * The account owner's confirmation of a project's stated criteria, as the browser reads and writes
 * it — `GET` and `POST /projects/:id/acceptance/confirmation`.
 *
 * The browser asks it in one place, the settlement card drawn into the project's coordinator
 * conversation (`AcceptanceConfirmationCard.tsx`). The project page's criteria card carried a
 * second confirmation region until the account owner removed it on 2026-09-11; these reads and the
 * write were already out here, so that removal took nothing from the conversation's card.
 */

/** One criterion as a confirmation names it: the three values the set's digest is taken over.
 *  Carried so a recorded confirmation can say WHICH version it was about without recomputing it. */
export interface ConfirmedCriterionVersion {
  definitionId: string;
  revision: number;
  contentHash: string;
}

/** A version of the whole stated set: `digest` answers "is it still this one", `material` answers
 *  "which one was it". */
export interface StandardSetVersion {
  digest: string;
  material: ConfirmedCriterionVersion[];
}

/** One recorded exercise of `CONFIRM_ACCEPTANCE_CRITERIA`. `confirmedAt` arrives as JSON, so it is
 *  a string here whatever the column is. */
export interface RecordedStandardSetConfirmation {
  criteriaDigest: string;
  criteriaMaterial: ConfirmedCriterionVersion[];
  confirmedAt: string;
  confirmedById: string;
}

/**
 * `GET /projects/:id/acceptance/confirmation`, as the server reports it.
 *
 * Three states rather than a boolean because "nobody ever said this" and "somebody said it about
 * wording that has since changed" are different things to show, and only the second has a version
 * to print. The comparison is made by the server at read time out of two stored facts, so a
 * surface renders a standing rather than deciding one.
 */
export interface StandardSetConfirmationStanding {
  state: 'UNCONFIRMED' | 'CONFIRMED' | 'STALE';
  confirmed: boolean;
  currentVersion: StandardSetVersion;
  confirmation: RecordedStandardSetConfirmation | null;
}

/** Kept off `['project', id]` on purpose: the standing is a second document with its own
 *  lifetime, and a confirmation must be able to refresh without re-reading the whole project. */
export const acceptanceConfirmationKey = (projectId: string) =>
  ['project', projectId, 'acceptance-confirmation'] as const;

const confirmationPath = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/acceptance/confirmation`;

export const readAcceptanceConfirmation = (
  projectId: string,
): Promise<StandardSetConfirmationStanding> =>
  api<StandardSetConfirmationStanding>(confirmationPath(projectId));

/** The read as a query, for the TWO readers of it: the card that asks the question
 *  (`AcceptanceConfirmationCard.tsx`) and the conversation that draws the record of the answer
 *  where it happened (`WorkspaceView.tsx`'s `decisionReceipts`). One key between them, so a press
 *  at this door draws the record without a second request, and a confirmation made at another end
 *  arrives at both together.
 *
 *  Both poll: the door is written by a person at either end, and no push stream mentions it. */
export const acceptanceConfirmationQuery = (projectId: string) => ({
  queryKey: acceptanceConfirmationKey(projectId),
  queryFn: () => readAcceptanceConfirmation(projectId),
  refetchInterval: 20_000,
});

/** The write. The digest is REQUIRED by the door and is the whole point of it: without naming a
 *  version, "confirm the criteria" would mean "confirm whatever they say when this request
 *  lands", and an edit arriving between the render and the click would be signed unread. */
export const confirmAcceptanceCriteria = (
  projectId: string,
  criteriaDigest: string,
): Promise<StandardSetConfirmationStanding> =>
  api<StandardSetConfirmationStanding>(confirmationPath(projectId), {
    method: 'POST',
    body: { criteriaDigest },
  });

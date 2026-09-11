import { api } from '../api';

/**
 * The account owner's confirmation of a project's stated criteria, as the browser reads and writes
 * it — `GET` and `POST /projects/:id/acceptance/confirmation`.
 *
 * In a module of its own because more than one surface asks the same question: the confirmation
 * region under a project page's criteria (`ProjectAcceptanceCard.tsx`) and the settlement card
 * drawn into that project's coordinator conversation (`AcceptanceConfirmationCard.tsx`). They share
 * this key, so a confirmation pressed on either redraws the other from the door's answer — and
 * neither surface's lifetime decides whether the other can still reach the door.
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

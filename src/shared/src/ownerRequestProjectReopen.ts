/**
 * Owner request kind PROJECT_REOPEN (docs/project-reopen-request-design.md §4): a session whose write was refused because
 * its project is DONE or CANCELLED asks the account owner to reopen it. The request grants nothing; the owner's Reopen on
 * the card is the same press as the project page's.
 *
 * These are the shapes the server answers with and the clients read: the body of POST /runner/projects/:id/reopen-requests,
 * the `payload` a PROJECT_REOPEN request carries (GET /owner-requests), the `askers` beside it, and the codes its doors
 * refuse with.
 */

export const PROJECT_REOPEN_KIND = 'PROJECT_REOPEN';

/** The MCP tool an agent asks with; every settled-project refusal names it as the next step. */
export const PROJECT_REOPEN_TOOL = 'project_request_reopen';

/** The longest `why` and `plannedWork` a filing may carry, each. */
export const MAX_PROJECT_REOPEN_TEXT = 2_000;

/** The project is OPEN already: nothing to ask, retry the write. */
export const PROJECT_ALREADY_OPEN = 'PROJECT_ALREADY_OPEN';
/** This session asked to reopen this project since it was settled, and the owner declined. */
export const REOPEN_REQUEST_DECLINED = 'REOPEN_REQUEST_DECLINED';
/** POST /owner-requests/:id/reopen-project carrying an acting session: only the owner, signed in, reopens. */
export const REOPEN_OWNER_CHANNEL_ONLY = 'REOPEN_OWNER_CHANNEL_ONLY';

/** The settled states a project can be asked to reopen from. */
export type ProjectReopenSettledStatus = 'DONE' | 'CANCELLED';

/** The body of POST /runner/projects/:id/reopen-requests. */
export interface ProjectReopenFiling {
  why: string;
  plannedWork: string;
}

/** One session that asked. The first is the request's `askedBySessionId`; later ones joined the waiting card. */
export interface ProjectReopenAsker {
  sessionId: string;
  askedAt: string;
}

/** `owner_request.payload` of a PROJECT_REOPEN, written by the server when the request is filed. */
export interface ProjectReopenPayload {
  projectId: string;
  /** The project's status when it was first asked. */
  statusAtAsk: ProjectReopenSettledStatus;
  /** When the project was settled, as the server records it: `done_at` for DONE, the row's last write for CANCELLED. */
  settledAt: string;
  /** The work the agent plans to add once it is reopened, in the agent's words. */
  plannedWork: string;
  /** Every session that asked, in the order they asked. */
  askers: ProjectReopenAsker[];
}

/** An asker as GET /owner-requests reads it: with the session's title, which the card names ("Also asked by …"). */
export interface ProjectReopenAskerView extends ProjectReopenAsker {
  title: string | null;
}

/** What the filing route answers beyond the request itself: `alreadyOpen` when this asker joined a waiting card. */
export interface ProjectReopenFiled {
  alreadyOpen: boolean;
}

/** The notes a PROJECT_REOPEN ends with when nobody answered it on its card. */
export const PROJECT_REOPEN_NOTES = {
  /** The owner answered Reopen on a card while the project was already OPEN. */
  alreadyReopened: 'Already reopened',
  /** The owner pressed Reopen on the project page. */
  reopenedFromPage: 'Reopened from the project page',
  /** The project was deleted while the request waited. */
  projectDeleted: 'The project was deleted',
} as const;

/** The card's title, which the server writes. */
export function projectReopenTitle(projectTitle: string): string {
  return `Reopen project “${projectTitle}”?`;
}

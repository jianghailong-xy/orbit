/**
 * Owner rulings as project records (docs/coordinator-handoff-v2-design.md §2, migration 0970).
 *
 * A ruling is what the owner told a coordinator: one sentence, the owner's own words, and where they
 * were said. An answered ask_owner question becomes one automatically (`ASK_OWNER`); a coordinator
 * records a ruling given in chat with `project_ruling_record` (`TURN`), refused unless the quote is in
 * that turn's owner text. A later ruling supersedes an earlier one, which is kept and marked.
 *
 * Rulings are not acceptance criteria and change nothing the platform enforces.
 *
 * ENDPOINT (runner token + X-Orbit-Session-Id of the project's coordinator):
 *   POST /runner/projects/:id/rulings  { ruling, quote, sourceTurnId, supersedes? } → ProjectRulingView
 *
 * `project_get` (and GET /projects/:id) carries the live rulings as `rulings`, oldest first.
 */

export type ProjectRulingSourceKind = 'ASK_OWNER' | 'TURN';

export interface ProjectRulingView {
  id: string;
  projectId: string;
  /** The ruling in one sentence. */
  ruling: string;
  /** The owner's own words. */
  quote: string;
  sourceKind: ProjectRulingSourceKind;
  /** The answered question's open item (ASK_OWNER) or the conversation turn (TURN). */
  sourceId: string;
  /** The coordinator that recorded it; null for an automatic ruling. */
  recordedBySessionId: string | null;
  /** The ruling that replaced this one; null while it is live. */
  supersededById: string | null;
  createdAt: string;
}

/** Limits the record door holds a ruling to. */
export const PROJECT_RULING_LIMITS = {
  rulingMaxChars: 500,
  quoteMaxChars: 2000,
  /** A quote shorter than this proves nothing about where it came from. */
  quoteMinChars: 4,
} as const;

/** Refusal codes of `project_ruling_record`. */
export const PROJECT_RULING_COORDINATOR_ONLY = 'PROJECT_RULING_COORDINATOR_ONLY';
export const PROJECT_RULING_QUOTE_NOT_FOUND = 'PROJECT_RULING_QUOTE_NOT_FOUND';
export const PROJECT_RULING_TURN_NOT_FOUND = 'PROJECT_RULING_TURN_NOT_FOUND';
export const PROJECT_RULING_SUPERSEDES_NOT_LIVE = 'PROJECT_RULING_SUPERSEDES_NOT_LIVE';

/** The project page's words for its rulings list. */
export const PROJECT_RULING_COPY = {
  title: 'Owner rulings',
  fromQuestion: 'From an answered question',
  fromConversation: 'From the coordinator conversation',
} as const;

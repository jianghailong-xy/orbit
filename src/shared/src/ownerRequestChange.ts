/**
 * Owner request kind CHANGE (docs/design/owner-request-change.md): an agent proposes one setting of one of the owner's
 * runners, and the owner applies it with one press. v1 covers a runner's Max Concurrent only (decision 2); later
 * settings join `OWNER_REQUEST_CHANGE_FIELDS` one at a time.
 *
 * These are the shapes the server answers with and the clients read: `changeSpec` on a request (GET /owner-requests),
 * the body of POST /owner-requests/:id/apply, the `answer` an applied request ends with, and the `change` a
 * resolution turn carries to the agent.
 */

export const OWNER_REQUEST_CHANGE_KIND = 'CHANGE';

/** The settings a CHANGE may name. */
export const OWNER_REQUEST_CHANGE_FIELDS = ['maxConcurrent'] as const;
export type OwnerRequestChangeField = (typeof OWNER_REQUEST_CHANGE_FIELDS)[number];

/** A filing that asks for the value the setting already has: refused, so no card ever changes nothing. */
export const OWNER_REQUEST_CHANGE_NOOP = 'OWNER_REQUEST_CHANGE_NOOP';

/** The note an older pending CHANGE for the same runner setting is withdrawn with when a newer one is filed. */
export const OWNER_REQUEST_CHANGE_REPLACED_NOTE = 'Replaced by a newer request';

/** What an agent files as `change` (request_owner_action, POST /runner/owner-requests). */
export interface OwnerRequestChangeFiling {
  runnerId: string;
  maxConcurrent: number;
}

/** `owner_request.change_spec`, written by the server when the request is filed. `before` is the value then. */
export interface OwnerRequestChangeSpec {
  runnerId: string;
  field: OwnerRequestChangeField;
  requested: number;
  before: number;
}

/** The body of POST /owner-requests/:id/apply: the value the owner applies, the requested one or one they typed. */
export interface ApplyOwnerRequestChangeBody {
  maxConcurrent: number;
}

/** An applied CHANGE's `answer`: the value written, and the value it replaced at that moment. */
export interface OwnerRequestChangeAnswer {
  applied: number;
  actualBefore: number;
}

/**
 * The `change` a resolution turn carries. `applied` and `actualBefore` only when the owner applied it (DONE); the agent
 * reads `applied`, not `requested`, because the owner may have chosen another number.
 */
export interface OwnerRequestChangeOutcome {
  runnerId: string;
  field: OwnerRequestChangeField;
  requested: number;
  applied?: number;
  before: number;
  actualBefore?: number;
}

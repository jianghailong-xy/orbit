/**
 * The recovery contract: one envelope that says, for any failed (or advised) call, what happened to
 * the write and what the caller may do next — read by the MCP server, the CLI and the web from the
 * same stable fields. Transcribed from `contracts/recovery.contract.json`, which stays the authority;
 * the vectors in `contracts/recovery.fixtures.json` are what this parser and the Go one in
 * `src/runner-go/recovery.go` are both held to. See docs/recovery-contract.md.
 *
 * Two rules the whole file keeps:
 *
 * - The recovery branch is decided by stable fields only — `code`, the status, the server's
 *   `recovery` block, `retryable`, `advisory`/`kind`, `owner`, the retry hints. `message` and a prose
 *   `requiredAction` are carried through for people and never read for a decision.
 * - The server names a semantic `actionCode` (`AWAIT_OWNER_DECISION`), never an MCP tool or a CLI
 *   command: which tool or command carries that action out is each client's own mapping.
 */

export const RECOVERY_CONTRACT_VERSION = 1 as const;

export const RECOVERY_KINDS = ['REFUSAL', 'ADVISORY', 'VALIDATION', 'TRANSPORT', 'UNKNOWN'] as const;
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

/** What the request did to stored state: nothing, a write that stands, or nobody can tell. */
export const RECOVERY_EFFECTS = ['NONE', 'COMMITTED', 'UNKNOWN'] as const;
export type RecoveryEffect = (typeof RECOVERY_EFFECTS)[number];

/**
 * When the identical request may be sent again.
 *
 * - SAFE: now (after `afterSeconds` when there is one); nothing was written.
 * - SAME_REQUEST_ID: only under the same request id, which reads the first answer back instead of
 *   applying it twice.
 * - VERIFY_THEN_RETRY: the outcome is unknown and no id protects a resend — read the state first.
 * - AFTER_STATE_CHANGE: the same answer comes back until something outside the request changes
 *   (a person decides, a credential is renewed, a dependency lands).
 * - NEVER: as sent, this request is never accepted — or was already accepted; change it, don't resend.
 */
export const RECOVERY_RETRY_POLICIES = ['SAFE', 'SAME_REQUEST_ID', 'VERIFY_THEN_RETRY', 'AFTER_STATE_CHANGE', 'NEVER'] as const;
export type RecoveryRetryPolicy = (typeof RECOVERY_RETRY_POLICIES)[number];

/** Who has to act to clear it. CALLER is whoever sent the request. */
export const RECOVERY_ACTORS = ['CALLER', 'COORDINATOR', 'USER', 'SYSTEM'] as const;
export type RecoveryActor = (typeof RECOVERY_ACTORS)[number];

export const RECOVERY_USER_CONFIRMATIONS = ['REQUIRED', 'NOT_REQUIRED'] as const;
export type RecoveryUserConfirmation = (typeof RECOVERY_USER_CONFIRMATIONS)[number];

/** An action code is a token, never a tool name (`task_update`) or a command (`orbit task ...`). */
export const RECOVERY_ACTION_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** The semantic recovery actions the contract defines. Unknown tokens pass through unchanged. */
export const RECOVERY_ACTION_CODES = [
  'RETRY',
  'RETRY_SAME_REQUEST',
  'VERIFY_STATE',
  'FIX_REQUEST',
  'USE_NEW_REQUEST_ID',
  'ANSWER_ADVICE',
  'AWAIT_OWNER_DECISION',
  'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF',
] as const;

export const RECOVERY_DEFAULT_ACTION_BY_POLICY: Record<RecoveryRetryPolicy, string | null> = {
  SAFE: 'RETRY',
  SAME_REQUEST_ID: 'RETRY_SAME_REQUEST',
  VERIFY_THEN_RETRY: 'VERIFY_STATE',
  AFTER_STATE_CHANGE: null,
  NEVER: 'FIX_REQUEST',
};

export interface RecoveryResource {
  type: string;
  id: string;
}

export interface RecoveryEnvelope {
  contractVersion: typeof RECOVERY_CONTRACT_VERSION;
  /** Stable UPPER_SNAKE code: the server's own, or `HTTP_<status>`, `LOCAL_*`, `TRANSPORT_NO_ANSWER`, `UNKNOWN_ERROR`. */
  code: string;
  /** For people. Never branched on. */
  message: string;
  kind: RecoveryKind;
  /** The HTTP status, when an answer arrived. */
  status: number | null;
  effect: RecoveryEffect;
  retry: { policy: RecoveryRetryPolicy; afterSeconds: number | null };
  actor: RecoveryActor;
  /** The legacy `owner` field, verbatim. */
  owner: string | null;
  actionCode: string | null;
  /** The legacy `requiredAction` field, verbatim: a token or a sentence. */
  requiredAction: string | null;
  userConfirmation: RecoveryUserConfirmation;
  resources: RecoveryResource[];
}

/** What the server may state outright in a body's `recovery` block. Every field is optional. */
export interface RecoveryServerBlock {
  effect?: RecoveryEffect;
  retryPolicy?: RecoveryRetryPolicy;
  retryAfterSeconds?: number;
  actionCode?: string;
  actor?: RecoveryActor;
  userConfirmation?: RecoveryUserConfirmation;
  resources?: RecoveryResource[];
}

/** One failure as a client met it, before it is read. */
export type RecoveryObservation =
  | { source: 'HTTP'; status: number; headers?: Record<string, string>; body: string; requestIdSent?: boolean }
  | { source: 'NETWORK'; message: string; requestIdSent?: boolean }
  | { source: 'LOCAL'; code: string; message: string; resources?: RecoveryResource[] }
  | { source: 'UNKNOWN'; message: string; requestIdSent?: boolean };

interface LegacyCodeRecovery {
  retryPolicy: RecoveryRetryPolicy;
  effect: RecoveryEffect;
  actionCode?: string;
  actor?: RecoveryActor;
  userConfirmation?: RecoveryUserConfirmation;
}

/** Codes served before the `recovery` block existed, keyed on the code alone (contract `legacyCodes`). */
export const RECOVERY_LEGACY_CODES: Record<string, LegacyCodeRecovery> = {
  TASK_RUN_REQUEST_IN_PROGRESS: { retryPolicy: 'SAME_REQUEST_ID', effect: 'NONE' },
  TASK_RUN_REQUEST_UNREADABLE: { retryPolicy: 'SAME_REQUEST_ID', effect: 'NONE' },
  TASK_RUN_REQUEST_MISMATCH: { retryPolicy: 'NEVER', effect: 'NONE', actionCode: 'USE_NEW_REQUEST_ID' },
  TRANSIENT_DB_CONFLICT: { retryPolicy: 'SAFE', effect: 'NONE' },
  DATABASE_UNAVAILABLE: { retryPolicy: 'SAFE', effect: 'NONE' },
  CROSS_PROJECT_APPROVAL_REQUIRED: {
    retryPolicy: 'AFTER_STATE_CHANGE', effect: 'NONE', actionCode: 'AWAIT_OWNER_DECISION', actor: 'USER', userConfirmation: 'REQUIRED',
  },
  APPROVAL_PENDING: {
    retryPolicy: 'AFTER_STATE_CHANGE', effect: 'NONE', actionCode: 'AWAIT_OWNER_DECISION', actor: 'USER', userConfirmation: 'REQUIRED',
  },
  TASK_CRITERION_SHAPE_ADVICE: { retryPolicy: 'NEVER', effect: 'NONE', actionCode: 'ANSWER_ADVICE' },
};

export const RECOVERY_LEGACY_OWNER_TO_ACTOR: Record<string, RecoveryActor> = {
  USER: 'USER',
  COORDINATOR: 'COORDINATOR',
  SYSTEM: 'SYSTEM',
};

export const RECOVERY_LEGACY_RESOURCE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['taskId', 'TASK'],
  ['sessionId', 'SESSION'],
  ['projectId', 'PROJECT'],
  ['crossingId', 'CROSSING'],
  ['triggerId', 'REQUEST'],
];

export const RECOVERY_STATUS_SAFE: readonly number[] = [408, 429];
export const RECOVERY_STATUS_AFTER_STATE_CHANGE: readonly number[] = [401, 403, 409, 412, 423, 424, 428];

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const oneOf = <T extends string>(values: readonly T[], v: unknown): T | null =>
  typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : null;
const seconds = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.ceil(v) : null;
const millisToSeconds = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.ceil(v / 1000) : null;
const headerDigits = (v: string | undefined): number | null => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

function parseBody(raw: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validResources(v: unknown): RecoveryResource[] | null {
  if (!Array.isArray(v)) return null;
  const out: RecoveryResource[] = [];
  for (const r of v) {
    if (!isObject(r) || !nonEmpty(r.type) || !nonEmpty(r.id)) return null;
    out.push({ type: r.type as string, id: r.id as string });
  }
  return out;
}

function actionCodeOf(v: unknown): string | null {
  return typeof v === 'string' && RECOVERY_ACTION_CODE_PATTERN.test(v) ? v : null;
}

/**
 * What carrying an action out can do (contract `actionCodes[*]`). `automaticRetry`: it sends the identical
 * request again with nobody in between. `mayWrite`: it can end in another write at all — a resend, a changed
 * request, a request under a new id, or one sent after a decision. Only an action that reads and nothing else
 * has `mayWrite: false`; a token not in this registry counts as `mayWrite: true`.
 */
export const RECOVERY_ACTION_SEMANTICS: Record<string, { automaticRetry: boolean; mayWrite: boolean }> = {
  RETRY: { automaticRetry: true, mayWrite: true },
  RETRY_SAME_REQUEST: { automaticRetry: true, mayWrite: true },
  VERIFY_STATE: { automaticRetry: false, mayWrite: false },
  FIX_REQUEST: { automaticRetry: false, mayWrite: true },
  USE_NEW_REQUEST_ID: { automaticRetry: false, mayWrite: true },
  ANSWER_ADVICE: { automaticRetry: false, mayWrite: true },
  AWAIT_OWNER_DECISION: { automaticRetry: false, mayWrite: true },
  FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF: { automaticRetry: false, mayWrite: true },
};

/** The actions that resend the identical request with nobody in between. */
export const RECOVERY_AUTOMATIC_RETRY_ACTION_CODES: readonly string[] = ['RETRY', 'RETRY_SAME_REQUEST'];

/** The only actions a COMMITTED envelope may carry: they read, and never lead to another write. */
export const RECOVERY_READ_ONLY_ACTION_CODES: readonly string[] = ['VERIFY_STATE'];

/** The resource type that names a request id the server can read an earlier answer back by. */
export const RECOVERY_REQUEST_ID_RESOURCE_TYPE = 'REQUEST';

/** What the parser resolved from the fields, before the cross-field invariants are applied. */
export interface RecoveryCandidate {
  effect: RecoveryEffect;
  policy: RecoveryRetryPolicy;
  /** The stated action code (server block, legacy table, or a token requiredAction); null when none was stated. */
  actionCode: string | null;
  afterSeconds: number | null;
  userConfirmation: RecoveryUserConfirmation;
  /** Whether a request id that reads the first answer back provably exists: one was sent, or the answer names one. */
  hasRequestId: boolean;
  /** A 2xx answer: a result, never given a default action. */
  success: boolean;
}

/**
 * The cross-field invariants every envelope keeps, whatever the fields said one by one
 * (contract `invariants`). Each field may be stated or inferred on its own; their combination must never
 * advise a resend that could apply a write twice. So, in this order:
 *
 * 1. UNKNOWN: nobody can tell whether it was written. SAME_REQUEST_ID is kept only when it was the policy
 *    and a request id provably exists; everything else becomes VERIFY_THEN_RETRY. The action is the
 *    policy's own (VERIFY_STATE or RETRY_SAME_REQUEST).
 * 2. SAME_REQUEST_ID without a provable request id becomes VERIFY_THEN_RETRY.
 * 3. userConfirmation REQUIRED: no automatic retry. SAFE and SAME_REQUEST_ID become AFTER_STATE_CHANGE
 *    (VERIFY_THEN_RETRY when the effect is UNKNOWN), and an automatic-retry action becomes AWAIT_OWNER_DECISION.
 * 4. An automatic-retry action that does not match the final policy is dropped, then the policy's default
 *    fills an empty action (never for a 2xx).
 * 5. NEVER carries no wait.
 * 6. COMMITTED is final: the write stands, so the policy is NEVER, there is no wait, and the action is kept
 *    only if it is read-only (VERIFY_STATE) — every action that may lead to another write is removed,
 *    whichever step above produced it.
 *
 * SAFE is therefore only ever left standing on effect NONE.
 */
export function normalizeRecovery(c: RecoveryCandidate): { policy: RecoveryRetryPolicy; actionCode: string | null; afterSeconds: number | null } {
  let { policy, actionCode } = c;
  if (c.effect === 'UNKNOWN') {
    policy = policy === 'SAME_REQUEST_ID' && c.hasRequestId ? 'SAME_REQUEST_ID' : 'VERIFY_THEN_RETRY';
  } else if (policy === 'SAME_REQUEST_ID' && !c.hasRequestId) {
    policy = 'VERIFY_THEN_RETRY';
  }
  const confirm = c.userConfirmation === 'REQUIRED';
  if (confirm && (policy === 'SAFE' || policy === 'SAME_REQUEST_ID')) {
    policy = c.effect === 'UNKNOWN' ? 'VERIFY_THEN_RETRY' : 'AFTER_STATE_CHANGE';
  }
  if (c.effect === 'UNKNOWN') {
    actionCode = RECOVERY_DEFAULT_ACTION_BY_POLICY[policy];
  } else {
    if (actionCode !== null && RECOVERY_AUTOMATIC_RETRY_ACTION_CODES.includes(actionCode)) {
      if (confirm) actionCode = 'AWAIT_OWNER_DECISION';
      else if (actionCode !== RECOVERY_DEFAULT_ACTION_BY_POLICY[policy]) actionCode = null;
    }
    if (actionCode === null && !c.success) {
      actionCode = RECOVERY_DEFAULT_ACTION_BY_POLICY[policy] ?? (confirm ? 'AWAIT_OWNER_DECISION' : null);
    }
  }
  let afterSeconds = policy === 'NEVER' ? null : c.afterSeconds;
  if (c.effect === 'COMMITTED') {
    policy = 'NEVER';
    afterSeconds = null;
    if (actionCode !== null && !RECOVERY_READ_ONLY_ACTION_CODES.includes(actionCode)) actionCode = null;
  }
  return { policy, actionCode, afterSeconds };
}

interface EnvelopeFields {
  code: string;
  message: string;
  kind: RecoveryKind;
  status?: number | null;
  effect: RecoveryEffect;
  policy: RecoveryRetryPolicy;
  actionCode?: string | null;
  afterSeconds?: number | null;
  actor?: RecoveryActor;
  owner?: string | null;
  requiredAction?: string | null;
  userConfirmation?: RecoveryUserConfirmation;
  resources?: RecoveryResource[];
  requestIdSent?: boolean;
  success?: boolean;
}

function base(f: EnvelopeFields): RecoveryEnvelope {
  const resources = f.resources ?? [];
  const userConfirmation = f.userConfirmation ?? 'NOT_REQUIRED';
  const normalized = normalizeRecovery({
    effect: f.effect,
    policy: f.policy,
    actionCode: f.actionCode ?? null,
    afterSeconds: f.afterSeconds ?? null,
    userConfirmation,
    hasRequestId: f.requestIdSent === true || resources.some((r) => r.type === RECOVERY_REQUEST_ID_RESOURCE_TYPE),
    success: f.success === true,
  });
  return {
    contractVersion: RECOVERY_CONTRACT_VERSION,
    code: f.code,
    message: f.message,
    kind: f.kind,
    status: f.status ?? null,
    effect: f.effect,
    retry: { policy: normalized.policy, afterSeconds: normalized.afterSeconds },
    actor: f.actor ?? 'CALLER',
    owner: f.owner ?? null,
    actionCode: normalized.actionCode,
    requiredAction: f.requiredAction ?? null,
    userConfirmation,
    resources,
  };
}

/**
 * Read one failure into the envelope. Returns null only for a successful HTTP answer that carries no
 * `recovery` block — that is a result, not something to recover from.
 */
export function parseRecovery(obs: RecoveryObservation): RecoveryEnvelope | null {
  switch (obs.source) {
    case 'LOCAL': {
      const code = obs.code.startsWith('LOCAL_') ? obs.code : `LOCAL_${obs.code}`;
      return base({
        code, message: obs.message, kind: 'VALIDATION', effect: 'NONE', policy: 'NEVER', resources: obs.resources ?? [],
      });
    }
    case 'NETWORK':
    case 'UNKNOWN':
      return base({
        code: obs.source === 'NETWORK' ? 'TRANSPORT_NO_ANSWER' : 'UNKNOWN_ERROR',
        message: obs.message,
        kind: obs.source === 'NETWORK' ? 'TRANSPORT' : 'UNKNOWN',
        effect: 'UNKNOWN',
        policy: obs.requestIdSent ? 'SAME_REQUEST_ID' : 'VERIFY_THEN_RETRY',
        requestIdSent: obs.requestIdSent,
      });
    case 'HTTP':
      return parseHttp(obs);
  }
}

function parseHttp(obs: Extract<RecoveryObservation, { source: 'HTTP' }>): RecoveryEnvelope | null {
  const { status } = obs;
  const body = parseBody(obs.body);
  const success = status >= 200 && status < 300;
  const stated = isObject(body?.recovery) ? (body!.recovery as JsonObject) : null;
  if (success && !stated) return null;

  const serverCode = nonEmpty(body?.code);
  const code = serverCode ?? `HTTP_${status}`;
  let message = `HTTP ${status}`;
  if (typeof body?.message === 'string' && body.message !== '') message = body.message;
  else if (Array.isArray(body?.message) && body!.message.every((m) => typeof m === 'string') && body!.message.length > 0) {
    message = (body!.message as string[]).join('; ');
  }
  const advisory = body?.advisory === true || body?.kind === 'ADVISORY';
  let kind: RecoveryKind;
  if (advisory || success) kind = 'ADVISORY';
  else if (serverCode) kind = 'REFUSAL';
  else if (body && (status === 400 || status === 422)) kind = 'VALIDATION';
  else kind = 'TRANSPORT';

  const legacy = serverCode ? RECOVERY_LEGACY_CODES[serverCode] : undefined;
  const retryable = body?.retryable;

  let policy = oneOf(RECOVERY_RETRY_POLICIES, stated?.retryPolicy) ?? legacy?.retryPolicy ?? null;
  if (!policy) {
    if (success) policy = 'NEVER';
    else if (retryable === true) policy = 'SAFE';
    else if (advisory) policy = 'NEVER';
    else if (RECOVERY_STATUS_SAFE.includes(status)) policy = 'SAFE';
    else if (RECOVERY_STATUS_AFTER_STATE_CHANGE.includes(status)) policy = 'AFTER_STATE_CHANGE';
    else if (status >= 400 && status < 500) policy = 'NEVER';
    else if (status >= 500 && retryable === false) policy = 'NEVER';
    else policy = obs.requestIdSent ? 'SAME_REQUEST_ID' : 'VERIFY_THEN_RETRY';
  }

  let effect = oneOf(RECOVERY_EFFECTS, stated?.effect) ?? legacy?.effect ?? null;
  if (!effect) {
    if (success) effect = 'COMMITTED';
    else if (retryable === true || status < 500) effect = 'NONE';
    else effect = 'UNKNOWN';
  }

  const afterSeconds = seconds(stated?.retryAfterSeconds)
    ?? seconds(body?.retryAfterSeconds)
    ?? millisToSeconds(body?.retryAfterMs)
    ?? millisToSeconds(headerDigits(header(obs.headers, 'Retry-After-Ms')) ?? undefined)
    ?? headerDigits(header(obs.headers, 'Retry-After'));

  const owner = nonEmpty(body?.owner);
  const requiredAction = nonEmpty(body?.requiredAction);
  const actor = oneOf(RECOVERY_ACTORS, stated?.actor)
    ?? legacy?.actor
    ?? (owner ? RECOVERY_LEGACY_OWNER_TO_ACTOR[owner] : undefined)
    ?? 'CALLER';
  const actionCode = actionCodeOf(stated?.actionCode)
    ?? legacy?.actionCode
    ?? actionCodeOf(requiredAction);
  const userConfirmation = oneOf(RECOVERY_USER_CONFIRMATIONS, stated?.userConfirmation)
    ?? legacy?.userConfirmation
    ?? 'NOT_REQUIRED';
  let resources = validResources(stated?.resources);
  if (!resources) {
    resources = [];
    for (const [key, type] of RECOVERY_LEGACY_RESOURCE_KEYS) {
      const id = nonEmpty(body?.[key]);
      if (id) resources.push({ type, id });
    }
  }

  return base({
    code, message, kind, status, effect, policy, actionCode, afterSeconds, actor, owner,
    requiredAction, userConfirmation, resources, requestIdSent: obs.requestIdSent, success,
  });
}

/**
 * The legacy "refused / what / owner / do" block the Go transport has always printed above a raw
 * refusal body (`transportHTTPError.refusal`), from the body alone: "" when the body carries no code.
 * Kept byte for byte so every reader of today's text keeps reading it.
 */
export function legacyRefusalText(rawBody: string): string {
  const body = parseBody(rawBody);
  const code = nonEmpty(body?.code);
  if (!body || !code) return '';
  const label = body.advisory === true || body.kind === 'ADVISORY' ? 'advice' : 'refused';
  let out = `  ${label}: ${code}\n`;
  const message = nonEmpty(body.message);
  if (message) out += `  what:    ${message}\n`;
  const owner = nonEmpty(body.owner);
  if (owner) out += `  owner:   ${owner}\n`;
  const requiredAction = nonEmpty(body.requiredAction);
  if (requiredAction) out += `  do:      ${requiredAction}\n`;
  return out;
}

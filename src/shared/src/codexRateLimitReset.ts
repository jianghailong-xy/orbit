/**
 * Codex earned rate-limit reset — the executable half of docs/codex-rate-limit-reset-contract.md.
 *
 * Everything here is pure. The apiserver wraps these decisions in its own transactions, the web
 * reads the same eligibility and credit-detail helpers, and contracts/codex-rate-limit-reset.contract.json
 * is what both this file and the runner's Go mirror (src/runner-go/codex_rate_limit_reset.go) are
 * tested against. Nothing here talks to a provider.
 */
import type {
  CodexRateLimitResetCommand,
  CodexRateLimitResetConsumeOutcome,
  CodexRateLimitResetConsumeState,
  CodexRateLimitResetFailureCode,
  CodexRateLimitResetNextStep,
  CodexRateLimitResetOperations,
  CodexRateLimitResetOperationStatus,
  CodexRateLimitResetOperationView,
  CodexRateLimitResetPhase,
  CodexRateLimitResetRefreshState,
  CodexRateLimitResetRefusal,
  CodexRateLimitResetRefusalCode,
  CodexRateLimitResetResultCode,
  CodexRateLimitResetResultDisposition,
  CodexRateLimitResetResultKind,
  CodexRateLimitResetResultRefusal,
  CodexRateLimitResetResultRejection,
  CodexRateLimitResetResultRequest,
  CodexRateLimitResetResultResponse,
  CodexRateLimitResetSupport,
  CreateCodexRateLimitResetRequest,
  CreateCodexRateLimitResetResponse,
  PlanUsage,
  PlanUsageRateLimitReset,
  PlanUsageRateLimitResetCredit,
  PlanUsageRateLimitResetCredits,
  PlanUsageSnapshot,
  RunnerHeartbeatResponse,
} from './dto';

export const CODEX_RATE_LIMIT_RESET_PROTOCOL_VERSION = 1;

/** Declared in X-Orbit-Runner-Capabilities by a runner binary that implements BOTH the heartbeat
 *  command/result relay and the idempotent consume with its authoritative refresh. Declaring it
 *  before both exist would get the machine handed consumes it cannot carry out. */
export const CODEX_RATE_LIMIT_RESET_CAPABILITY_V1 = 'codex-rate-limit-reset-v1';

export const CODEX_ACCOUNT_READ_METHOD = 'account/read';
export const CODEX_RATE_LIMITS_READ_METHOD = 'account/rateLimits/read';
export const CODEX_RATE_LIMIT_RESET_CONSUME_METHOD = 'account/rateLimitResetCredit/consume';

export const CODEX_RATE_LIMIT_RESET_TIMING = {
  /** A block whose fetchedAt is older than this cannot back a new operation. */
  snapshotMaxAgeMs: 15 * 60_000,
  /** A fetchedAt further than this ahead of the server clock is untrusted. */
  snapshotFutureSkewMs: 5 * 60_000,
  /** A claim younger than this is never taken over, expired, or settled for an account change. */
  claimTakeoverAfterMs: 60_000,
  /** From createdAt: a consume not confirmed by then settles the operation. */
  consumeDeadlineMs: 10 * 60_000,
  /** From consumeConfirmedAt: a refresh not done by then fails; the consume stays confirmed. */
  refreshDeadlineMs: 10 * 60_000,
  /** Runner side: a consume call starts only for a command from a heartbeat response this recent. */
  commandFreshnessMs: 60_000,
} as const;

export const CODEX_RATE_LIMIT_RESET_LIMITS = {
  maxCreditDetails: 100,
  maxCreditTextLength: 1000,
  maxMessageLength: 500,
} as const;

export const CODEX_RATE_LIMIT_RESET_FORMATS = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  timestampMs: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  timestampSeconds: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
} as const;

/** `cxa1_` + the first 16 bytes of HMAC-SHA256(runner-local key, prefix + accountId) in lowercase
 *  hex. Only the runner computes it; everything else compares it as an opaque string. */
export const CODEX_ACCOUNT_FINGERPRINT_PATTERN = /^cxa1_[0-9a-f]{32}$/;
export const CODEX_ACCOUNT_FINGERPRINT_MESSAGE_PREFIX = 'orbit.codex-account-fingerprint.v1\n';

/** How a stored block and an incoming one compare (orderCodexResetSnapshot). */
export type CodexResetSnapshotOrder =
  | 'ACCEPT_FIRST'
  | 'ACCEPT_NEWER'
  | 'ACCEPT_REPLACES_UNTRUSTED'
  | 'REJECT_DUPLICATE'
  | 'REJECT_OLDER'
  | 'REJECT_UNTRUSTED'
  | 'REJECT_INVALID';

/** Enum values in declaration order. The Record witness makes the compiler refuse a missing or an
 *  extra member, so these lists cannot drift from the union types in dto.ts. */
function members<T extends string>(witness: Record<T, true>): readonly T[] {
  return Object.keys(witness) as T[];
}

export const CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES = members<CodexRateLimitResetConsumeOutcome>({
  reset: true,
  nothingToReset: true,
  noCredit: true,
  alreadyRedeemed: true,
});

export const CODEX_RATE_LIMIT_RESET_ENUMS = {
  support: members<CodexRateLimitResetSupport>({
    SUPPORTED: true,
    CREDITS_UNAVAILABLE: true,
    PROVIDER_UNSUPPORTED: true,
    UNSUPPORTED_AUTH: true,
    ACCOUNT_UNIDENTIFIED: true,
  }),
  phase: members<CodexRateLimitResetPhase>({ CONSUME: true, REFRESH: true }),
  consumeState: members<CodexRateLimitResetConsumeState>({
    PENDING: true,
    CLAIMED: true,
    CONFIRMED: true,
    NOT_ATTEMPTED: true,
    UNRESOLVED: true,
  }),
  refreshState: members<CodexRateLimitResetRefreshState>({
    NONE: true,
    PENDING: true,
    SUCCEEDED: true,
    FAILED: true,
    NOT_REQUIRED: true,
  }),
  operationStatus: members<CodexRateLimitResetOperationStatus>({
    PENDING: true,
    CONSUMING: true,
    REFRESHING: true,
    SUCCEEDED: true,
    REFRESH_FAILED: true,
    NOTHING_TO_RESET: true,
    NO_CREDIT: true,
    NOT_ATTEMPTED: true,
    UNRESOLVED: true,
  }),
  activeOperationStatus: ['PENDING', 'CONSUMING', 'REFRESHING'] as readonly CodexRateLimitResetOperationStatus[],
  resultKind: members<CodexRateLimitResetResultKind>({
    CONSUME_OUTCOME: true,
    CONSUME_NOT_CALLED: true,
    CONSUME_RETRYING: true,
    RELEASED: true,
    REFRESHED: true,
    REFRESH_FAILED: true,
  }),
  resultCode: members<CodexRateLimitResetResultCode>({
    ACCOUNT_MISMATCH: true,
    UNSUPPORTED_AUTH: true,
    PROVIDER_UNSUPPORTED: true,
    PROTOCOL_UNSUPPORTED: true,
    PROVIDER_ERROR: true,
    PROVIDER_TIMEOUT: true,
    APP_SERVER_UNAVAILABLE: true,
    READ_FAILED: true,
    ACCOUNT_UNIDENTIFIED: true,
    RUNNER_DRAINING: true,
  }),
  failureCode: members<CodexRateLimitResetFailureCode>({
    ACCOUNT_MISMATCH: true,
    UNSUPPORTED_AUTH: true,
    PROVIDER_UNSUPPORTED: true,
    PROTOCOL_UNSUPPORTED: true,
    ACCOUNT_CHANGED: true,
    CONSUME_EXPIRED: true,
    REFRESH_EXPIRED: true,
  }),
  refusalCode: members<CodexRateLimitResetRefusalCode>({
    REQUEST_ID_REUSED: true,
    ACCOUNT_OVERRIDE: true,
    OPERATION_IN_FLIGHT: true,
    RUNNER_OFFLINE: true,
    CAPABILITY_MISSING: true,
    NO_ACTIVE_LEASE: true,
    RUNNER_DRAINING: true,
    SNAPSHOT_MISSING: true,
    UNSUPPORTED_AUTH: true,
    PROVIDER_UNSUPPORTED: true,
    ACCOUNT_UNIDENTIFIED: true,
    ACCOUNT_MISMATCH: true,
    SNAPSHOT_STALE: true,
    CREDITS_UNAVAILABLE: true,
    NO_CREDIT_AVAILABLE: true,
  }),
  resultRejection: members<CodexRateLimitResetResultRejection>({
    INVALID_RESULT: true,
    OPERATION_NOT_FOUND: true,
    STALE_CLAIM: true,
    OPERATION_SETTLED: true,
    PHASE_MISMATCH: true,
    OUTCOME_CONFLICT: true,
    ACCOUNT_MISMATCH: true,
  }),
  resultDisposition: members<CodexRateLimitResetResultDisposition>({ APPLIED: true, DUPLICATE: true }),
  nextStep: members<CodexRateLimitResetNextStep>({
    REFRESH: true,
    RETRY_CONSUME: true,
    RETRY_REFRESH: true,
    STOP: true,
  }),
  snapshotOrder: members<CodexResetSnapshotOrder>({
    ACCEPT_FIRST: true,
    ACCEPT_NEWER: true,
    ACCEPT_REPLACES_UNTRUSTED: true,
    REJECT_DUPLICATE: true,
    REJECT_OLDER: true,
    REJECT_UNTRUSTED: true,
    REJECT_INVALID: true,
  }),
} as const;

/** What each provider outcome means for the operation. `alreadyRedeemed` is this key's earlier
 *  reset answered again, so it consumed a credit exactly as `reset` did. */
export const CODEX_RATE_LIMIT_RESET_OUTCOME_EFFECTS: Readonly<
  Record<CodexRateLimitResetConsumeOutcome, { readonly consumed: boolean; readonly refreshRequired: boolean }>
> = {
  reset: { consumed: true, refreshRequired: true },
  nothingToReset: { consumed: false, refreshRequired: false },
  noCredit: { consumed: false, refreshRequired: false },
  alreadyRedeemed: { consumed: true, refreshRequired: true },
};

export interface CodexResetResultKindRule {
  readonly phases: readonly CodexRateLimitResetPhase[];
  /** The one optional payload field this kind must carry; the other two must be absent. */
  readonly carries: 'outcome' | 'code' | 'rateLimitReset';
  readonly codes: readonly CodexRateLimitResetResultCode[];
  /** Codes that settle the operation. Every other code of the kind leaves it active. */
  readonly terminalCodes: readonly CodexRateLimitResetResultCode[];
}

export const CODEX_RATE_LIMIT_RESET_RESULT_KINDS: Readonly<Record<CodexRateLimitResetResultKind, CodexResetResultKindRule>> = {
  CONSUME_OUTCOME: { phases: ['CONSUME'], carries: 'outcome', codes: [], terminalCodes: [] },
  CONSUME_NOT_CALLED: {
    phases: ['CONSUME'],
    carries: 'code',
    codes: ['ACCOUNT_MISMATCH', 'UNSUPPORTED_AUTH', 'PROVIDER_UNSUPPORTED', 'PROTOCOL_UNSUPPORTED'],
    terminalCodes: ['ACCOUNT_MISMATCH', 'UNSUPPORTED_AUTH', 'PROVIDER_UNSUPPORTED', 'PROTOCOL_UNSUPPORTED'],
  },
  CONSUME_RETRYING: {
    phases: ['CONSUME'],
    carries: 'code',
    codes: ['PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'APP_SERVER_UNAVAILABLE', 'READ_FAILED', 'ACCOUNT_UNIDENTIFIED'],
    terminalCodes: [],
  },
  RELEASED: { phases: ['CONSUME', 'REFRESH'], carries: 'code', codes: ['RUNNER_DRAINING'], terminalCodes: [] },
  REFRESHED: { phases: ['REFRESH'], carries: 'rateLimitReset', codes: [], terminalCodes: [] },
  REFRESH_FAILED: {
    phases: ['REFRESH'],
    carries: 'code',
    codes: ['READ_FAILED', 'APP_SERVER_UNAVAILABLE', 'ACCOUNT_UNIDENTIFIED', 'ACCOUNT_MISMATCH'],
    terminalCodes: ['ACCOUNT_MISMATCH'],
  },
};

/** Allowed moves of each checkpoint. Staying put is always allowed; nothing moves backwards. */
export const CODEX_RATE_LIMIT_RESET_TRANSITIONS: {
  readonly consumeState: Readonly<Record<CodexRateLimitResetConsumeState, readonly CodexRateLimitResetConsumeState[]>>;
  readonly refreshState: Readonly<Record<CodexRateLimitResetRefreshState, readonly CodexRateLimitResetRefreshState[]>>;
} = {
  consumeState: {
    PENDING: ['CLAIMED', 'NOT_ATTEMPTED'],
    CLAIMED: ['CONFIRMED', 'NOT_ATTEMPTED', 'UNRESOLVED'],
    CONFIRMED: [],
    NOT_ATTEMPTED: [],
    UNRESOLVED: [],
  },
  refreshState: {
    NONE: ['PENDING', 'NOT_REQUIRED'],
    PENDING: ['SUCCEEDED', 'FAILED'],
    SUCCEEDED: [],
    FAILED: [],
    NOT_REQUIRED: [],
  },
};

/** The order codexResetRefusal checks in, so the same situation always gets the same answer. */
export const CODEX_RATE_LIMIT_RESET_ELIGIBILITY_ORDER: readonly Exclude<CodexRateLimitResetRefusalCode, 'REQUEST_ID_REUSED'>[] = [
  'ACCOUNT_OVERRIDE',
  'OPERATION_IN_FLIGHT',
  'RUNNER_OFFLINE',
  'CAPABILITY_MISSING',
  'NO_ACTIVE_LEASE',
  'RUNNER_DRAINING',
  'SNAPSHOT_MISSING',
  'UNSUPPORTED_AUTH',
  'PROVIDER_UNSUPPORTED',
  'ACCOUNT_UNIDENTIFIED',
  'ACCOUNT_MISMATCH',
  'SNAPSHOT_STALE',
  'CREDITS_UNAVAILABLE',
  'NO_CREDIT_AVAILABLE',
];

type Presence<T, K extends keyof T> = {} extends Pick<T, K> ? 'optional' : 'required';
type Nullability<T, K extends keyof T> = null extends T[K] ? 'nullable' : 'non-null';

/** Every wire field of T with its presence and nullability, checked against T by the compiler: a
 *  field added to, removed from or retyped in dto.ts without touching its entry here fails the build. */
export type CodexResetWireFields<T> = {
  readonly [K in keyof T]-?: readonly [Presence<T, K>, Nullability<T, K>];
};

export const CODEX_RATE_LIMIT_RESET_WIRE: {
  readonly PlanUsageRateLimitReset: CodexResetWireFields<PlanUsageRateLimitReset>;
  readonly PlanUsageRateLimitResetCredits: CodexResetWireFields<PlanUsageRateLimitResetCredits>;
  readonly PlanUsageRateLimitResetCredit: CodexResetWireFields<PlanUsageRateLimitResetCredit>;
  readonly CodexRateLimitResetCommand: CodexResetWireFields<CodexRateLimitResetCommand>;
  readonly CodexRateLimitResetResultRequest: CodexResetWireFields<CodexRateLimitResetResultRequest>;
  readonly CodexRateLimitResetResultResponse: CodexResetWireFields<CodexRateLimitResetResultResponse>;
  readonly CodexRateLimitResetOperationView: CodexResetWireFields<CodexRateLimitResetOperationView>;
  readonly CreateCodexRateLimitResetRequest: CodexResetWireFields<CreateCodexRateLimitResetRequest>;
  readonly CodexRateLimitResetOperations: CodexResetWireFields<CodexRateLimitResetOperations>;
  readonly CreateCodexRateLimitResetResponse: CodexResetWireFields<CreateCodexRateLimitResetResponse>;
  readonly CodexRateLimitResetRefusal: CodexResetWireFields<CodexRateLimitResetRefusal>;
  readonly CodexRateLimitResetResultRefusal: CodexResetWireFields<CodexRateLimitResetResultRefusal>;
} = {
  PlanUsageRateLimitReset: {
    protocolVersion: ['required', 'non-null'],
    support: ['required', 'non-null'],
    accountFingerprint: ['optional', 'non-null'],
    rateLimitResetCredits: ['required', 'nullable'],
    fetchedAt: ['required', 'non-null'],
    generation: ['required', 'non-null'],
    sequence: ['required', 'non-null'],
  },
  PlanUsageRateLimitResetCredits: {
    availableCount: ['required', 'non-null'],
    credits: ['required', 'nullable'],
  },
  PlanUsageRateLimitResetCredit: {
    id: ['required', 'non-null'],
    resetType: ['required', 'non-null'],
    status: ['required', 'non-null'],
    grantedAt: ['required', 'non-null'],
    expiresAt: ['required', 'nullable'],
    title: ['required', 'nullable'],
    description: ['required', 'nullable'],
  },
  CodexRateLimitResetCommand: {
    protocolVersion: ['required', 'non-null'],
    operationId: ['required', 'non-null'],
    leaseOwner: ['required', 'non-null'],
    claimGeneration: ['required', 'non-null'],
    phase: ['required', 'non-null'],
    accountFingerprint: ['required', 'non-null'],
    providerIdempotencyKey: ['optional', 'non-null'],
    requestedAt: ['required', 'non-null'],
  },
  CodexRateLimitResetResultRequest: {
    protocolVersion: ['required', 'non-null'],
    operationId: ['required', 'non-null'],
    leaseOwner: ['required', 'non-null'],
    claimGeneration: ['required', 'non-null'],
    phase: ['required', 'non-null'],
    kind: ['required', 'non-null'],
    outcome: ['optional', 'non-null'],
    code: ['optional', 'non-null'],
    message: ['optional', 'non-null'],
    observedAccountFingerprint: ['optional', 'non-null'],
    rateLimitReset: ['optional', 'non-null'],
  },
  CodexRateLimitResetResultResponse: {
    disposition: ['required', 'non-null'],
    status: ['required', 'non-null'],
    next: ['required', 'non-null'],
  },
  CodexRateLimitResetOperationView: {
    id: ['required', 'non-null'],
    runnerId: ['required', 'non-null'],
    clientRequestId: ['required', 'non-null'],
    accountFingerprint: ['required', 'non-null'],
    status: ['required', 'non-null'],
    consumeState: ['required', 'non-null'],
    consumeOutcome: ['required', 'nullable'],
    refreshState: ['required', 'non-null'],
    failureCode: ['required', 'nullable'],
    lastErrorCode: ['required', 'nullable'],
    createdAt: ['required', 'non-null'],
    updatedAt: ['required', 'non-null'],
    consumeConfirmedAt: ['required', 'nullable'],
    completedAt: ['required', 'nullable'],
  },
  CreateCodexRateLimitResetRequest: {
    clientRequestId: ['required', 'non-null'],
    accountFingerprint: ['required', 'non-null'],
    workspaceId: ['optional', 'non-null'],
  },
  CodexRateLimitResetOperations: {
    active: ['required', 'nullable'],
    latest: ['required', 'nullable'],
  },
  CreateCodexRateLimitResetResponse: {
    operation: ['required', 'non-null'],
    replayed: ['required', 'non-null'],
  },
  CodexRateLimitResetRefusal: {
    code: ['required', 'non-null'],
    operationId: ['optional', 'non-null'],
  },
  CodexRateLimitResetResultRefusal: {
    code: ['required', 'non-null'],
  },
};

/** The two fields this contract adds to wire types that already existed. */
export const CODEX_RATE_LIMIT_RESET_EXTENSIONS: {
  readonly PlanUsageSnapshot: Pick<CodexResetWireFields<PlanUsageSnapshot>, 'rateLimitReset'>;
  readonly RunnerHeartbeatResponse: Pick<CodexResetWireFields<RunnerHeartbeatResponse>, 'codexRateLimitResetRequest'>;
} = {
  PlanUsageSnapshot: { rateLimitReset: ['optional', 'non-null'] },
  RunnerHeartbeatResponse: { codexRateLimitResetRequest: ['optional', 'non-null'] },
};

// ── validation ───────────────────────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;
type FieldSpec = Readonly<Record<string, readonly [string, string]>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isCodexResetUuid(value: unknown): value is string {
  return typeof value === 'string' && CODEX_RATE_LIMIT_RESET_FORMATS.uuid.test(value);
}

export function isCodexAccountFingerprint(value: unknown): value is string {
  return typeof value === 'string' && CODEX_ACCOUNT_FINGERPRINT_PATTERN.test(value);
}

/** The pattern alone accepts 2026-02-30; the round trip does not. */
function realInstant(value: string, canonical: string): boolean {
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === canonical;
}

function isTimestampMs(value: unknown): value is string {
  return typeof value === 'string' && CODEX_RATE_LIMIT_RESET_FORMATS.timestampMs.test(value) && realInstant(value, value);
}

function isTimestampSeconds(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    CODEX_RATE_LIMIT_RESET_FORMATS.timestampSeconds.test(value) &&
    realInstant(value, value.replace(/Z$/, '.000Z'))
  );
}

function isInteger(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function isText(value: unknown, allowEmpty: boolean): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= CODEX_RATE_LIMIT_RESET_LIMITS.maxCreditTextLength
  );
}

/** Unknown fields, missing required fields and nulls where null is not allowed. A newer field is a
 *  newer protocol version, so an unknown one is refused rather than dropped. */
function shapeViolations(path: string, value: unknown, fields: FieldSpec): string[] {
  if (!isObject(value)) return [`${path} must be an object`];
  const out: string[] = [];
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) out.push(`${path}.${key} is not a protocol v1 field`);
  }
  for (const [key, [presence, nullability]] of Object.entries(fields)) {
    const field = value[key];
    if (field === undefined) {
      if (presence === 'required') out.push(`${path}.${key} is required`);
    } else if (field === null && nullability !== 'nullable') {
      out.push(`${path}.${key} must not be null`);
    }
  }
  return out;
}

function creditViolations(value: unknown, path: string): string[] {
  const out = shapeViolations(path, value, CODEX_RATE_LIMIT_RESET_WIRE.PlanUsageRateLimitResetCredit);
  if (!isObject(value)) return out;
  for (const key of ['id', 'resetType', 'status'] as const) {
    if (!isText(value[key], false)) out.push(`${path}.${key} must be a non-empty string of at most 1000 characters`);
  }
  if (!isTimestampSeconds(value.grantedAt)) out.push(`${path}.grantedAt must be ISO-8601 UTC in whole seconds`);
  if (value.expiresAt !== null && !isTimestampSeconds(value.expiresAt)) {
    out.push(`${path}.expiresAt must be null or ISO-8601 UTC in whole seconds`);
  }
  for (const key of ['title', 'description'] as const) {
    if (value[key] !== null && !isText(value[key], true)) out.push(`${path}.${key} must be null or a string of at most 1000 characters`);
  }
  return out;
}

function creditsViolations(value: unknown, path: string): string[] {
  const out = shapeViolations(path, value, CODEX_RATE_LIMIT_RESET_WIRE.PlanUsageRateLimitResetCredits);
  if (!isObject(value)) return out;
  if (!isInteger(value.availableCount, 0)) out.push(`${path}.availableCount must be a non-negative integer`);
  const rows = value.credits;
  if (rows === null || rows === undefined) return out;
  if (!Array.isArray(rows)) return [...out, `${path}.credits must be an array or null`];
  if (rows.length > CODEX_RATE_LIMIT_RESET_LIMITS.maxCreditDetails) {
    out.push(`${path}.credits must list at most ${CODEX_RATE_LIMIT_RESET_LIMITS.maxCreditDetails} credits`);
  }
  rows.forEach((row, index) => out.push(...creditViolations(row, `${path}.credits[${index}]`)));
  return out;
}

/** Why `value` is not a protocol v1 reset block; empty when it is one. */
export function codexRateLimitResetViolations(value: unknown, path = 'rateLimitReset'): string[] {
  const out = shapeViolations(path, value, CODEX_RATE_LIMIT_RESET_WIRE.PlanUsageRateLimitReset);
  if (!isObject(value)) return out;
  if (value.protocolVersion !== CODEX_RATE_LIMIT_RESET_PROTOCOL_VERSION) {
    out.push(`${path}.protocolVersion must be ${CODEX_RATE_LIMIT_RESET_PROTOCOL_VERSION}`);
  }
  if (!oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.support, value.support)) out.push(`${path}.support is not a support value`);
  const identified = value.support === 'SUPPORTED' || value.support === 'CREDITS_UNAVAILABLE';
  if (value.accountFingerprint !== undefined && !isCodexAccountFingerprint(value.accountFingerprint)) {
    out.push(`${path}.accountFingerprint must match cxa1_ + 32 lowercase hex`);
  }
  if (identified !== (value.accountFingerprint !== undefined)) {
    out.push(`${path}.accountFingerprint must be present exactly when support is SUPPORTED or CREDITS_UNAVAILABLE`);
  }
  if (value.rateLimitResetCredits !== undefined) {
    if ((value.support === 'SUPPORTED') !== (value.rateLimitResetCredits !== null)) {
      out.push(`${path}.rateLimitResetCredits must be non-null exactly when support is SUPPORTED`);
    }
    if (value.rateLimitResetCredits !== null) {
      out.push(...creditsViolations(value.rateLimitResetCredits, `${path}.rateLimitResetCredits`));
    }
  }
  if (!isTimestampMs(value.fetchedAt)) out.push(`${path}.fetchedAt must be ISO-8601 UTC with milliseconds`);
  if (!isCodexResetUuid(value.generation)) out.push(`${path}.generation must be a canonical lowercase UUID`);
  if (!isInteger(value.sequence, 1)) out.push(`${path}.sequence must be an integer of at least 1`);
  return out;
}

function envelopeViolations(value: JsonObject, path: string, out: string[]): void {
  if (value.protocolVersion !== CODEX_RATE_LIMIT_RESET_PROTOCOL_VERSION) {
    out.push(`${path}.protocolVersion must be ${CODEX_RATE_LIMIT_RESET_PROTOCOL_VERSION}`);
  }
  if (!isCodexResetUuid(value.operationId)) out.push(`${path}.operationId must be a canonical lowercase UUID`);
  if (!isCodexResetUuid(value.leaseOwner)) out.push(`${path}.leaseOwner must be a canonical lowercase UUID`);
  if (!isInteger(value.claimGeneration, 1)) out.push(`${path}.claimGeneration must be an integer of at least 1`);
  if (!oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.phase, value.phase)) out.push(`${path}.phase must be CONSUME or REFRESH`);
}

/** Why `value` is not a protocol v1 command; empty when it is one. */
export function codexResetCommandViolations(value: unknown, path = 'command'): string[] {
  const out = shapeViolations(path, value, CODEX_RATE_LIMIT_RESET_WIRE.CodexRateLimitResetCommand);
  if (!isObject(value)) return out;
  envelopeViolations(value, path, out);
  if (!isCodexAccountFingerprint(value.accountFingerprint)) out.push(`${path}.accountFingerprint must match cxa1_ + 32 lowercase hex`);
  if (!isTimestampMs(value.requestedAt)) out.push(`${path}.requestedAt must be ISO-8601 UTC with milliseconds`);
  const consume = value.phase === 'CONSUME';
  if (consume ? !isCodexResetUuid(value.providerIdempotencyKey) : value.providerIdempotencyKey !== undefined) {
    out.push(`${path}.providerIdempotencyKey must be a canonical lowercase UUID on CONSUME and absent on REFRESH`);
  }
  return out;
}

/** Why `value` is not a protocol v1 result; empty when it is one. */
export function codexResetResultViolations(value: unknown, path = 'result'): string[] {
  const out = shapeViolations(path, value, CODEX_RATE_LIMIT_RESET_WIRE.CodexRateLimitResetResultRequest);
  if (!isObject(value)) return out;
  envelopeViolations(value, path, out);
  if (!oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.resultKind, value.kind)) return [...out, `${path}.kind is not a result kind`];
  const rule = CODEX_RATE_LIMIT_RESET_RESULT_KINDS[value.kind];
  if (!rule.phases.includes(value.phase as CodexRateLimitResetPhase)) out.push(`${path}.kind ${value.kind} is not a ${String(value.phase)} result`);
  for (const field of ['outcome', 'code', 'rateLimitReset'] as const) {
    if ((value[field] !== undefined) !== (rule.carries === field)) {
      out.push(`${path}.${field} must be ${rule.carries === field ? 'present' : 'absent'} on ${value.kind}`);
    }
  }
  if (value.outcome !== undefined && !oneOf(CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES, value.outcome)) {
    out.push(`${path}.outcome is not a provider outcome`);
  }
  if (value.code !== undefined && !oneOf(rule.codes, value.code)) out.push(`${path}.code is not allowed on ${value.kind}`);
  if (
    value.message !== undefined &&
    !(
      typeof value.message === 'string' &&
      value.message.length > 0 &&
      value.message.length <= CODEX_RATE_LIMIT_RESET_LIMITS.maxMessageLength
    )
  ) {
    out.push(`${path}.message must be a non-empty string of at most ${CODEX_RATE_LIMIT_RESET_LIMITS.maxMessageLength} characters`);
  }
  if (value.observedAccountFingerprint !== undefined && !isCodexAccountFingerprint(value.observedAccountFingerprint)) {
    out.push(`${path}.observedAccountFingerprint must match cxa1_ + 32 lowercase hex`);
  }
  const block = value.rateLimitReset;
  if (block !== undefined) {
    out.push(...codexRateLimitResetViolations(block, `${path}.rateLimitReset`));
    if (isObject(block) && block.generation !== value.leaseOwner) {
      out.push(`${path}.rateLimitReset.generation must be this result's leaseOwner`);
    }
    if (isObject(block) && block.accountFingerprint === undefined) {
      out.push(`${path}.rateLimitReset must identify the account it read`);
    }
  }
  return out;
}

export function codexResetResultResponseViolations(value: unknown, path = 'response'): string[] {
  const out = shapeViolations(path, value, CODEX_RATE_LIMIT_RESET_WIRE.CodexRateLimitResetResultResponse);
  if (!isObject(value)) return out;
  if (!oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.resultDisposition, value.disposition)) out.push(`${path}.disposition is not a disposition`);
  if (!oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.operationStatus, value.status)) out.push(`${path}.status is not an operation status`);
  if (!oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.nextStep, value.next)) out.push(`${path}.next is not a next step`);
  return out;
}

const FAILED_STATUSES: readonly CodexRateLimitResetOperationStatus[] = ['REFRESH_FAILED', 'NOT_ATTEMPTED', 'UNRESOLVED'];

export function codexResetOperationViewViolations(value: unknown, path = 'operation'): string[] {
  const out = shapeViolations(path, value, CODEX_RATE_LIMIT_RESET_WIRE.CodexRateLimitResetOperationView);
  if (!isObject(value)) return out;
  for (const key of ['id', 'runnerId'] as const) {
    const id = value[key];
    if (!(typeof id === 'string' && id.length > 0 && id.length <= 64)) out.push(`${path}.${key} must be a non-empty id`);
  }
  if (!isCodexResetUuid(value.clientRequestId)) out.push(`${path}.clientRequestId must be a canonical lowercase UUID`);
  if (!isCodexAccountFingerprint(value.accountFingerprint)) out.push(`${path}.accountFingerprint must match cxa1_ + 32 lowercase hex`);
  if (!oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.operationStatus, value.status)) out.push(`${path}.status is not an operation status`);
  if (value.consumeOutcome !== null && !oneOf(CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES, value.consumeOutcome)) {
    out.push(`${path}.consumeOutcome must be null or a provider outcome`);
  }
  if (value.failureCode !== null && !oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.failureCode, value.failureCode)) {
    out.push(`${path}.failureCode must be null or a failure code`);
  }
  if (value.lastErrorCode !== null && !oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.resultCode, value.lastErrorCode)) {
    out.push(`${path}.lastErrorCode must be null or a result code`);
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (!isTimestampMs(value[key])) out.push(`${path}.${key} must be ISO-8601 UTC with milliseconds`);
  }
  for (const key of ['consumeConfirmedAt', 'completedAt'] as const) {
    if (value[key] !== null && !isTimestampMs(value[key])) out.push(`${path}.${key} must be null or ISO-8601 UTC with milliseconds`);
  }
  const derived =
    oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.consumeState, value.consumeState) &&
    oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.refreshState, value.refreshState) &&
    (value.consumeOutcome === null || oneOf(CODEX_RATE_LIMIT_RESET_CONSUME_OUTCOMES, value.consumeOutcome))
      ? codexResetOperationStatus({
          consumeState: value.consumeState,
          consumeOutcome: value.consumeOutcome,
          refreshState: value.refreshState,
        })
      : null;
  if (derived === null || derived !== value.status) out.push(`${path}.status must be the status its checkpoints derive`);
  if ((value.consumeState === 'CONFIRMED') !== (value.consumeConfirmedAt != null)) {
    out.push(`${path}.consumeConfirmedAt must be set exactly when the consume is CONFIRMED`);
  }
  if (oneOf(CODEX_RATE_LIMIT_RESET_ENUMS.activeOperationStatus, value.status) === (value.completedAt != null)) {
    out.push(`${path}.completedAt must be set exactly when the operation is settled`);
  }
  if (oneOf(FAILED_STATUSES, value.status) !== (value.failureCode != null)) {
    out.push(`${path}.failureCode must be set exactly on REFRESH_FAILED, NOT_ATTEMPTED and UNRESOLVED`);
  }
  return out;
}

export function createCodexResetRequestViolations(value: unknown, path = 'body'): string[] {
  const out = shapeViolations(path, value, CODEX_RATE_LIMIT_RESET_WIRE.CreateCodexRateLimitResetRequest);
  if (!isObject(value)) return out;
  if (!isCodexResetUuid(value.clientRequestId)) out.push(`${path}.clientRequestId must be a canonical lowercase UUID`);
  if (!isCodexAccountFingerprint(value.accountFingerprint)) out.push(`${path}.accountFingerprint must match cxa1_ + 32 lowercase hex`);
  if (value.workspaceId !== undefined && !(typeof value.workspaceId === 'string' && value.workspaceId.length > 0)) {
    out.push(`${path}.workspaceId must be a non-empty id`);
  }
  return out;
}

// ── reading a block ─────────────────────────────────────────────────────────────────────────

/** The Codex block a runner reported, nested (`codex`) or flat (`provider: 'codex'`), the same
 *  selection planUsage.ts makes. Undefined from older runners and from non-Codex snapshots. */
export function codexRateLimitResetOf(usage: PlanUsage | null | undefined): PlanUsageRateLimitReset | undefined {
  if (!usage) return undefined;
  const snapshot: PlanUsageSnapshot | undefined = usage.codex ?? (usage.provider === 'codex' ? usage : undefined);
  return snapshot?.rateLimitReset;
}

export interface CodexResetCreditDetails {
  /** The provider's authoritative count; null when the block carries no credits summary. */
  availableCount: number | null;
  /** UNKNOWN: only the count is known. COMPLETE: every credit is listed. TRUNCATED: fewer rows than
   *  the count. None of the three changes the count. */
  details: 'UNKNOWN' | 'COMPLETE' | 'TRUNCATED';
  /** The earliest expiry among LISTED `available` credits; with TRUNCATED details an unlisted one
   *  may expire sooner. Null when none is listed or none expires. */
  nextExpiresAt: string | null;
}

export function codexResetCreditDetails(block: PlanUsageRateLimitReset | null | undefined): CodexResetCreditDetails {
  const summary = block?.rateLimitResetCredits ?? null;
  if (!summary) return { availableCount: null, details: 'UNKNOWN', nextExpiresAt: null };
  if (summary.credits === null) return { availableCount: summary.availableCount, details: 'UNKNOWN', nextExpiresAt: null };
  const expiries = summary.credits
    .filter((credit) => credit.status === 'available' && credit.expiresAt !== null)
    .map((credit) => credit.expiresAt as string)
    .sort();
  return {
    availableCount: summary.availableCount,
    details: summary.credits.length >= summary.availableCount ? 'COMPLETE' : 'TRUNCATED',
    nextExpiresAt: expiries[0] ?? null,
  };
}

/** Whether a workspace or session context runs on something other than the runner's default
 *  Codex account: a configured (non built-in) provider, or an env naming another CODEX_HOME,
 *  CODEX_API_KEY or any OPENAI_* value. Reset is refused there (ACCOUNT_OVERRIDE). */
export function codexResetAccountOverride(context: {
  provider?: string | null;
  env?: Readonly<Record<string, string | null | undefined>> | null;
}): boolean {
  if (context.provider != null && context.provider !== 'codex') return true;
  return Object.entries(context.env ?? {}).some(
    ([key, value]) =>
      (key === 'CODEX_HOME' || key === 'CODEX_API_KEY' || key.startsWith('OPENAI_')) &&
      typeof value === 'string' &&
      value.trim() !== '',
  );
}

export function codexResetCapabilityDeclared(capabilities: readonly string[] | null | undefined): boolean {
  return (capabilities ?? []).some((value) => value.trim().toLowerCase() === CODEX_RATE_LIMIT_RESET_CAPABILITY_V1);
}

export function codexResetSnapshotFresh(block: PlanUsageRateLimitReset, now: Date): boolean {
  const at = Date.parse(block.fetchedAt);
  return (
    at >= now.getTime() - CODEX_RATE_LIMIT_RESET_TIMING.snapshotMaxAgeMs &&
    at <= now.getTime() + CODEX_RATE_LIMIT_RESET_TIMING.snapshotFutureSkewMs
  );
}

/**
 * Whether `incoming` may replace `stored` in Runner.planUsage. Order is by fetchedAt (when the
 * read started), then by sequence within one runner process; an equal fetchedAt from a different
 * process keeps what is stored. A stored block dated beyond the future-skew window is untrusted
 * and any sane block replaces it. `transportLeaseOwner` is the leaseOwner of the heartbeat or
 * result carrying `incoming`: a process only ever reports its own reads.
 */
export function orderCodexResetSnapshot(
  stored: unknown,
  incoming: unknown,
  transportLeaseOwner: string | null | undefined,
  now: Date,
): CodexResetSnapshotOrder {
  if (codexRateLimitResetViolations(incoming).length > 0) return 'REJECT_INVALID';
  const next = incoming as PlanUsageRateLimitReset;
  if (next.generation !== transportLeaseOwner) return 'REJECT_INVALID';
  if (stored == null || codexRateLimitResetViolations(stored).length > 0) return 'ACCEPT_FIRST';
  const previous = stored as PlanUsageRateLimitReset;
  const limit = now.getTime() + CODEX_RATE_LIMIT_RESET_TIMING.snapshotFutureSkewMs;
  const previousAt = Date.parse(previous.fetchedAt);
  const nextAt = Date.parse(next.fetchedAt);
  if (previousAt > limit !== nextAt > limit) return previousAt > limit ? 'ACCEPT_REPLACES_UNTRUSTED' : 'REJECT_UNTRUSTED';
  if (nextAt !== previousAt) return nextAt > previousAt ? 'ACCEPT_NEWER' : 'REJECT_OLDER';
  if (next.generation !== previous.generation) return 'REJECT_OLDER';
  if (next.sequence === previous.sequence) return 'REJECT_DUPLICATE';
  return next.sequence > previous.sequence ? 'ACCEPT_NEWER' : 'REJECT_OLDER';
}

export function codexResetSnapshotAccepted(order: CodexResetSnapshotOrder): boolean {
  return order === 'ACCEPT_FIRST' || order === 'ACCEPT_NEWER' || order === 'ACCEPT_REPLACES_UNTRUSTED';
}

// ── creating an operation ───────────────────────────────────────────────────────────────────

export interface CodexResetEligibilityInput {
  now: Date;
  /** codexResetAccountOverride of the context the confirmation came from; false for the runner page. */
  accountOverride: boolean;
  /** An operation for this runner and fingerprint is PENDING, CONSUMING or REFRESHING. */
  activeOperation: boolean;
  /** The runner's last heartbeat is within the control plane's online window. */
  runnerOnline: boolean;
  /** Runner.capabilities as the last heartbeat declared them. */
  runnerCapabilities: readonly string[] | null | undefined;
  /** The leaseOwner the last heartbeat carried; null when it carried none. */
  heartbeatLeaseOwner: string | null | undefined;
  /** The draining flag the last heartbeat carried. */
  runnerDraining: boolean;
  /** The runner's stored Codex block (codexRateLimitResetOf(Runner.planUsage)). */
  rateLimitReset: PlanUsageRateLimitReset | null | undefined;
  /** CreateCodexRateLimitResetRequest.accountFingerprint. */
  expectedAccountFingerprint: string;
}

/** Why a new operation must not be created, in CODEX_RATE_LIMIT_RESET_ELIGIBILITY_ORDER; null when
 *  it may. The web disables its entry on the same answer the API refuses with. */
export function codexResetRefusal(input: CodexResetEligibilityInput): CodexRateLimitResetRefusalCode | null {
  if (input.accountOverride) return 'ACCOUNT_OVERRIDE';
  if (input.activeOperation) return 'OPERATION_IN_FLIGHT';
  if (!input.runnerOnline) return 'RUNNER_OFFLINE';
  if (!codexResetCapabilityDeclared(input.runnerCapabilities)) return 'CAPABILITY_MISSING';
  if (!isCodexResetUuid(input.heartbeatLeaseOwner)) return 'NO_ACTIVE_LEASE';
  if (input.runnerDraining) return 'RUNNER_DRAINING';
  const block = input.rateLimitReset;
  if (!block || codexRateLimitResetViolations(block).length > 0) return 'SNAPSHOT_MISSING';
  if (block.support === 'UNSUPPORTED_AUTH' || block.support === 'PROVIDER_UNSUPPORTED' || block.support === 'ACCOUNT_UNIDENTIFIED') {
    return block.support;
  }
  if (block.accountFingerprint !== input.expectedAccountFingerprint) return 'ACCOUNT_MISMATCH';
  if (!codexResetSnapshotFresh(block, input.now)) return 'SNAPSHOT_STALE';
  if (!block.rateLimitResetCredits) return 'CREDITS_UNAVAILABLE';
  if (block.rateLimitResetCredits.availableCount <= 0) return 'NO_CREDIT_AVAILABLE';
  return null;
}

/** The persisted operation. Only the apiserver holds it; clients see codexResetOperationView. */
export interface CodexRateLimitResetOperationState {
  id: string;
  ownerId: string;
  runnerId: string;
  accountFingerprint: string;
  /** Idempotency of the POST: unique per owner, replayed rather than re-created. */
  clientRequestId: string;
  /** Idempotency of the provider consume: generated with the row, never replaced, never shown. */
  providerIdempotencyKey: string;
  consumeState: CodexRateLimitResetConsumeState;
  consumeOutcome: CodexRateLimitResetConsumeOutcome | null;
  refreshState: CodexRateLimitResetRefreshState;
  failureCode: CodexRateLimitResetFailureCode | null;
  lastErrorCode: CodexRateLimitResetResultCode | null;
  /** The runner process currently allowed to act and report; null when unclaimed or released. */
  claimLeaseOwner: string | null;
  /** 0 until the first claim; +1 on every claim or takeover. Results are fenced to it. */
  claimGeneration: number;
  claimedAt: string | null;
  /** Consume-phase claims that may have reached the provider and never said they did not. Zero
   *  is what lets a settled consume be NOT_ATTEMPTED instead of UNRESOLVED. */
  claimsWithUnknownCall: number;
  createdAt: string;
  updatedAt: string;
  consumeConfirmedAt: string | null;
  completedAt: string | null;
}

/** The row a confirmation creates. `providerIdempotencyKey` is generated by the caller for this
 *  insert only; a request that replays an existing clientRequestId never reaches here. */
export function newCodexResetOperation(input: {
  id: string;
  ownerId: string;
  runnerId: string;
  accountFingerprint: string;
  clientRequestId: string;
  providerIdempotencyKey: string;
  now: Date;
}): CodexRateLimitResetOperationState {
  for (const key of ['id', 'ownerId', 'runnerId', 'clientRequestId', 'providerIdempotencyKey'] as const) {
    if (!isCodexResetUuid(input[key])) throw new Error(`${key} must be a canonical lowercase UUID`);
  }
  if (!isCodexAccountFingerprint(input.accountFingerprint)) throw new Error('accountFingerprint must match cxa1_ + 32 lowercase hex');
  const at = input.now.toISOString();
  return {
    id: input.id,
    ownerId: input.ownerId,
    runnerId: input.runnerId,
    accountFingerprint: input.accountFingerprint,
    clientRequestId: input.clientRequestId,
    providerIdempotencyKey: input.providerIdempotencyKey,
    consumeState: 'PENDING',
    consumeOutcome: null,
    refreshState: 'NONE',
    failureCode: null,
    lastErrorCode: null,
    claimLeaseOwner: null,
    claimGeneration: 0,
    claimedAt: null,
    claimsWithUnknownCall: 0,
    createdAt: at,
    updatedAt: at,
    consumeConfirmedAt: null,
    completedAt: null,
  };
}

/** A POST whose (owner, clientRequestId) already exists: the same confirmation replayed, or the id
 *  reused for a different runner or account (refused, the existing operation untouched). */
export function codexResetCreateReplay(
  existing: Pick<CodexRateLimitResetOperationState, 'runnerId' | 'accountFingerprint'>,
  request: { runnerId: string; accountFingerprint: string },
): 'REPLAY' | 'REQUEST_ID_REUSED' {
  return existing.runnerId === request.runnerId && existing.accountFingerprint === request.accountFingerprint
    ? 'REPLAY'
    : 'REQUEST_ID_REUSED';
}

/** The status two checkpoints derive, or null for a combination the contract does not allow. */
export function codexResetOperationStatus(
  state: Pick<CodexRateLimitResetOperationState, 'consumeState' | 'consumeOutcome' | 'refreshState'>,
): CodexRateLimitResetOperationStatus | null {
  const { consumeState, consumeOutcome, refreshState } = state;
  if (consumeState !== 'CONFIRMED') {
    if (consumeOutcome !== null) return null;
    if (consumeState === 'PENDING' || consumeState === 'CLAIMED') {
      return refreshState === 'NONE' ? (consumeState === 'PENDING' ? 'PENDING' : 'CONSUMING') : null;
    }
    if (consumeState === 'NOT_ATTEMPTED' || consumeState === 'UNRESOLVED') {
      return refreshState === 'NOT_REQUIRED' ? consumeState : null;
    }
    return null;
  }
  const effect = consumeOutcome === null ? undefined : CODEX_RATE_LIMIT_RESET_OUTCOME_EFFECTS[consumeOutcome];
  if (!effect) return null;
  if (!effect.refreshRequired) {
    if (refreshState !== 'NOT_REQUIRED') return null;
    return consumeOutcome === 'nothingToReset' ? 'NOTHING_TO_RESET' : 'NO_CREDIT';
  }
  if (refreshState === 'PENDING') return 'REFRESHING';
  if (refreshState === 'SUCCEEDED') return 'SUCCEEDED';
  if (refreshState === 'FAILED') return 'REFRESH_FAILED';
  return null;
}

/** The checkpoint an active operation is at; null once it is settled. */
export function codexResetOperationPhase(
  state: Pick<CodexRateLimitResetOperationState, 'consumeState' | 'consumeOutcome' | 'refreshState'>,
): CodexRateLimitResetPhase | null {
  const status = codexResetOperationStatus(state);
  if (status === 'PENDING' || status === 'CONSUMING') return 'CONSUME';
  return status === 'REFRESHING' ? 'REFRESH' : null;
}

export function codexResetOperationView(state: CodexRateLimitResetOperationState): CodexRateLimitResetOperationView {
  const status = codexResetOperationStatus(state);
  if (!status) throw new Error('operation state is not a valid checkpoint combination');
  return {
    id: state.id,
    runnerId: state.runnerId,
    clientRequestId: state.clientRequestId,
    accountFingerprint: state.accountFingerprint,
    status,
    consumeState: state.consumeState,
    consumeOutcome: state.consumeOutcome,
    refreshState: state.refreshState,
    failureCode: state.failureCode,
    lastErrorCode: state.lastErrorCode,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    consumeConfirmedAt: state.consumeConfirmedAt,
    completedAt: state.completedAt,
  };
}

const IMMUTABLE_FIELDS = [
  'id',
  'ownerId',
  'runnerId',
  'accountFingerprint',
  'clientRequestId',
  'providerIdempotencyKey',
  'createdAt',
] as const;

/** Why `to` may not be written over `from`; empty when it may. This is the monotonic invariant
 *  every persisted write must satisfy, whatever produced it. */
export function codexResetTransitionViolations(
  from: CodexRateLimitResetOperationState,
  to: CodexRateLimitResetOperationState,
): string[] {
  const out: string[] = [];
  for (const key of IMMUTABLE_FIELDS) if (from[key] !== to[key]) out.push(`${key} is immutable`);
  const fromStatus = codexResetOperationStatus(from);
  if (codexResetOperationStatus(to) === null) out.push('the new checkpoints are not a valid combination');
  if (from.consumeState !== to.consumeState && !CODEX_RATE_LIMIT_RESET_TRANSITIONS.consumeState[from.consumeState].includes(to.consumeState)) {
    out.push(`consumeState may not move from ${from.consumeState} to ${to.consumeState}`);
  }
  if (from.refreshState !== to.refreshState && !CODEX_RATE_LIMIT_RESET_TRANSITIONS.refreshState[from.refreshState].includes(to.refreshState)) {
    out.push(`refreshState may not move from ${from.refreshState} to ${to.refreshState}`);
  }
  if (from.consumeOutcome !== null && from.consumeOutcome !== to.consumeOutcome) out.push('consumeOutcome is immutable once recorded');
  if (from.consumeConfirmedAt !== null && from.consumeConfirmedAt !== to.consumeConfirmedAt) {
    out.push('consumeConfirmedAt is immutable once recorded');
  }
  if (to.claimGeneration < from.claimGeneration) out.push('claimGeneration never decreases');
  if (to.claimsWithUnknownCall < 0) out.push('claimsWithUnknownCall is never negative');
  if (fromStatus !== null && !CODEX_RATE_LIMIT_RESET_ENUMS.activeOperationStatus.includes(fromStatus)) {
    const changed = (Object.keys(from) as (keyof CodexRateLimitResetOperationState)[]).some((key) => from[key] !== to[key]);
    if (changed) out.push('a settled operation never changes');
  }
  return out;
}

// ── heartbeat relay ─────────────────────────────────────────────────────────────────────────

export interface CodexResetHeartbeat {
  runnerId: string;
  leaseOwner: string | null | undefined;
  draining: boolean;
  /** The capabilities THIS heartbeat request declared. */
  capabilities: readonly string[] | null | undefined;
  /** The runner's stored Codex block after this heartbeat's own compare-and-set. */
  rateLimitReset: PlanUsageRateLimitReset | null | undefined;
  now: Date;
}

export type CodexResetDispatch =
  | {
      kind: 'NONE';
      reason:
        | 'SETTLED'
        | 'RUNNER_MISMATCH'
        | 'NO_ACTIVE_LEASE'
        | 'CAPABILITY_MISSING'
        | 'RUNNER_DRAINING'
        | 'SNAPSHOT_MISSING'
        | 'CLAIM_HELD';
    }
  | { kind: 'SETTLE'; operation: CodexRateLimitResetOperationState }
  | { kind: 'DELIVER'; operation: CodexRateLimitResetOperationState; command: CodexRateLimitResetCommand };

function claimFresh(op: CodexRateLimitResetOperationState, now: Date): boolean {
  return (
    op.claimLeaseOwner !== null &&
    op.claimedAt !== null &&
    now.getTime() < Date.parse(op.claimedAt) + CODEX_RATE_LIMIT_RESET_TIMING.claimTakeoverAfterMs
  );
}

/** Settle an active operation for a reason the runner did not report. A consume whose every claim
 *  said it never called the provider is NOT_ATTEMPTED; one that may have called is UNRESOLVED; a
 *  refresh fails while its confirmed consume stays confirmed. */
function settle(
  op: CodexRateLimitResetOperationState,
  failureCode: CodexRateLimitResetFailureCode,
  now: Date,
): CodexRateLimitResetOperationState {
  const at = now.toISOString();
  if (codexResetOperationPhase(op) === 'REFRESH') {
    return { ...op, refreshState: 'FAILED', failureCode, updatedAt: at, completedAt: at };
  }
  return {
    ...op,
    consumeState: op.claimsWithUnknownCall === 0 ? 'NOT_ATTEMPTED' : 'UNRESOLVED',
    refreshState: 'NOT_REQUIRED',
    failureCode,
    updatedAt: at,
    completedAt: at,
  };
}

/** The operation settled by its deadline, or null when it is not due (or a fresh claim still
 *  holds it). */
export function expireCodexResetOperation(
  op: CodexRateLimitResetOperationState,
  now: Date,
): CodexRateLimitResetOperationState | null {
  const phase = codexResetOperationPhase(op);
  if (!phase || claimFresh(op, now)) return null;
  if (phase === 'CONSUME' && now.getTime() >= Date.parse(op.createdAt) + CODEX_RATE_LIMIT_RESET_TIMING.consumeDeadlineMs) {
    return settle(op, 'CONSUME_EXPIRED', now);
  }
  if (
    phase === 'REFRESH' &&
    op.consumeConfirmedAt !== null &&
    now.getTime() >= Date.parse(op.consumeConfirmedAt) + CODEX_RATE_LIMIT_RESET_TIMING.refreshDeadlineMs
  ) {
    return settle(op, 'REFRESH_EXPIRED', now);
  }
  return null;
}

/** The command a claimed, active operation hands its claimer. Only CONSUME carries the key. */
export function codexResetCommand(op: CodexRateLimitResetOperationState): CodexRateLimitResetCommand {
  const phase = codexResetOperationPhase(op);
  if (!phase || op.claimLeaseOwner === null || op.claimGeneration < 1) {
    throw new Error('only a claimed, active operation has a command');
  }
  return {
    protocolVersion: CODEX_RATE_LIMIT_RESET_PROTOCOL_VERSION,
    operationId: op.id,
    leaseOwner: op.claimLeaseOwner,
    claimGeneration: op.claimGeneration,
    phase,
    accountFingerprint: op.accountFingerprint,
    ...(phase === 'CONSUME' ? { providerIdempotencyKey: op.providerIdempotencyKey } : {}),
    requestedAt: op.createdAt,
  };
}

/**
 * What one heartbeat does to one operation of its runner: nothing, settle it, or (claiming or
 * taking it over first when needed) deliver its command. A claim held by another process is left
 * alone until it is claimTakeoverAfterMs old; after that the new process takes it with a higher
 * claimGeneration. Re-running a consume under a new process is safe because the provider key is
 * the operation's, never the process's.
 */
export function decideCodexResetDispatch(op: CodexRateLimitResetOperationState, heartbeat: CodexResetHeartbeat): CodexResetDispatch {
  if (op.runnerId !== heartbeat.runnerId) return { kind: 'NONE', reason: 'RUNNER_MISMATCH' };
  const expired = expireCodexResetOperation(op, heartbeat.now);
  if (expired) return { kind: 'SETTLE', operation: expired };
  const phase = codexResetOperationPhase(op);
  if (!phase) return { kind: 'NONE', reason: 'SETTLED' };
  const leaseOwner = heartbeat.leaseOwner;
  if (!isCodexResetUuid(leaseOwner)) return { kind: 'NONE', reason: 'NO_ACTIVE_LEASE' };
  if (!codexResetCapabilityDeclared(heartbeat.capabilities)) return { kind: 'NONE', reason: 'CAPABILITY_MISSING' };
  if (heartbeat.draining) return { kind: 'NONE', reason: 'RUNNER_DRAINING' };
  const block = heartbeat.rateLimitReset;
  if (!block || codexRateLimitResetViolations(block).length > 0 || block.accountFingerprint === undefined) {
    return { kind: 'NONE', reason: 'SNAPSHOT_MISSING' };
  }
  const fresh = claimFresh(op, heartbeat.now);
  if (block.accountFingerprint !== op.accountFingerprint) {
    return fresh ? { kind: 'NONE', reason: 'CLAIM_HELD' } : { kind: 'SETTLE', operation: settle(op, 'ACCOUNT_CHANGED', heartbeat.now) };
  }
  if (op.claimLeaseOwner === leaseOwner) return { kind: 'DELIVER', operation: op, command: codexResetCommand(op) };
  if (fresh) return { kind: 'NONE', reason: 'CLAIM_HELD' };
  const at = heartbeat.now.toISOString();
  const claimed: CodexRateLimitResetOperationState = {
    ...op,
    consumeState: op.consumeState === 'PENDING' ? 'CLAIMED' : op.consumeState,
    claimLeaseOwner: leaseOwner,
    claimGeneration: op.claimGeneration + 1,
    claimedAt: at,
    claimsWithUnknownCall: op.claimsWithUnknownCall + (phase === 'CONSUME' ? 1 : 0),
    updatedAt: at,
  };
  return { kind: 'DELIVER', operation: claimed, command: codexResetCommand(claimed) };
}

export type CodexResetResultApplication =
  | {
      kind: 'APPLIED' | 'DUPLICATE';
      operation: CodexRateLimitResetOperationState;
      response: CodexRateLimitResetResultResponse;
    }
  | { kind: 'REJECTED'; rejection: CodexRateLimitResetResultRejection };

/** What the claim that sent a result should do next, by the operation as it now stands. */
export function codexResetNextStep(op: CodexRateLimitResetOperationState): CodexRateLimitResetNextStep {
  if (op.claimLeaseOwner === null) return 'STOP';
  const status = codexResetOperationStatus(op);
  if (status === 'CONSUMING') return 'RETRY_CONSUME';
  if (status === 'REFRESHING') return op.lastErrorCode === null ? 'REFRESH' : 'RETRY_REFRESH';
  return 'STOP';
}

function respond(
  disposition: CodexRateLimitResetResultDisposition,
  op: CodexRateLimitResetOperationState,
  fromCurrentClaim: boolean,
): CodexRateLimitResetResultResponse {
  const status = codexResetOperationStatus(op);
  if (!status) throw new Error('operation state is not a valid checkpoint combination');
  return { disposition, status, next: fromCurrentClaim ? codexResetNextStep(op) : 'STOP' };
}

function consumedAlike(a: CodexRateLimitResetConsumeOutcome, b: CodexRateLimitResetConsumeOutcome): boolean {
  return a === b || (CODEX_RATE_LIMIT_RESET_OUTCOME_EFFECTS[a].consumed && CODEX_RATE_LIMIT_RESET_OUTCOME_EFFECTS[b].consumed);
}

/** SAME: this result restates a fact already recorded, from whichever claim. CONFLICT: it
 *  contradicts one. NEW: anything else. */
function recordedFact(op: CodexRateLimitResetOperationState, result: CodexRateLimitResetResultRequest): 'SAME' | 'CONFLICT' | 'NEW' {
  switch (result.kind) {
    case 'CONSUME_OUTCOME':
      if (op.consumeState !== 'CONFIRMED' || op.consumeOutcome === null) return 'NEW';
      return consumedAlike(op.consumeOutcome, result.outcome as CodexRateLimitResetConsumeOutcome) ? 'SAME' : 'CONFLICT';
    case 'CONSUME_NOT_CALLED':
      return (op.consumeState === 'NOT_ATTEMPTED' || op.consumeState === 'UNRESOLVED') && op.failureCode === result.code ? 'SAME' : 'NEW';
    case 'REFRESHED':
      return op.refreshState === 'SUCCEEDED' && result.rateLimitReset?.accountFingerprint === op.accountFingerprint ? 'SAME' : 'NEW';
    case 'REFRESH_FAILED':
      return op.refreshState === 'FAILED' && op.failureCode === result.code ? 'SAME' : 'NEW';
    default:
      return 'NEW';
  }
}

/**
 * Apply one runner result to its operation. Validation first; then a result that restates a
 * recorded fact is a DUPLICATE from any claim (receipts are redelivered); otherwise it must come
 * from the current (leaseOwner, claimGeneration) and match the operation's phase. The refreshed
 * block itself still goes through orderCodexResetSnapshot before it reaches Runner.planUsage.
 */
export function applyCodexResetResult(
  op: CodexRateLimitResetOperationState,
  runnerId: string,
  value: unknown,
  now: Date,
): CodexResetResultApplication {
  if (codexResetResultViolations(value).length > 0) return { kind: 'REJECTED', rejection: 'INVALID_RESULT' };
  const result = value as CodexRateLimitResetResultRequest;
  if (result.operationId !== op.id || runnerId !== op.runnerId) return { kind: 'REJECTED', rejection: 'OPERATION_NOT_FOUND' };
  const fromCurrentClaim = result.leaseOwner === op.claimLeaseOwner && result.claimGeneration === op.claimGeneration;
  const fact = recordedFact(op, result);
  if (fact === 'CONFLICT') return { kind: 'REJECTED', rejection: 'OUTCOME_CONFLICT' };
  if (fact === 'SAME') return { kind: 'DUPLICATE', operation: op, response: respond('DUPLICATE', op, fromCurrentClaim) };
  const phase = codexResetOperationPhase(op);
  if (!phase) return { kind: 'REJECTED', rejection: 'OPERATION_SETTLED' };
  if (!fromCurrentClaim) return { kind: 'REJECTED', rejection: 'STALE_CLAIM' };
  if (result.phase !== phase) return { kind: 'REJECTED', rejection: 'PHASE_MISMATCH' };
  const at = now.toISOString();
  let next: CodexRateLimitResetOperationState;
  switch (result.kind) {
    case 'CONSUME_OUTCOME': {
      const outcome = result.outcome as CodexRateLimitResetConsumeOutcome;
      const refresh = CODEX_RATE_LIMIT_RESET_OUTCOME_EFFECTS[outcome].refreshRequired;
      next = {
        ...op,
        consumeState: 'CONFIRMED',
        consumeOutcome: outcome,
        consumeConfirmedAt: at,
        refreshState: refresh ? 'PENDING' : 'NOT_REQUIRED',
        lastErrorCode: null,
        updatedAt: at,
        completedAt: refresh ? null : at,
      };
      break;
    }
    case 'CONSUME_NOT_CALLED': {
      const unknown = Math.max(0, op.claimsWithUnknownCall - 1);
      next = {
        ...op,
        claimsWithUnknownCall: unknown,
        consumeState: unknown === 0 ? 'NOT_ATTEMPTED' : 'UNRESOLVED',
        refreshState: 'NOT_REQUIRED',
        failureCode: result.code as CodexRateLimitResetFailureCode,
        updatedAt: at,
        completedAt: at,
      };
      break;
    }
    case 'CONSUME_RETRYING':
      next = { ...op, lastErrorCode: result.code as CodexRateLimitResetResultCode, updatedAt: at };
      break;
    case 'RELEASED':
      next = {
        ...op,
        claimLeaseOwner: null,
        claimedAt: null,
        claimsWithUnknownCall: phase === 'CONSUME' ? Math.max(0, op.claimsWithUnknownCall - 1) : op.claimsWithUnknownCall,
        lastErrorCode: result.code as CodexRateLimitResetResultCode,
        updatedAt: at,
      };
      break;
    case 'REFRESHED':
      if (result.rateLimitReset?.accountFingerprint !== op.accountFingerprint) {
        return { kind: 'REJECTED', rejection: 'ACCOUNT_MISMATCH' };
      }
      next = { ...op, refreshState: 'SUCCEEDED', lastErrorCode: null, updatedAt: at, completedAt: at };
      break;
    case 'REFRESH_FAILED': {
      const code = result.code as CodexRateLimitResetResultCode;
      next = CODEX_RATE_LIMIT_RESET_RESULT_KINDS.REFRESH_FAILED.terminalCodes.includes(code)
        ? { ...op, refreshState: 'FAILED', failureCode: code as CodexRateLimitResetFailureCode, updatedAt: at, completedAt: at }
        : { ...op, lastErrorCode: code, updatedAt: at };
      break;
    }
    default: {
      const unreachable: never = result.kind;
      throw new Error(`unhandled result kind ${String(unreachable)}`);
    }
  }
  return { kind: 'APPLIED', operation: next, response: respond('APPLIED', next, true) };
}

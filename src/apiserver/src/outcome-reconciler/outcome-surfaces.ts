/**
 * Canonical Outcome read surfaces.
 *
 * The evaluator owns the semantic half of every item.  This module only derives a CTA for the
 * authenticated actor and surface.  In particular, filtering an inbox or changing a label must
 * never mint a second obligation identity, reason or watermark.
 */

export const OUTCOME_SURFACE_SCHEMA_VERSION = 2;

export const OUTCOME_SURFACES = [
  'DONE_GATE',
  'AGENT_QUEUE',
  'OWNER_DECISION_INBOX',
  'PROJECT_ATTENTION',
  'MUTATION_RESPONSE',
  'WEB',
] as const;

export type OutcomeSurface = (typeof OUTCOME_SURFACES)[number];
export type OutcomeSurfaceActor = 'SYSTEM' | 'AGENT' | 'OWNER';

export const OUTCOME_OWNER_DECISION_KINDS = [
  'REQUEST_GOAL_DECISION',
  'REQUEST_RISK_ACCEPTANCE',
  'REQUEST_NEW_AUTHORIZATION',
  'REQUEST_EXTERNAL_IDENTITY',
] as const;

export type OutcomeOwnerDecisionKind = (typeof OUTCOME_OWNER_DECISION_KINDS)[number];

export const OUTCOME_SURFACE_LIMITS = Object.freeze({
  maxProjectionBytes: 256 * 1024,
  maxDecisionPayloadBytes: 32 * 1024,
  maxStringBytes: 8 * 1024,
  maxArrayItems: 50,
  maxObjectKeys: 100,
  maxDepth: 8,
});

const DIGEST = /^[0-9a-f]{64}$/;
const LOGICAL_TIME = /^(0|[1-9][0-9]*)$/;
// Match snake/kebab/camel/plain keys. Payloads come from integrations, so one naming convention
// must not be able to bypass the transport boundary (for example `apiToken` versus `api_token`).
const SECRET_KEY = /(authorization|cookie|credential|password|private[_-]?key|secret|token|api[_-]?key)/i;
const SECRET_VALUE = /(?:\b(?:bearer|basic)\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9_]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@|[?&](?:access[_-]?token|api[_-]?key|authorization|password|secret|token)=[^&\s]+)/i;

type JsonObject = Record<string, unknown>;

export interface OutcomeCanonicalIdentity {
  bindingDigest: string;
  evaluatedThroughLogicalTime: string;
  projectionRevision: string;
  proofDigest: string;
  [key: string]: unknown;
}

export interface OutcomeCanonicalReason {
  code: string;
  message: string;
  evidenceFactIds: string[];
  attemptedActions: string[];
  nextAction: string;
}

export interface OutcomeSurfaceObligation {
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  binding: JsonObject;
  kind: string;
  owner: 'SYSTEM' | 'AGENT' | 'OWNER' | 'EXTERNAL';
  capability: string;
  reason: OutcomeCanonicalReason;
  evaluatedThroughLogicalTime: string;
  projectionRevision: string;
  staleness: 'CURRENT';
  [key: string]: unknown;
}

export type HumanDecisionType =
  | 'OWNER_RATIFICATION'
  | 'HUMAN_SIGNOFF'
  | 'GOAL_DECISION'
  | 'RISK_ACCEPTANCE'
  | 'NEW_AUTHORIZATION'
  | 'EXTERNAL_IDENTITY';

export interface HumanDecisionProtocol {
  decisionType: HumanDecisionType;
  agentWorkCompleted: unknown[];
  whyNotAgent: string;
  options: unknown[];
  impacts: unknown[];
  recommendation: unknown;
  cost: unknown;
  deadline: unknown;
  noActionConsequence: unknown;
  resumeBehavior: unknown;
}

export interface OutcomeDecisionRequest {
  requestId: string;
  requestRevision: string;
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  status: 'OPEN' | 'DECIDED' | 'SUPERSEDED' | 'EXPIRED';
  expiresAt?: string | null;
  expiresLogicalTime?: string | null;
  protocol: HumanDecisionProtocol;
}

export interface OutcomeCtaBinding {
  requestId: string | null;
  requestRevision: string | null;
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  evaluatedThroughLogicalTime: string;
  projectionRevision: string;
  expiresAt: string | null;
  expiresLogicalTime: string | null;
}

export interface OutcomeActorCta {
  actor: OutcomeSurfaceActor;
  kind: 'EXECUTE' | 'DECIDE' | 'VIEW';
  label: string;
  method: 'GET' | 'POST';
  href: string;
  binding: OutcomeCtaBinding;
}

export interface OutcomeSurfaceItem {
  semantic: OutcomeSurfaceObligation;
  cta: OutcomeActorCta | null;
  /** Public, non-secret request identity remains visible when a CTA expires, so the item cannot
   * disappear and masquerade as an empty inbox. It never authorizes the mutation by itself. */
  decisionRequest: OutcomeCtaBinding | null;
  ctaUnavailableReason: string | null;
  decision: HumanDecisionProtocol | null;
}

export interface OutcomeProjectionInput {
  schemaVersion: number;
  staleness: 'CURRENT' | 'RECONCILER_STALE';
  canonicalIdentity: OutcomeCanonicalIdentity;
  doneGate?: JsonObject;
  obligations?: OutcomeSurfaceObligation[];
  error?: JsonObject;
  [key: string]: unknown;
}

export interface DerivedOutcomeSurface {
  schemaVersion: number;
  surface: OutcomeSurface;
  actor: OutcomeSurfaceActor;
  staleness: 'CURRENT' | 'RECONCILER_STALE';
  canonicalIdentity: OutcomeCanonicalIdentity;
  doneGate?: JsonObject;
  obligations?: OutcomeSurfaceObligation[];
  items?: OutcomeSurfaceItem[];
  error?: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new Error(`OUTCOME_SURFACE_DIGEST_INVALID:${label}`);
  }
}

function assertLogicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !LOGICAL_TIME.test(value)) {
    throw new Error(`OUTCOME_SURFACE_LOGICAL_TIME_INVALID:${label}`);
  }
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OUTCOME_SURFACE_FIELD_REQUIRED:${label}`);
  }
}

/**
 * Redact recursively before any decision payload reaches API, CLI or Web.  The size/depth bounds
 * are part of the same traversal, so a secret cannot be hidden behind an unbounded object that a
 * renderer or logger processes before redaction.
 */
export function redactOutcomePayload(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): unknown {
  if (depth > OUTCOME_SURFACE_LIMITS.maxDepth) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value.trim())) return '[REDACTED]';
    return Buffer.byteLength(value, 'utf8') > OUTCOME_SURFACE_LIMITS.maxStringBytes
      ? `${value.slice(0, OUTCOME_SURFACE_LIMITS.maxStringBytes)}…[TRUNCATED]`
      : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object' || value === undefined) return String(value);
  if (seen.has(value)) return '[REDACTED_CYCLE]';
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.slice(0, OUTCOME_SURFACE_LIMITS.maxArrayItems)
      .map((entry) => redactOutcomePayload(entry, depth + 1, seen));
  } else {
    result = Object.fromEntries(
      Object.entries(value as JsonObject)
        .slice(0, OUTCOME_SURFACE_LIMITS.maxObjectKeys)
        .map(([key, entry]) => [
          key,
          SECRET_KEY.test(key) ? '[REDACTED]' : redactOutcomePayload(entry, depth + 1, seen),
        ]),
    );
  }
  seen.delete(value);
  return result;
}

export function assertOutcomeDecisionProtocol(value: unknown): asserts value is HumanDecisionProtocol {
  if (!isObject(value)) throw new Error('OUTCOME_HUMAN_DECISION_PROTOCOL_REQUIRED');
  const type = value.decisionType;
  if (![
    'OWNER_RATIFICATION', 'HUMAN_SIGNOFF', 'GOAL_DECISION', 'RISK_ACCEPTANCE',
    'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY',
  ].includes(String(type))) throw new Error('OUTCOME_HUMAN_DECISION_TYPE_INVALID');
  if (!Array.isArray(value.agentWorkCompleted)) {
    throw new Error('OUTCOME_HUMAN_DECISION_AGENT_WORK_REQUIRED');
  }
  assertNonEmpty(value.whyNotAgent, 'whyNotAgent');
  if (!Array.isArray(value.options) || value.options.length === 0) {
    throw new Error('OUTCOME_HUMAN_DECISION_OPTIONS_REQUIRED');
  }
  if (!Array.isArray(value.impacts) || value.impacts.length === 0) {
    throw new Error('OUTCOME_HUMAN_DECISION_IMPACTS_REQUIRED');
  }
  for (const field of ['recommendation', 'cost', 'deadline', 'noActionConsequence', 'resumeBehavior']) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(`OUTCOME_HUMAN_DECISION_FIELD_REQUIRED:${field}`);
    }
  }
  const absent = (entry: unknown) => entry === null || entry === undefined
    || (typeof entry === 'string' && entry.trim().length === 0);
  if (absent(value.recommendation)) {
    throw new Error('OUTCOME_HUMAN_DECISION_RECOMMENDATION_REQUIRED');
  }
  if (absent(value.cost) && absent(value.deadline)) {
    throw new Error('OUTCOME_HUMAN_DECISION_COST_OR_DEADLINE_REQUIRED');
  }
  if (absent(value.noActionConsequence)) {
    throw new Error('OUTCOME_HUMAN_DECISION_NO_ACTION_CONSEQUENCE_REQUIRED');
  }
  if (absent(value.resumeBehavior)) {
    throw new Error('OUTCOME_HUMAN_DECISION_RESUME_BEHAVIOR_REQUIRED');
  }
  if (utf8Bytes(value) > OUTCOME_SURFACE_LIMITS.maxDecisionPayloadBytes) {
    throw new Error('OUTCOME_HUMAN_DECISION_PAYLOAD_TOO_LARGE');
  }
}

export function assertOutcomeSurfaceObligation(
  obligation: OutcomeSurfaceObligation,
  identity: OutcomeCanonicalIdentity,
): void {
  assertDigest(obligation.obligationId, 'obligationId');
  assertDigest(obligation.obligationRevision, 'obligationRevision');
  assertDigest(obligation.bindingDigest, 'bindingDigest');
  assertDigest(identity.bindingDigest, 'canonicalIdentity.bindingDigest');
  assertDigest(identity.proofDigest, 'canonicalIdentity.proofDigest');
  assertLogicalTime(obligation.evaluatedThroughLogicalTime, 'evaluatedThroughLogicalTime');
  assertLogicalTime(identity.evaluatedThroughLogicalTime, 'canonicalIdentity.evaluatedThroughLogicalTime');
  assertLogicalTime(obligation.projectionRevision, 'projectionRevision');
  assertLogicalTime(identity.projectionRevision, 'canonicalIdentity.projectionRevision');
  if (obligation.bindingDigest !== identity.bindingDigest
      || obligation.evaluatedThroughLogicalTime !== identity.evaluatedThroughLogicalTime
      || obligation.projectionRevision !== identity.projectionRevision) {
    throw new Error('OUTCOME_SURFACE_CANONICAL_IDENTITY_DRIFT');
  }
  assertNonEmpty(obligation.kind, 'kind');
  assertNonEmpty(obligation.capability, 'capability');
  if (!['SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL'].includes(obligation.owner)) {
    throw new Error('OUTCOME_SURFACE_OWNER_INVALID');
  }
  if (!isObject(obligation.reason)) throw new Error('OUTCOME_SURFACE_REASON_REQUIRED');
  assertNonEmpty(obligation.reason.code, 'reason.code');
  assertNonEmpty(obligation.reason.message, 'reason.message');
  assertNonEmpty(obligation.reason.nextAction, 'reason.nextAction');
  if (!Array.isArray(obligation.reason.evidenceFactIds)
      || !Array.isArray(obligation.reason.attemptedActions)) {
    throw new Error('OUTCOME_SURFACE_REASON_PROOF_REQUIRED');
  }
}

function ownerDecisionType(kind: string): HumanDecisionType | null {
  switch (kind) {
    case 'REQUEST_GOAL_DECISION': return 'GOAL_DECISION';
    case 'REQUEST_RISK_ACCEPTANCE': return 'RISK_ACCEPTANCE';
    case 'REQUEST_NEW_AUTHORIZATION': return 'NEW_AUTHORIZATION';
    case 'REQUEST_EXTERNAL_IDENTITY': return 'EXTERNAL_IDENTITY';
    default: return null;
  }
}

function matchingDecisionRequest(
  obligation: OutcomeSurfaceObligation,
  requests: readonly OutcomeDecisionRequest[],
): OutcomeDecisionRequest | null {
  const matching = requests.filter((request) => (
    request.obligationId === obligation.obligationId
    && request.obligationRevision === obligation.obligationRevision
    && request.bindingDigest === obligation.bindingDigest
  ));
  // A superseded/decided revision is retained as evidence. Prefer the one still governing the
  // obligation; otherwise a successor for the same semantic obligation would make every surface
  // unavailable merely because its predecessor remains auditable.
  const current = matching.filter((request) => request.status === 'OPEN' || request.status === 'EXPIRED');
  if (current.length > 1) throw new Error('OUTCOME_SURFACE_MULTIPLE_CURRENT_DECISION_REQUESTS');
  return current[0] ?? matching[0] ?? null;
}

function requestUnavailableReason(
  request: OutcomeDecisionRequest | null,
  now: Date,
  logicalNow?: string,
): string | null {
  if (!request) return 'OWNER_DECISION_REQUEST_MISSING';
  if (request.status !== 'OPEN') return `OWNER_DECISION_REQUEST_${request.status}`;
  if (request.expiresAt) {
    const expires = Date.parse(request.expiresAt);
    if (!Number.isFinite(expires) || expires <= now.getTime()) return 'OWNER_DECISION_CTA_EXPIRED';
  }
  if (request.expiresLogicalTime !== null && request.expiresLogicalTime !== undefined) {
    assertLogicalTime(request.expiresLogicalTime, 'request.expiresLogicalTime');
    if (!logicalNow) return 'OWNER_DECISION_LOGICAL_CLOCK_REQUIRED';
    assertLogicalTime(logicalNow, 'logicalNow');
    if (BigInt(request.expiresLogicalTime) <= BigInt(logicalNow)) {
      return 'OWNER_DECISION_CTA_EXPIRED';
    }
  }
  return null;
}

function ctaBinding(
  obligation: OutcomeSurfaceObligation,
  request: OutcomeDecisionRequest | null,
): OutcomeCtaBinding {
  return {
    requestId: request?.requestId ?? null,
    requestRevision: request?.requestRevision ?? null,
    obligationId: obligation.obligationId,
    obligationRevision: obligation.obligationRevision,
    bindingDigest: obligation.bindingDigest,
    evaluatedThroughLogicalTime: obligation.evaluatedThroughLogicalTime,
    projectionRevision: obligation.projectionRevision,
    expiresAt: request?.expiresAt ?? null,
    expiresLogicalTime: request?.expiresLogicalTime ?? null,
  };
}

function deriveItem(input: {
  actor: OutcomeSurfaceActor;
  surface: OutcomeSurface;
  obligation: OutcomeSurfaceObligation;
  requests: readonly OutcomeDecisionRequest[];
  now: Date;
  logicalNow?: string;
}): OutcomeSurfaceItem | null {
  const { actor, surface, obligation } = input;
  const request = matchingDecisionRequest(obligation, input.requests);
  const decisionType = ownerDecisionType(obligation.kind);

  if (surface === 'AGENT_QUEUE' && obligation.owner !== 'AGENT') return null;
  if (surface === 'OWNER_DECISION_INBOX') {
    if (obligation.owner !== 'OWNER') return null;
    if (!decisionType) throw new Error('OUTCOME_HUMAN_INBOX_NON_DECISION_OBLIGATION');
    if (!request) throw new Error('OUTCOME_OWNER_DECISION_REQUEST_MISSING');
    assertOutcomeDecisionProtocol(request.protocol);
    if (request.protocol.decisionType !== decisionType) {
      throw new Error('OUTCOME_OWNER_DECISION_PROTOCOL_KIND_MISMATCH');
    }
  }

  let cta: OutcomeActorCta | null = null;
  let ctaUnavailableReason: string | null = null;
  let decision: HumanDecisionProtocol | null = null;

  if (actor === 'AGENT' && surface === 'AGENT_QUEUE' && obligation.owner === 'AGENT') {
    cta = {
      actor,
      kind: 'EXECUTE',
      label: 'Continue automatically',
      method: 'POST',
      href: `/runner/outcomes/obligations/${encodeURIComponent(obligation.obligationId)}/actions`,
      binding: ctaBinding(obligation, null),
    };
  } else if (actor === 'OWNER' && obligation.owner === 'OWNER' && decisionType) {
    ctaUnavailableReason = requestUnavailableReason(request, input.now, input.logicalNow);
    if (request) {
      assertOutcomeDecisionProtocol(request.protocol);
      decision = redactOutcomePayload(request.protocol) as HumanDecisionProtocol;
    }
    if (!ctaUnavailableReason && request) {
      cta = {
        actor,
        kind: 'DECIDE',
        label: 'Review and decide',
        method: 'POST',
        href: `/outcomes/decisions/${encodeURIComponent(request.requestId)}`,
        binding: ctaBinding(obligation, request),
      };
    }
  } else if ((surface === 'PROJECT_ATTENTION' || surface === 'WEB') && actor === 'OWNER') {
    cta = {
      actor,
      kind: 'VIEW',
      label: obligation.owner === 'AGENT' ? 'View agent progress' : 'View obligation',
      method: 'GET',
      href: `/projects/${encodeURIComponent(String(obligation.binding.projectId ?? ''))}`,
      binding: ctaBinding(obligation, null),
    };
  } else {
    ctaUnavailableReason = `ACTOR_${actor}_DOES_NOT_OWN_${obligation.owner}_ACTION`;
  }

  return {
    semantic: obligation,
    cta,
    decisionRequest: request ? ctaBinding(obligation, request) : null,
    ctaUnavailableReason,
    decision,
  };
}

export function deriveOutcomeSurface(input: {
  projection: OutcomeProjectionInput;
  surface: OutcomeSurface;
  actor: OutcomeSurfaceActor;
  decisionRequests?: readonly OutcomeDecisionRequest[];
  now?: Date;
  logicalNow?: string;
}): DerivedOutcomeSurface {
  if (!OUTCOME_SURFACES.includes(input.surface)) throw new Error('OUTCOME_SURFACE_UNKNOWN');
  if (!['SYSTEM', 'AGENT', 'OWNER'].includes(input.actor)) throw new Error('OUTCOME_SURFACE_ACTOR_UNKNOWN');
  if (utf8Bytes(input.projection) > OUTCOME_SURFACE_LIMITS.maxProjectionBytes) {
    throw new Error('OUTCOME_SURFACE_PROJECTION_TOO_LARGE');
  }
  const redactedProjection = redactOutcomePayload(input.projection) as OutcomeProjectionInput;
  if (!isObject(redactedProjection.canonicalIdentity)) {
    throw new Error('OUTCOME_SURFACE_CANONICAL_IDENTITY_REQUIRED');
  }
  if (redactedProjection.staleness === 'RECONCILER_STALE') {
    if (Object.prototype.hasOwnProperty.call(redactedProjection, 'obligations')) {
      throw new Error('OUTCOME_STALE_PROJECTION_MUST_NOT_ASSERT_EMPTY_OR_PRESENT_WORK');
    }
    return {
      schemaVersion: OUTCOME_SURFACE_SCHEMA_VERSION,
      surface: input.surface,
      actor: input.actor,
      staleness: 'RECONCILER_STALE',
      canonicalIdentity: redactedProjection.canonicalIdentity,
      ...(redactedProjection.doneGate ? { doneGate: redactedProjection.doneGate } : {}),
      ...(redactedProjection.error ? { error: redactedProjection.error } : {}),
    };
  }
  if (!Array.isArray(redactedProjection.obligations)) {
    throw new Error('OUTCOME_CURRENT_PROJECTION_OBLIGATIONS_REQUIRED');
  }
  const requests = input.decisionRequests ?? [];
  for (const request of requests) {
    assertDigest(request.requestRevision, 'request.requestRevision');
    assertDigest(request.obligationId, 'request.obligationId');
    assertDigest(request.obligationRevision, 'request.obligationRevision');
    assertDigest(request.bindingDigest, 'request.bindingDigest');
  }
  for (const obligation of redactedProjection.obligations) {
    assertOutcomeSurfaceObligation(obligation, redactedProjection.canonicalIdentity);
  }
  const items = redactedProjection.obligations
    .map((obligation) => deriveItem({
      actor: input.actor,
      surface: input.surface,
      obligation,
      requests,
      now: input.now ?? new Date(),
      logicalNow: input.logicalNow,
    }))
    .filter((item): item is OutcomeSurfaceItem => item !== null);

  const result: DerivedOutcomeSurface = {
    schemaVersion: OUTCOME_SURFACE_SCHEMA_VERSION,
    surface: input.surface,
    actor: input.actor,
    staleness: 'CURRENT',
    canonicalIdentity: redactedProjection.canonicalIdentity,
    ...(redactedProjection.doneGate ? { doneGate: redactedProjection.doneGate } : {}),
    obligations: redactedProjection.obligations,
    items,
  };
  if (utf8Bytes(result) > OUTCOME_SURFACE_LIMITS.maxProjectionBytes) {
    throw new Error('OUTCOME_SURFACE_RESPONSE_TOO_LARGE');
  }
  return result;
}

/** The semantic tuple every transport must preserve byte-for-byte (CTA intentionally excluded). */
export function outcomeSurfaceSemanticTuple(item: OutcomeSurfaceItem): JsonObject {
  const { semantic } = item;
  return {
    obligationId: semantic.obligationId,
    obligationRevision: semantic.obligationRevision,
    bindingDigest: semantic.bindingDigest,
    binding: semantic.binding,
    reason: semantic.reason,
    owner: semantic.owner,
    evaluatedThroughLogicalTime: semantic.evaluatedThroughLogicalTime,
    projectionRevision: semantic.projectionRevision,
  };
}

/**
 * Contract/fixture guard used by API, CLI and Web parity tests.  OWNER obligations must be in the
 * decision inbox; AGENT obligations must be in the agent queue.  The other surface may be empty —
 * routing agent work to a person is itself a contract violation.
 */
export function assertOutcomeSurfaceSetConsistency(input: {
  doneGate: DerivedOutcomeSurface;
  agentQueue: DerivedOutcomeSurface;
  ownerInbox: DerivedOutcomeSurface;
  projectAttention: DerivedOutcomeSurface;
  web: DerivedOutcomeSurface;
}): void {
  const surfaces = Object.values(input);
  if (surfaces.some((surface) => surface.staleness !== input.doneGate.staleness)) {
    throw new Error('OUTCOME_SURFACE_STALENESS_DRIFT');
  }
  if (input.doneGate.staleness === 'RECONCILER_STALE') return;
  const canonical = JSON.stringify(input.doneGate.canonicalIdentity);
  for (const surface of surfaces) {
    if (JSON.stringify(surface.canonicalIdentity) !== canonical) {
      throw new Error('OUTCOME_SURFACE_IDENTITY_DRIFT');
    }
  }
  const obligations = input.doneGate.obligations ?? [];
  const agentIds = new Set((input.agentQueue.items ?? []).map((item) => item.semantic.obligationId));
  const ownerIds = new Set((input.ownerInbox.items ?? []).map((item) => item.semantic.obligationId));
  if ((input.agentQueue.items ?? []).some((item) => item.semantic.owner !== 'AGENT')) {
    throw new Error('OUTCOME_NON_AGENT_OBLIGATION_IN_AGENT_QUEUE');
  }
  if ((input.ownerInbox.items ?? []).some((item) => item.semantic.owner !== 'OWNER')) {
    throw new Error('OUTCOME_NON_OWNER_OBLIGATION_IN_HUMAN_INBOX');
  }
  for (const obligation of obligations) {
    if (obligation.owner === 'AGENT' && !agentIds.has(obligation.obligationId)) {
      throw new Error('OUTCOME_AGENT_QUEUE_MISSING_DONE_GATE_OBLIGATION');
    }
    if (obligation.owner === 'OWNER' && !ownerIds.has(obligation.obligationId)) {
      throw new Error('OUTCOME_OWNER_INBOX_MISSING_DONE_GATE_OBLIGATION');
    }
    if (obligation.owner !== 'OWNER' && ownerIds.has(obligation.obligationId)) {
      throw new Error('OUTCOME_NON_OWNER_OBLIGATION_IN_HUMAN_INBOX');
    }
  }
  const reference = new Map(obligations.map((entry) => [entry.obligationId, JSON.stringify(entry)]));
  for (const surface of surfaces.slice(1)) {
    for (const item of surface.items ?? []) {
      if (reference.get(item.semantic.obligationId) !== JSON.stringify(item.semantic)) {
        throw new Error('OUTCOME_SURFACE_SEMANTIC_ITEM_DRIFT');
      }
    }
  }
}

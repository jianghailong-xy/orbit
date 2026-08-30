/**
 * The secret-free identity shared by every Owner Ratification entry point.
 *
 * `decisionRequestId` is the owner question. When automatic dispatch has already observed the
 * missing ratification, `obligationId`/`obligationRevision` name that immutable observation and
 * `evaluatedThroughWatermark` is its dependency watermark. A request can precede that observation,
 * so the decision request itself is the conservative fallback obligation: it still has a durable
 * id, monotonic generation, and exact contract revision.
 *
 * Deliberately no CTA field is accepted by this type or builder. Project lists, project detail and
 * the global inbox may be cached as ordinary authenticated reads without turning the one-use
 * decision capability into shared application state.
 */
export interface OwnerRatificationReference {
  kind: 'OWNER_RATIFICATION';
  status: 'PENDING';
  projectId: string;
  projectTitle: string;
  decisionRequestId: string;
  requestRevision: string;
  obligationId: string;
  obligationRevision: string;
  obligationSource:
    | 'AUTO_DISPATCH'
    | 'CANONICAL_OUTCOME'
    | 'CONSTRAINED_ACTION'
    | 'OWNER_DECISION_REQUEST';
  contractDigest: string;
  contractRevision: string;
  reason: string;
  reasonCode: string;
  owner: 'OWNER';
  ownerId: string;
  evaluatedThroughWatermark: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  eligible: true;
  eligibility: OwnerRatificationEligibility;
  linkedObligations: OwnerRatificationLinkedObligation[];
}

export interface OwnerRatificationLinkedObligation {
  obligationSource: 'AUTO_DISPATCH' | 'CANONICAL_OUTCOME' | 'CONSTRAINED_ACTION';
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  evaluatedThroughWatermark: string;
  taskId?: string;
  actionIntentId?: string;
  reasonCode: string;
  sourceReasonCode?: string;
  reason?: unknown;
}

export interface OwnerRatificationEligibility {
  schemaVersion: number;
  eligible: boolean;
  requiresOwnerNow: boolean;
  state: 'ACTIVE' | 'DEFERRED' | 'INELIGIBLE';
  reasonCode: string;
  reason: string;
  projectStatus: string | null;
  bindingStatus: 'MISSING' | 'STALE' | 'EFFECTIVE';
  currentContractDigest?: string | null;
  currentContractRevision?: string | null;
  decisionRequestId?: string | null;
  requestGeneration?: string | null;
  requestRoutingState?: 'ACTIONABLE' | 'DEFERRED' | null;
  requestRoutingReasonCode?: string | null;
  activationSource?: string | null;
  linkedObligations: OwnerRatificationLinkedObligation[];
}

export interface OwnerRatificationReferenceInput {
  projectId: string;
  projectTitle: string;
  ownerId: string;
  requestId: string;
  requestGeneration: bigint | number | string;
  contractDigest: string;
  contractRevision: bigint | number | string;
  reasonCode: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  linkedObligations?: unknown;
  eligibility?: unknown;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function linked(value: unknown): OwnerRatificationLinkedObligation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const row = candidate as Record<string, unknown>;
    const obligationId = typeof row.obligationId === 'string' ? row.obligationId : null;
    const obligationRevision = typeof row.obligationRevision === 'string'
      ? row.obligationRevision
      : null;
    const bindingDigest = typeof row.bindingDigest === 'string' ? row.bindingDigest : null;
    const evaluatedThroughWatermark = typeof row.evaluatedThroughWatermark === 'string'
      ? row.evaluatedThroughWatermark
      : null;
    const taskId = typeof row.taskId === 'string' ? row.taskId : null;
    const actionIntentId = typeof row.actionIntentId === 'string' ? row.actionIntentId : null;
    const reasonCode = typeof row.reasonCode === 'string' ? row.reasonCode : null;
    const obligationSource = typeof row.obligationSource === 'string'
      && ['AUTO_DISPATCH', 'CANONICAL_OUTCOME', 'CONSTRAINED_ACTION'].includes(row.obligationSource)
      ? row.obligationSource as OwnerRatificationLinkedObligation['obligationSource']
      : taskId ? 'AUTO_DISPATCH' : null;
    if (!obligationId || !obligationRevision || !bindingDigest
        || !evaluatedThroughWatermark || !reasonCode || !obligationSource) return [];
    return [{
      obligationSource,
      obligationId,
      obligationRevision,
      bindingDigest,
      evaluatedThroughWatermark,
      ...(taskId ? { taskId } : {}),
      ...(actionIntentId ? { actionIntentId } : {}),
      reasonCode,
      ...(typeof row.sourceReasonCode === 'string'
        ? { sourceReasonCode: row.sourceReasonCode }
        : {}),
      ...('reason' in row ? { reason: row.reason } : {}),
    }];
  });
}

function eligibility(
  value: unknown,
  input: OwnerRatificationReferenceInput,
  linkedObligations: OwnerRatificationLinkedObligation[],
): OwnerRatificationEligibility {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const eligible = row.eligible === undefined ? true : row.eligible === true;
  const reasonCode = typeof row.reasonCode === 'string'
    ? row.reasonCode
    : input.reasonCode;
  const state = row.state === 'DEFERRED' || row.state === 'INELIGIBLE'
    ? row.state
    : 'ACTIVE';
  const bindingStatus = row.bindingStatus === 'STALE' || row.bindingStatus === 'EFFECTIVE'
    ? row.bindingStatus
    : 'MISSING';
  return {
    schemaVersion: typeof row.schemaVersion === 'number' ? row.schemaVersion : 1,
    eligible,
    requiresOwnerNow: row.requiresOwnerNow === undefined ? eligible : row.requiresOwnerNow === true,
    state,
    reasonCode,
    reason: typeof row.reason === 'string' ? row.reason : reasonCode,
    projectStatus: typeof row.projectStatus === 'string' ? row.projectStatus : 'OPEN',
    bindingStatus,
    currentContractDigest: typeof row.currentContractDigest === 'string'
      ? row.currentContractDigest
      : input.contractDigest,
    currentContractRevision: typeof row.currentContractRevision === 'string'
      ? row.currentContractRevision
      : String(input.contractRevision),
    decisionRequestId: typeof row.decisionRequestId === 'string'
      ? row.decisionRequestId
      : input.requestId,
    requestGeneration: typeof row.requestGeneration === 'string'
      ? row.requestGeneration
      : String(input.requestGeneration),
    requestRoutingState: row.requestRoutingState === 'DEFERRED' ? 'DEFERRED' : 'ACTIONABLE',
    requestRoutingReasonCode: typeof row.requestRoutingReasonCode === 'string'
      ? row.requestRoutingReasonCode
      : null,
    activationSource: typeof row.activationSource === 'string' ? row.activationSource : null,
    linkedObligations,
  };
}

export function ownerRatificationReference(
  input: OwnerRatificationReferenceInput,
  now = Date.now(),
): OwnerRatificationReference {
  const requestRevision = String(input.requestGeneration);
  const contractRevision = String(input.contractRevision);
  const rawEligibility = input.eligibility && typeof input.eligibility === 'object'
    && !Array.isArray(input.eligibility)
    ? input.eligibility as Record<string, unknown>
    : {};
  const linkedObligations = linked(
    input.linkedObligations ?? rawEligibility.linkedObligations,
  );
  const activeEligibility = eligibility(input.eligibility, input, linkedObligations);
  if (input.eligibility !== undefined && !activeEligibility.eligible) {
    throw new Error('OWNER_RATIFICATION_REFERENCE_NOT_ELIGIBLE');
  }
  const observed = linkedObligations[0] ?? null;
  const reasonCode = activeEligibility.reasonCode;
  const expiresAt = iso(input.expiresAt);
  return {
    kind: 'OWNER_RATIFICATION',
    status: 'PENDING',
    projectId: input.projectId,
    projectTitle: input.projectTitle,
    decisionRequestId: input.requestId,
    requestRevision,
    obligationId: observed?.obligationId ?? input.requestId,
    obligationRevision: observed?.obligationRevision ?? requestRevision,
    obligationSource: observed?.obligationSource ?? 'OWNER_DECISION_REQUEST',
    contractDigest: input.contractDigest,
    contractRevision,
    reason: activeEligibility.reason,
    reasonCode,
    owner: 'OWNER',
    ownerId: input.ownerId,
    evaluatedThroughWatermark: observed?.evaluatedThroughWatermark ?? contractRevision,
    createdAt: iso(input.createdAt),
    expiresAt,
    expired: Date.parse(expiresAt) <= now,
    eligible: true,
    eligibility: { ...activeEligibility, eligible: true, state: 'ACTIVE' },
    linkedObligations,
  };
}

/**
 * Recursively strips the capability if a rolling server accidentally nests it in future payload
 * detail. This is used only for secret-free projections and structured errors; the dedicated
 * review read returns the capability in its existing private `decisionRequest` envelope.
 */
export function withoutOwnerRatificationCapability(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutOwnerRatificationCapability);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'ctaToken' && key !== 'cta_token')
      .map(([key, nested]) => [key, withoutOwnerRatificationCapability(nested)]),
  );
}

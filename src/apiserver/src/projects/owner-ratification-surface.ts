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
  obligationSource: 'AUTO_DISPATCH' | 'OWNER_DECISION_REQUEST';
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
  linkedObligations: OwnerRatificationLinkedObligation[];
}

export interface OwnerRatificationLinkedObligation {
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  evaluatedThroughWatermark: string;
  taskId: string;
  reasonCode: string;
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
    const reasonCode = typeof row.reasonCode === 'string' ? row.reasonCode : null;
    if (!obligationId || !obligationRevision || !bindingDigest
        || !evaluatedThroughWatermark || !taskId || !reasonCode) return [];
    return [{
      obligationId,
      obligationRevision,
      bindingDigest,
      evaluatedThroughWatermark,
      taskId,
      reasonCode,
    }];
  });
}

export function ownerRatificationReference(
  input: OwnerRatificationReferenceInput,
  now = Date.now(),
): OwnerRatificationReference {
  const requestRevision = String(input.requestGeneration);
  const contractRevision = String(input.contractRevision);
  const linkedObligations = linked(input.linkedObligations);
  const observed = linkedObligations[0] ?? null;
  const reasonCode = observed?.reasonCode ?? input.reasonCode;
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
    obligationSource: observed ? 'AUTO_DISPATCH' : 'OWNER_DECISION_REQUEST',
    contractDigest: input.contractDigest,
    contractRevision,
    reason: reasonCode,
    reasonCode,
    owner: 'OWNER',
    ownerId: input.ownerId,
    evaluatedThroughWatermark: observed?.evaluatedThroughWatermark ?? contractRevision,
    createdAt: iso(input.createdAt),
    expiresAt,
    expired: Date.parse(expiresAt) <= now,
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

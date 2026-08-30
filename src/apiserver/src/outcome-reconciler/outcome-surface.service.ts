import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OutcomeProjectionService } from './outcome-projection.service';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import {
  FAILURE_COORDINATION_SURFACES,
  failureCoordinationByProject,
  readFailureCoordination,
  type FailureCoordinationReadModel,
  type FailureCoordinationSurface,
} from '../common/failure-coordination-read';
import {
  OUTCOME_SURFACES,
  OUTCOME_SURFACE_LIMITS,
  assertOutcomeDecisionProtocol,
  assertOutcomeSurfaceSetConsistency,
  deriveOutcomeSurface,
  redactOutcomePayload,
  type DerivedOutcomeSurface,
  type HumanDecisionProtocol,
  type OutcomeDecisionRequest,
  type OutcomeProjectionInput,
  type OutcomeSurface,
  type OutcomeSurfaceActor,
} from './outcome-surfaces';

interface DecisionRequestRow {
  requestId: string;
  requestRevision: string;
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  reason: string;
  status: 'OPEN' | 'DECIDED' | 'SUPERSEDED';
  expiresLogicalTime: bigint;
  request: Prisma.JsonValue;
  attemptedActions: Prisma.JsonValue;
  logicalNow: bigint;
}

export interface BoundOutcomeDecisionInput {
  requestRevision: string;
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  idempotencyKey: string;
  decision: Record<string, unknown>;
}

const REASON_DECISION_TYPE: Readonly<Record<string, HumanDecisionProtocol['decisionType']>> = {
  GOAL_DECISION: 'GOAL_DECISION',
  RISK_ACCEPTANCE: 'RISK_ACCEPTANCE',
  NEW_AUTHORIZATION: 'NEW_AUTHORIZATION',
  EXTERNAL_IDENTITY: 'EXTERNAL_IDENTITY',
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedRedacted<T>(value: T, maxBytes = OUTCOME_SURFACE_LIMITS.maxProjectionBytes): T {
  const safe = redactOutcomePayload(value) as T;
  if (Buffer.byteLength(JSON.stringify(safe), 'utf8') > maxBytes) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'OUTCOME_SURFACE_RESPONSE_TOO_LARGE',
    });
  }
  return safe;
}

function requestProtocol(row: DecisionRequestRow): HumanDecisionProtocol {
  const request = record(row.request);
  return {
    decisionType: REASON_DECISION_TYPE[row.reason] ?? 'GOAL_DECISION',
    // Older coordinator requests predate this presentation field. Their immutable semantic reason
    // already carries the attempts, so the read adapter can supply it without changing identity.
    agentWorkCompleted: array(request.agentWorkCompleted).length > 0
      ? array(request.agentWorkCompleted)
      : array(row.attemptedActions),
    whyNotAgent: String(request.whyNotAgent ?? ''),
    options: array(request.options),
    impacts: array(request.impacts),
    recommendation: request.recommendation ?? null,
    cost: request.cost ?? null,
    deadline: request.deadline ?? { logicalTime: row.expiresLogicalTime.toString() },
    noActionConsequence: request.noActionConsequence ?? null,
    resumeBehavior: request.resumeBehavior ?? null,
  };
}

/**
 * Transport-neutral facade for API, runner/CLI and Web. The database projection contributes only
 * semantic facts; this service derives the CTA after tenant authorization and strips credentials
 * before a response exists.
 */
@Injectable()
export class OutcomeSurfaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projections: OutcomeProjectionService,
    private readonly acceptance: ProjectAcceptanceService,
  ) {}

  parseSurface(value: string): OutcomeSurface {
    const surface = value.toUpperCase() as OutcomeSurface;
    if (!OUTCOME_SURFACES.includes(surface)) {
      throw new BadRequestException(`surface must be one of ${OUTCOME_SURFACES.join(', ')}`);
    }
    return surface;
  }

  parseFailureSurface(value: string): FailureCoordinationSurface {
    const surface = value.toUpperCase() as FailureCoordinationSurface;
    if (!FAILURE_COORDINATION_SURFACES.includes(surface)) {
      throw new BadRequestException(
        `surface must be one of ${FAILURE_COORDINATION_SURFACES.join(', ')}`,
      );
    }
    return surface;
  }

  async readProjectSurface(input: {
    tenantId: string;
    projectId: string;
    surface: OutcomeSurface;
    actor: OutcomeSurfaceActor;
  }): Promise<DerivedOutcomeSurface & { failureContinuations: FailureCoordinationReadModel }> {
    await this.assertProjectTenant(input.tenantId, input.projectId);
    let projection: Prisma.JsonValue;
    try {
      projection = await this.projections.readSurface({
        tenantId: input.tenantId,
        projectId: input.projectId,
        subjectType: 'PROJECT',
        subjectId: input.projectId,
        surface: input.surface,
      });
    } catch (error) {
      // A missing stream/projection is an unavailable control plane, never an empty queue.
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'OUTCOME_PROJECTION_UNAVAILABLE',
        staleness: 'RECONCILER_STALE',
        message: error instanceof Error ? error.message : 'Outcome projection unavailable',
      });
    }
    const requests = await this.currentDecisionRequests(input.tenantId, input.projectId);
    const logicalNow = requests[0]?.logicalNow.toString()
      ?? String(record(record(projection).canonicalIdentity).evaluatedThroughLogicalTime ?? '0');
    let derived: DerivedOutcomeSurface;
    try {
      derived = deriveOutcomeSurface({
        projection: projection as unknown as OutcomeProjectionInput,
        surface: input.surface,
        actor: input.actor,
        decisionRequests: requests.map((row) => this.decisionRequest(row)),
        logicalNow,
      });
    } catch (error) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: error instanceof Error ? error.message : 'OUTCOME_SURFACE_INVALID',
      });
    }
    const failureContinuations = await this.readFailureProjectSurface(
      input.tenantId,
      input.projectId,
      input.surface === 'AGENT_QUEUE'
        ? 'AGENT_QUEUE'
        : input.surface === 'PROJECT_ATTENTION'
          ? 'PROJECT_ATTENTION'
          : input.surface === 'OWNER_DECISION_INBOX'
            ? 'OWNER_DECISION_INBOX'
            : 'PROJECT_WORK_OVERVIEW',
    );
    return { ...derived, failureContinuations };
  }

  /** Failure Continuations remain readable even when a project has no generic outcome stream. */
  async readFailureProjectSurface(
    tenantId: string,
    projectId: string,
    surface: FailureCoordinationSurface,
  ): Promise<FailureCoordinationReadModel> {
    await this.assertProjectTenant(tenantId, projectId);
    return readFailureCoordination(this.prisma, {
      tenantId,
      projectIds: [projectId],
      surface,
    });
  }

  /** A fail-closed, bounded human surface. Ratification is tagged separately and never masquerades
   * as a HUMAN_SIGNOFF or as a canonical owner obligation. */
  async humanInbox(tenantId: string, limit = 100): Promise<Record<string, unknown>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const projects = await this.prisma.project.findMany({
      where: { ownerId: tenantId },
      select: { id: true, title: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    const canonical: Array<Record<string, unknown>> = [];
    const failureInbox = await readFailureCoordination(this.prisma, {
      tenantId,
      projectIds: projects.map((project) => project.id),
      surface: 'OWNER_DECISION_INBOX',
    });
    const failuresByProject = failureCoordinationByProject(failureInbox);
    for (const project of projects) {
      for (const item of failuresByProject.get(project.id)?.items ?? []) {
        canonical.push({
          itemType: 'FAILURE_CONTINUATION_OWNER_DECISION',
          decisionType: 'FAILURE_CONTINUATION_OWNER_DECISION',
          projectTitle: project.title,
          ...item,
        });
      }
      // Select from the durable binding, not the projection. If a bound project is
      // stale or has no materialized row yet, readProjectSurface must return the
      // explicit stale envelope instead of letting the inbox look empty.
      const hasSurfaceBinding = await this.prisma.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1 FROM outcome_fact_binding
           WHERE tenant_id = ${tenantId}::uuid AND project_id = ${project.id}::uuid
             AND subject_type = 'PROJECT' AND subject_id = ${project.id}
        ) AS present
      `);
      if (!hasSurfaceBinding[0]?.present) continue;
      const [doneGate, agentQueue, ownerInbox, projectAttention, web] = await Promise.all([
        this.readProjectSurface({ tenantId, projectId: project.id, surface: 'DONE_GATE', actor: 'SYSTEM' }),
        this.readProjectSurface({ tenantId, projectId: project.id, surface: 'AGENT_QUEUE', actor: 'AGENT' }),
        this.readProjectSurface({ tenantId, projectId: project.id, surface: 'OWNER_DECISION_INBOX', actor: 'OWNER' }),
        this.readProjectSurface({ tenantId, projectId: project.id, surface: 'PROJECT_ATTENTION', actor: 'OWNER' }),
        this.readProjectSurface({ tenantId, projectId: project.id, surface: 'WEB', actor: 'OWNER' }),
      ]);
      try {
        assertOutcomeSurfaceSetConsistency({
          doneGate, agentQueue, ownerInbox, projectAttention, web,
        });
      } catch (error) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: error instanceof Error ? error.message : 'OUTCOME_SURFACE_SET_INCONSISTENT',
        });
      }
      for (const item of ownerInbox.items ?? []) {
        canonical.push({ projectId: project.id, projectTitle: project.title, ...item });
      }
    }

    const ratifications = await this.ratificationInbox(tenantId, limit);
    const candidates = [...ratifications, ...canonical];
    const total = candidates.length;
    const items: Array<Record<string, unknown>> = [];
    for (const candidate of candidates.slice(0, Math.min(limit, OUTCOME_SURFACE_LIMITS.maxArrayItems))) {
      const safe = boundedRedacted(candidate);
      const prospective = { schemaVersion: 2, actor: 'OWNER', surface: 'HUMAN_DECISION_INBOX', items: [...items, safe] };
      if (Buffer.byteLength(JSON.stringify(prospective), 'utf8') > OUTCOME_SURFACE_LIMITS.maxProjectionBytes) break;
      items.push(safe);
    }
    return boundedRedacted({
      schemaVersion: 2,
      actor: 'OWNER',
      surface: 'HUMAN_DECISION_INBOX',
      total,
      items,
      truncated: items.length < total,
      failureContinuationIndex: failureInbox.semanticIndex,
      decisionTypeSeparation: {
        ownerRatification: 'OWNER_RATIFICATION',
        perItemSignoff: 'HUMAN_SIGNOFF',
        canonicalOwnerKinds: ['GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'],
      },
    });
  }

  async decideOwnerRequest(
    tenantId: string,
    requestId: string,
    input: BoundOutcomeDecisionInput,
  ): Promise<Record<string, unknown>> {
    if (!input || !input.idempotencyKey?.trim()
        || input.decision === null || typeof input.decision !== 'object'
        || Array.isArray(input.decision)) {
      throw new BadRequestException('idempotencyKey and decision object are required');
    }
    const serialized = JSON.stringify(input.decision);
    if (Buffer.byteLength(serialized, 'utf8') > OUTCOME_SURFACE_LIMITS.maxDecisionPayloadBytes) {
      throw new BadRequestException('OUTCOME_HUMAN_DECISION_PAYLOAD_TOO_LARGE');
    }
    if (JSON.stringify(redactOutcomePayload(input.decision)) !== serialized) {
      throw new BadRequestException('OUTCOME_HUMAN_DECISION_SECRET_FORBIDDEN');
    }
    const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
      SELECT outcome_decide_coordinator_owner_request(
        ${tenantId}::uuid,
        ${requestId}::uuid,
        ${input.requestRevision},
        ${input.obligationId},
        ${input.obligationRevision},
        ${input.bindingDigest},
        ${input.idempotencyKey},
        ${serialized}::jsonb
      ) AS result
    `);
    if (!row) throw new ConflictException('Outcome owner decision returned no receipt');
    return redactOutcomePayload(row.result) as Record<string, unknown>;
  }

  async ownerDecisionView(tenantId: string, requestId: string): Promise<Record<string, unknown>> {
    const [row] = await this.prisma.$queryRaw<Array<{ projectId: string }>>(Prisma.sql`
      SELECT request.project_id AS "projectId"
        FROM outcome_coordinator_owner_decision_request request
        JOIN project ON project.id = request.project_id
       WHERE request.tenant_id = ${tenantId}::uuid
         AND project.owner_id = ${tenantId}::uuid
         AND request.request_id = ${requestId}::uuid
    `);
    if (!row) throw new NotFoundException('decision request not found');
    const surface = await this.readProjectSurface({
      tenantId,
      projectId: row.projectId,
      surface: 'OWNER_DECISION_INBOX',
      actor: 'OWNER',
    });
    const item = surface.items?.find(
      (candidate) => candidate.decisionRequest?.requestId === requestId,
    );
    if (!item) throw new ConflictException('decision request is not current');
    return { projectId: row.projectId, canonicalIdentity: surface.canonicalIdentity, ...item };
  }

  /** Owner Ratification has its own revision and authority protocol. The opaque CTA token is
   * resolved on the server and therefore never enters an API, CLI, log or browser payload. */
  async ratificationView(tenantId: string, projectId: string): Promise<Record<string, unknown>> {
    await this.assertProjectTenant(tenantId, projectId);
    const state = await this.acceptance.ownerRatification(tenantId, projectId);
    const request = record(state.decisionRequest);
    const safeRequest = Object.fromEntries(
      Object.entries(request).filter(([key]) => key !== 'ctaToken'),
    );
    const payload = record(redactOutcomePayload(request.payload));
    const protocol: HumanDecisionProtocol | null = Object.keys(request).length === 0 ? null : {
      decisionType: 'OWNER_RATIFICATION',
      agentWorkCompleted: array(payload.agentWorkCompleted),
      whyNotAgent: String(payload.whyNotAgent ?? ''),
      options: array(payload.options),
      impacts: array(payload.impacts).length > 0 ? array(payload.impacts) : [payload.impact],
      recommendation: payload.recommendation ?? payload.recommended,
      cost: payload.cost ?? payload.costAndDeadline,
      deadline: payload.deadline ?? { expiresAt: request.expiresAt },
      noActionConsequence: payload.noActionConsequence ?? payload.consequenceOfNoAction,
      resumeBehavior: payload.resumeBehavior ?? payload.resumeAfterDecision,
    };
    if (protocol) assertOutcomeDecisionProtocol(protocol);
    return boundedRedacted({
      ...state,
      decisionRequest: Object.keys(request).length === 0 ? null : {
        ...safeRequest,
        payload,
        requestRevision: `${String(state.contractRevision)}:${String(request.requestGeneration)}`,
        protocol: protocol!,
      },
      decisionType: 'OWNER_RATIFICATION',
      separation: 'Owner Ratification approves the project contract; it is not per-item HUMAN_SIGNOFF.',
    }) as Record<string, unknown>;
  }

  async decideRatification(tenantId: string, requestId: string, input: {
    requestRevision: string;
    contractDigest: string;
    decision: 'APPROVE' | 'DENY';
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    if (!input || !['APPROVE', 'DENY'].includes(input.decision)
        || !input.idempotencyKey?.trim()) {
      throw new BadRequestException('decision and idempotencyKey are required');
    }
    const [request] = await this.prisma.$queryRaw<Array<{
      projectId: string;
      contractDigest: string;
      contractRevision: bigint;
      requestGeneration: bigint;
      ctaToken: string;
      expiresAt: Date;
      status: string;
    }>>(Prisma.sql`
      SELECT request.project_id AS "projectId", request.contract_digest AS "contractDigest",
             request.contract_revision AS "contractRevision",
             request.request_generation AS "requestGeneration", request.cta_token AS "ctaToken",
             request.expires_at AS "expiresAt", request.status
        FROM project_owner_decision_request request
        JOIN project ON project.id = request.project_id
       WHERE request.id = ${requestId}::uuid AND request.owner_id = ${tenantId}::uuid
         AND project.owner_id = ${tenantId}::uuid
    `);
    if (!request) throw new NotFoundException('ratification request not found');
    const revision = `${request.contractRevision}:${request.requestGeneration}`;
    if (request.status !== 'PENDING' || request.expiresAt.getTime() <= Date.now()
        || input.requestRevision !== revision || input.contractDigest !== request.contractDigest) {
      throw new ConflictException('OWNER_RATIFICATION_CTA_STALE_OR_EXPIRED');
    }
    return this.acceptance.ratifyByOwner(tenantId, request.projectId, {
      expectedContractDigest: request.contractDigest,
      decisionRequestId: requestId,
      ctaToken: request.ctaToken,
      decision: input.decision,
      idempotencyKey: input.idempotencyKey,
    });
  }

  private async assertProjectTenant(tenantId: string, projectId: string): Promise<void> {
    const owned = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId: tenantId },
      select: { id: true },
    });
    // Deliberately the same response for an absent project and another tenant's project.
    if (!owned) throw new NotFoundException('project not found');
  }

  private async currentDecisionRequests(
    tenantId: string,
    projectId: string,
  ): Promise<DecisionRequestRow[]> {
    return this.prisma.$queryRaw<DecisionRequestRow[]>(Prisma.sql`
      SELECT request.request_id AS "requestId",
             request.request_revision AS "requestRevision",
             request.obligation_id AS "obligationId",
             request.obligation_revision AS "obligationRevision",
             request.binding_digest AS "bindingDigest",
             request.reason,
             request.status,
             request.expires_logical_time AS "expiresLogicalTime",
             request.request,
             COALESCE((
               SELECT revision.source_obligation#>'{reason,attemptedActions}'
                 FROM outcome_coordinator_obligation_revision revision
                WHERE revision.tenant_id = request.tenant_id
                  AND revision.project_id = request.project_id
                  AND revision.obligation_id = request.obligation_id
                  AND revision.obligation_revision = request.obligation_revision
                  AND revision.binding_digest = request.binding_digest
                ORDER BY revision.created_logical_time DESC, revision.coordination_revision DESC
                LIMIT 1
             ), '[]'::jsonb) AS "attemptedActions",
             clock.logical_time AS "logicalNow"
        FROM outcome_coordinator_owner_decision_request request
        JOIN outcome_coordinator_clock clock ON clock.tenant_id = request.tenant_id
       WHERE request.tenant_id = ${tenantId}::uuid
         AND request.project_id = ${projectId}::uuid
         AND request.status IN ('OPEN', 'DECIDED', 'SUPERSEDED')
       ORDER BY request.requested_logical_time DESC, request.request_id DESC
    `);
  }

  private decisionRequest(row: DecisionRequestRow): OutcomeDecisionRequest {
    const expired = row.status === 'OPEN' && row.expiresLogicalTime <= row.logicalNow;
    return {
      requestId: row.requestId,
      requestRevision: row.requestRevision,
      obligationId: row.obligationId,
      obligationRevision: row.obligationRevision,
      bindingDigest: row.bindingDigest,
      status: expired ? 'EXPIRED' : row.status,
      expiresLogicalTime: row.expiresLogicalTime.toString(),
      protocol: requestProtocol(row),
    };
  }

  private async ratificationInbox(tenantId: string, limit: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.$queryRaw<Array<{
      requestId: string;
      projectId: string;
      projectTitle: string;
      contractDigest: string;
      contractRevision: bigint;
      requestGeneration: bigint;
      reasonCode: string;
      semanticDiff: Prisma.JsonValue;
      payload: Prisma.JsonValue;
      expiresAt: Date;
      eligibility: Prisma.JsonValue;
    }>>(Prisma.sql`
      SELECT request.id AS "requestId", request.project_id AS "projectId",
             project.title AS "projectTitle", request.contract_digest AS "contractDigest",
             request.contract_revision AS "contractRevision",
             request.request_generation AS "requestGeneration",
             routing.value->>'reasonCode' AS "reasonCode",
             request.semantic_diff AS "semanticDiff",
             request.decision_payload AS payload, request.expires_at AS "expiresAt",
             routing.value AS eligibility
        FROM project_owner_decision_request request
        JOIN project ON project.id = request.project_id AND project.owner_id = ${tenantId}::uuid
       CROSS JOIN LATERAL (
         SELECT project_owner_ratification_eligibility(
           request.owner_id, request.project_id, request.id
         ) AS value
       ) routing
       WHERE request.owner_id = ${tenantId}::uuid AND request.status = 'PENDING'
         AND routing.value->>'eligible' = 'true'
       ORDER BY request.created_at DESC, request.id DESC
       LIMIT ${limit}
    `);
    return rows.map((row) => {
      const payload = record(redactOutcomePayload(row.payload));
      const eligibility = record(redactOutcomePayload(row.eligibility));
      const primary = record(array(eligibility.linkedObligations)[0]);
      const obligationId = String(primary.obligationId ?? row.requestId);
      const obligationRevision = String(
        primary.obligationRevision ?? row.requestGeneration,
      );
      const bindingDigest = String(primary.bindingDigest ?? row.contractDigest);
      const evaluatedThroughWatermark = String(
        primary.evaluatedThroughWatermark ?? row.contractRevision,
      );
      const protocol: HumanDecisionProtocol = {
        decisionType: 'OWNER_RATIFICATION',
        agentWorkCompleted: array(payload.agentWorkCompleted),
        whyNotAgent: String(payload.whyNotAgent ?? ''),
        options: array(payload.options),
        impacts: array(payload.impacts).length > 0 ? array(payload.impacts) : [payload.impact],
        recommendation: payload.recommendation ?? payload.recommended ?? null,
        cost: payload.cost ?? payload.costAndDeadline ?? null,
        deadline: payload.deadline ?? { expiresAt: row.expiresAt.toISOString() },
        noActionConsequence: payload.noActionConsequence ?? payload.consequenceOfNoAction ?? null,
        resumeBehavior: payload.resumeBehavior ?? payload.resumeAfterDecision ?? null,
      };
      assertOutcomeDecisionProtocol(protocol);
      return boundedRedacted({
        decisionType: 'OWNER_RATIFICATION',
        projectId: row.projectId,
        projectTitle: row.projectTitle,
        requestId: row.requestId,
        requestRevision: `${row.contractRevision}:${row.requestGeneration}`,
        contractDigest: row.contractDigest,
        reasonCode: row.reasonCode,
        reason: eligibility.reason,
        obligationId,
        obligationRevision,
        bindingDigest,
        evaluatedThroughWatermark,
        eligibility,
        semanticDiff: redactOutcomePayload(row.semanticDiff),
        protocol,
        cta: {
          actor: 'OWNER',
          kind: 'DECIDE',
          label: 'Review owner ratification',
          method: 'POST',
          href: `/outcomes/ratifications/${row.requestId}`,
          binding: {
            requestId: row.requestId,
            requestRevision: `${row.contractRevision}:${row.requestGeneration}`,
            contractDigest: row.contractDigest,
            obligationId,
            obligationRevision,
            bindingDigest,
            evaluatedThroughWatermark,
            reasonCode: row.reasonCode,
            expiresAt: row.expiresAt.toISOString(),
          },
        },
      });
    });
  }
}

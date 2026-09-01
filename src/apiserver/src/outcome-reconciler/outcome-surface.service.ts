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
  assertOutcomeSurfaceSetConsistency,
  deriveOutcomeSurface,
  redactOutcomePayload,
  type DerivedOutcomeSurface,
  type OutcomeProjectionInput,
  type OutcomeSurface,
  type OutcomeSurfaceActor,
} from './outcome-surfaces';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
    // The persistent coordinator that opened owner-decision requests is gone with its tables;
    // the surface is derived from the projection alone.
    const logicalNow =
      String(record(record(projection).canonicalIdentity).evaluatedThroughLogicalTime ?? '0');
    let derived: DerivedOutcomeSurface;
    try {
      derived = deriveOutcomeSurface({
        projection: projection as unknown as OutcomeProjectionInput,
        surface: input.surface,
        actor: input.actor,
        decisionRequests: [],
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

  /** A fail-closed, bounded human surface. A canonical owner obligation never masquerades as a
   * per-item HUMAN_SIGNOFF. */
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

    const candidates = [...canonical];
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
        perItemSignoff: 'HUMAN_SIGNOFF',
        canonicalOwnerKinds: ['GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'],
      },
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

}

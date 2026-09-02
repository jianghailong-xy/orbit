import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  FAILURE_COORDINATION_SURFACES,
  failureCoordinationByProject,
  readFailureCoordination,
  type FailureCoordinationReadModel,
  type FailureCoordinationSurface,
} from '../common/failure-coordination-read';
import {
  OUTCOME_SURFACE_LIMITS,
  redactOutcomePayload,
} from './outcome-payload-redaction';

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
 * Transport-neutral facade for API, runner/CLI and Web over the Failure Continuation surfaces.
 *
 * The canonical obligation surfaces this class also served were removed with the obligation
 * algebra: there is no projection left to read, so `GET /outcomes/projects/:id/:surface` and the
 * runner's `project_obligations` are gone rather than answering with a manufactured empty queue.
 * Failure Continuations were never part of that machinery and are unchanged.
 */
@Injectable()
export class OutcomeSurfaceService {
  constructor(private readonly prisma: PrismaService) {}

  parseFailureSurface(value: string): FailureCoordinationSurface {
    const surface = value.toUpperCase() as FailureCoordinationSurface;
    if (!FAILURE_COORDINATION_SURFACES.includes(surface)) {
      throw new BadRequestException(
        `surface must be one of ${FAILURE_COORDINATION_SURFACES.join(', ')}`,
      );
    }
    return surface;
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

  /** A fail-closed, bounded human surface. */
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
    const candidates: Array<Record<string, unknown>> = [];
    const failureInbox = await readFailureCoordination(this.prisma, {
      tenantId,
      projectIds: projects.map((project) => project.id),
      surface: 'OWNER_DECISION_INBOX',
    });
    const failuresByProject = failureCoordinationByProject(failureInbox);
    for (const project of projects) {
      for (const item of failuresByProject.get(project.id)?.items ?? []) {
        candidates.push({
          itemType: 'FAILURE_CONTINUATION_OWNER_DECISION',
          decisionType: 'FAILURE_CONTINUATION_OWNER_DECISION',
          projectTitle: project.title,
          ...item,
        });
      }
    }

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
        perItemJudgment: 'EVIDENCE_JUDGMENT',
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

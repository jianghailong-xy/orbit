import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  taskAttribution,
  type AttributionBlocker,
  type AttributionCrossing,
  type AttributionProjectRef,
  type TaskAttribution,
} from './project-attribution-surface';
import { SCOPE_REFUSAL_CODES, SCOPE_RULE_BY_ID, type ScopeRefusalCode } from './project-scope-contract';

/**
 * Unit L7: the reads behind one task's attribution boundary.
 *
 * Every field this returns already existed in some table before this unit; none of it was readable
 * from any client. The service is deliberately thin — it fetches rows and hands them to
 * `taskAttribution`, which is pure — so that "is this PASS current" is decided in a module a test
 * can run without a database, and so the web app and the CLI cannot each answer it differently.
 *
 * Scoped by owner at every query, not just the first. A task read under one account whose
 * acceptance criteria were read under none would be a cross-tenant read wearing a per-task
 * permission check, and §3 SC6's "one authoritative attribution column" is only worth anything if
 * the things hanging off it are constrained the same way.
 */
@Injectable()
export class ProjectAttributionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A project, in the shape every attribution surface names one.
   *
   * `null` in, `null` out: a task filed under no project is a legal state, and the caller reports
   * it with an absent reason rather than with a project that does not exist.
   */
  private static projectRef(
    project: { id: string; title: string; status: string; acceptanceEpoch: bigint } | null,
  ): AttributionProjectRef | null {
    if (!project) return null;
    return {
      projectId: project.id,
      title: project.title,
      status: project.status as AttributionProjectRef['status'],
      acceptanceEpoch: String(project.acceptanceEpoch),
    };
  }

  /** The scope refusal code a blocker's detail recorded, or null when it recorded none of ours. */
  private static scopeCodeOf(detail: unknown): ScopeRefusalCode | null {
    if (!detail || typeof detail !== 'object') return null;
    const code = (detail as Record<string, unknown>).refusalCode;
    return typeof code === 'string' && (SCOPE_REFUSAL_CODES as readonly string[]).includes(code)
      ? (code as ScopeRefusalCode)
      : null;
  }

  async read(ownerId: string, taskId: string): Promise<TaskAttribution> {
    const PROJECT_REF = {
      select: { id: true, title: true, status: true, acceptanceEpoch: true },
    } as const;
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId },
      select: {
        id: true,
        projectId: true,
        project: PROJECT_REF,
        triggerEvent: true,
        discoveredFromProject: PROJECT_REF,
        sourceTask: { select: { id: true, title: true } },
        sourceSession: { select: { id: true, title: true } },
      },
    });
    if (!task) throw new NotFoundException('task not found');

    const [criteria, crossing, blockers] = await Promise.all([
      // The criteria of THIS task's project that name it as their evidence — the mapping "which
      // stated criterion does this piece of work answer" that is otherwise only readable by
      // opening every acceptance attempt and looking for the id. Constrained to the owning project
      // as well as the owner: a criterion in another project citing this task is not this task's
      // acceptance, and rendering it beside the project's own would be the surface asserting a
      // cross-project claim it has no authority to make.
      task.projectId
        ? this.prisma.projectAcceptanceCriterion.findMany({
            where: { evidenceTaskId: taskId, projectId: task.projectId },
            select: {
              ordinal: true,
              criterionKey: true,
              criterionText: true,
              verdict: true,
              run: {
                select: {
                  id: true, attempt: true, acceptanceEpoch: true, supersededAt: true,
                },
              },
            },
            orderBy: [{ run: { attempt: 'desc' } }, { ordinal: 'asc' }],
          })
        : Promise.resolve([]),
      // The declared crossing this task is the subject of, or the one that produced it. Newest
      // first: a task can be the subject of a crossing that was denied and of a later one that was
      // approved, and the answer a reader needs is the one that is live.
      this.prisma.projectHandoffApproval.findFirst({
        where: { ownerId, OR: [{ subjectTaskId: taskId }, { appliedTaskId: taskId }] },
        select: {
          id: true,
          kind: true,
          state: true,
          subjectTaskId: true,
          crossingKey: true,
          requestedAt: true,
          decidedAt: true,
          expiresAt: true,
          fromProject: PROJECT_REF,
          toProject: PROJECT_REF,
        },
        orderBy: { requestedAt: 'desc' },
      }),
      // Open blockers about this task. Filtered for the attribution ones in memory rather than in
      // SQL: the discriminator is a key inside a JSON column, and a query that indexed on it would
      // be a second spelling of `SCOPE_REFUSAL_CODES` living in a WHERE clause.
      this.prisma.projectBlocker.findMany({
        where: {
          subjectType: 'TASK',
          subjectId: taskId,
          resolvedAt: null,
          project: { ownerId },
        },
        select: {
          id: true, kind: true, owner: true, requiredAction: true, nextCheckAt: true, detail: true,
          lastSeenAt: true,
        },
        orderBy: { lastSeenAt: 'desc' },
      }),
    ]);

    const attributionBlocker = blockers
      .map((row) => ({ row, code: ProjectAttributionService.scopeCodeOf(row.detail) }))
      .find((candidate) => candidate.code !== null);
    const blocker: AttributionBlocker | null = attributionBlocker
      ? {
          blockerId: attributionBlocker.row.id,
          kind: attributionBlocker.row.kind,
          owner: attributionBlocker.row.owner,
          requiredAction: attributionBlocker.row.requiredAction,
          nextCheckAt: attributionBlocker.row.nextCheckAt.toISOString(),
          code: attributionBlocker.code,
        }
      : null;

    const crossingView: AttributionCrossing | null = crossing
      ? {
          handoffId: crossing.id,
          kind: crossing.kind,
          state: crossing.state as AttributionCrossing['state'],
          from: ProjectAttributionService.projectRef(crossing.fromProject),
          to: ProjectAttributionService.projectRef(crossing.toProject),
          subjectTaskId: crossing.subjectTaskId,
          crossingKey: crossing.crossingKey,
          requestedAt: crossing.requestedAt.toISOString(),
          decidedAt: crossing.decidedAt?.toISOString() ?? null,
          expiresAt: crossing.expiresAt?.toISOString() ?? null,
          // What a writer meeting this crossing is told right now. A PENDING question refuses with
          // the code L1 froze for it; an answered one no longer refuses anything, and saying so
          // with null is what stops a settled row from reading like a live refusal.
          ...crossingRefusal(crossing.state),
        }
      : null;

    return taskAttribution({
      taskId: task.id,
      owning: ProjectAttributionService.projectRef(task.project),
      discovery: {
        project: ProjectAttributionService.projectRef(task.discoveredFromProject),
        triggerEvent: task.triggerEvent,
        task: task.sourceTask ? { taskId: task.sourceTask.id, title: task.sourceTask.title } : null,
        session: task.sourceSession
          ? { sessionId: task.sourceSession.id, title: task.sourceSession.title }
          : null,
      },
      acceptance: criteria.map((criterion) => ({
        runId: criterion.run.id,
        attempt: String(criterion.run.attempt),
        ordinal: criterion.ordinal,
        criterionKey: criterion.criterionKey,
        text: criterion.criterionText,
        verdict: criterion.verdict as 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null,
        epoch: String(criterion.run.acceptanceEpoch),
        runSuperseded: criterion.run.supersededAt !== null,
      })),
      crossing: crossingView,
      blocker,
    });
  }
}

/**
 * The code and required action a crossing in this state produces for a writer meeting it.
 *
 * Looked up by RULE rather than written again here, because §5 EC3 hangs `requiredAction` off the
 * rule and not off the code: a crossing that is still a question is R11, one that was answered no
 * is R12, and those two share neither answer. A second copy of that mapping is how a screen ends
 * up telling somebody to do a thing the server would refuse.
 */
const CROSSING_RULE: Readonly<Record<string, string>> = {
  PENDING: 'R11_APPROVAL_PENDING',
  DENIED: 'R12_APPROVAL_DENIED',
};

function crossingRefusal(state: string): {
  code: ScopeRefusalCode | null;
  requiredAction: AttributionCrossing['requiredAction'];
} {
  const rule = CROSSING_RULE[state] ? SCOPE_RULE_BY_ID[CROSSING_RULE[state]] : null;
  return { code: rule?.code ?? null, requiredAction: rule?.requiredAction ?? null };
}

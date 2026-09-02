import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DecideTaskJudgmentDto } from './dto';
import { TasksService } from './tasks.service';

type JsonObject = Record<string, unknown>;

const inboxInclude = {
  request: {
    include: {
      evidence: true,
    },
  },
  task: {
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      projectId: true,
      acceptanceCriteria: true,
      completionCriterion: true,
      project: { select: { id: true, title: true } },
      dependsOn: { select: { dependsOnTaskId: true } },
      dependedOnBy: { select: { taskId: true } },
    },
  },
  pushDelivery: {
    select: {
      status: true,
      attempts: true,
      lastError: true,
      deliveredAt: true,
      stoppedAt: true,
    },
  },
} satisfies Prisma.TaskJudgmentInboxItemInclude;

type InboxRow = Prisma.TaskJudgmentInboxItemGetPayload<{ include: typeof inboxInclude }>;

const historyInclude = {
  judgmentRequests: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.TaskCompletionEvidenceInclude;

type HistoryRow = Prisma.TaskCompletionEvidenceGetPayload<{ include: typeof historyInclude }>;

export type HumanJudgmentReviewState =
  | 'ACTION_REQUIRED'
  | 'AWAITING_NEW_EVIDENCE'
  | 'APPROVED'
  | 'SUPERSEDED'
  | 'DECIDED'
  | 'EVIDENCE_REVISED';

function reviewState(
  request: Pick<InboxRow['request'], 'status' | 'decision'>,
  requestedEvidenceId: string,
  currentEvidenceId: string,
): HumanJudgmentReviewState {
  if (request.status === 'OPEN') return 'ACTION_REQUIRED';
  if (request.status === 'SUPERSEDED') return 'SUPERSEDED';
  if (request.decision === 'PASS') return 'APPROVED';
  if (request.decision === 'INCONCLUSIVE') {
    return requestedEvidenceId === currentEvidenceId
      ? 'AWAITING_NEW_EVIDENCE'
      : 'EVIDENCE_REVISED';
  }
  return 'DECIDED';
}

function asObject(value: Prisma.JsonValue): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Pull the two high-frequency review facts out without discarding the full structured object. */
export function completionEvidenceHighlights(evidenceValue: Prisma.JsonValue): {
  commit: string | null;
  testSummary: unknown | null;
} {
  const evidence = asObject(evidenceValue);
  const commitValue = evidence.commit ?? evidence.commitSha ?? evidence.commitSHA
    ?? evidence.gitCommit ?? evidence.sha;
  const commit = stringValue(commitValue)
    ?? (commitValue && typeof commitValue === 'object' && !Array.isArray(commitValue)
      ? stringValue((commitValue as JsonObject).sha ?? (commitValue as JsonObject).id)
      : null);
  const testSummary = evidence.testSummary ?? evidence.tests ?? evidence.testResults
    ?? evidence.test ?? null;
  return { commit, testSummary };
}

function requestView(request: HistoryRow['judgmentRequests'][number]) {
  return {
    id: request.id,
    taskId: request.taskId,
    evidenceId: request.evidenceId,
    criterionRevision: request.criterionRevision,
    evidenceDigest: request.evidenceDigest,
    kind: request.kind,
    recipientType: request.recipientType,
    recipientId: request.recipientId,
    status: request.status,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt,
    decidedByType: request.decidedByType,
    decidedById: request.decidedById,
    decision: request.decision,
    decisionNote: request.decisionNote,
    supersededAt: request.supersededAt,
    supersededById: request.supersededById,
  };
}

@Injectable()
export class TaskJudgmentReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
  ) {}

  private async actorNames(rows: Array<Pick<HistoryRow, 'actorType' | 'actorId'>>) {
    const userIds = [...new Set(rows.filter((row) => row.actorType === 'USER').map((row) => row.actorId))];
    const workspaceIds = [...new Set(rows.filter((row) => row.actorType === 'AGENT').map((row) => row.actorId))];
    const [users, workspaces] = await Promise.all([
      userIds.length
        ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
        : [],
      workspaceIds.length
        ? this.prisma.workspace.findMany({
            where: { id: { in: workspaceIds } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    return new Map([...users, ...workspaces].map((row) => [row.id, row.name]));
  }

  async list(
    ownerId: string,
    query: { status?: string; projectId?: string; taskId?: string; limit?: string } = {},
  ) {
    const status = query.status ?? 'OPEN';
    if (!['OPEN', 'DECIDED', 'SUPERSEDED', 'ALL'].includes(status)) {
      throw new BadRequestException('status must be OPEN, DECIDED, SUPERSEDED or ALL');
    }
    const parsedLimit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const where = {
      recipientId: ownerId,
      ...(query.taskId ? { taskId: query.taskId } : {}),
      // Project pages ask where the task is filed NOW. The inbox's projectId is intentionally a
      // delivery snapshot for audit and must not leave a moved request on the old project page.
      ...(query.projectId ? { task: { projectId: query.projectId } } : {}),
      request: {
        kind: 'EVIDENCE_JUDGMENT' as const,
        ...(status === 'ALL' ? {} : { status: status as 'OPEN' | 'DECIDED' | 'SUPERSEDED' }),
      },
    } satisfies Prisma.TaskJudgmentInboxItemWhereInput;
    const [total, rows] = await Promise.all([
      this.prisma.taskJudgmentInboxItem.count({ where }),
      this.prisma.taskJudgmentInboxItem.findMany({
        where,
        orderBy: [{ deliveredAt: 'desc' }, { id: 'desc' }],
        take: parsedLimit,
        include: inboxInclude,
      }),
    ]);
    const names = await this.actorNames(rows.map((row) => row.request.evidence));
    return {
      total,
      items: rows.map((row) => {
        const highlights = completionEvidenceHighlights(row.request.evidence.evidence);
        return {
          inboxItemId: row.id,
          requestVersion: row.requestVersion,
          deliveredAt: row.deliveredAt,
          notificationDeepLink: row.deepLink,
          requestId: row.request.id,
          requestStatus: row.request.status,
          decision: row.request.decision,
          taskId: row.task.id,
          taskTitle: row.task.title,
          taskStatus: row.task.status,
          projectId: row.task.projectId,
          projectTitle: row.task.project?.title ?? row.projectTitle,
          evidenceId: row.request.evidence.id,
          evidenceRevision: row.request.evidence.revision.toString(),
          evidenceDigest: row.request.evidenceDigest,
          submittedAt: row.request.evidence.submittedAt,
          actorType: row.request.evidence.actorType,
          actorId: row.request.evidence.actorId,
          actorName: names.get(row.request.evidence.actorId) ?? null,
          commit: highlights.commit,
          testSummary: highlights.testSummary,
          isCurrent: row.request.status === 'OPEN',
          pushDelivery: row.pushDelivery,
        };
      }),
    };
  }

  async get(ownerId: string, requestId: string) {
    const inbox = await this.prisma.taskJudgmentInboxItem.findFirst({
      where: { recipientId: ownerId, requestId },
      include: inboxInclude,
    });
    if (!inbox) throw new NotFoundException('judgment request not found');

    const history = await this.prisma.taskCompletionEvidence.findMany({
      where: { taskId: inbox.taskId },
      orderBy: [{ revision: 'desc' }, { submittedAt: 'desc' }, { id: 'desc' }],
      include: historyInclude,
    });
    if (history.length === 0) {
      throw new NotFoundException('judgment evidence not found');
    }
    const names = await this.actorNames(history);
    const currentEvidence = history[0];
    const currentRequest = history
      .flatMap((evidence) => evidence.judgmentRequests)
      .find((request) => request.status === 'OPEN') ?? null;
    const requestedEvidence = inbox.request.evidence;
    const relationIds = [
      inbox.task.id,
      ...inbox.task.dependsOn.map((edge) => edge.dependsOnTaskId),
      ...inbox.task.dependedOnBy.map((edge) => edge.taskId),
    ].slice(0, 1_000);
    const [graph, legacyOpenBlockers, projections] = await Promise.all([
      this.tasks.dependencyGraphNodes(ownerId, inbox.task.id, relationIds),
      inbox.task.projectId
        ? this.prisma.projectBlocker.count({
            where: {
              projectId: inbox.task.projectId,
              kind: 'HUMAN_DECISION_REQUIRED',
              subjectType: 'TASK',
              subjectId: inbox.task.id,
              resolvedAt: null,
            },
          })
        : 0,
      // Read the N11 views themselves. Re-deriving these booleans from Task.status or from one
      // request would give this endpoint a second lifecycle definition and could drift as soon as
      // a task's criterion changes between evidence revisions.
      this.prisma.$queryRaw<Array<{ signalOpen: boolean; blockerOpen: boolean }>>`
        SELECT EXISTS (
                 SELECT 1 FROM "task_judgment_signal"
                  WHERE "task_id" = ${inbox.task.id}::uuid
               ) AS "signalOpen",
               EXISTS (
                 SELECT 1 FROM "project_judgment_blocker"
                  WHERE "task_id" = ${inbox.task.id}::uuid
               ) AS "blockerOpen"`,
    ]);
    const derivedSignalOpen = projections[0]?.signalOpen ?? false;
    const derivedBlockerOpen = projections[0]?.blockerOpen ?? false;
    const requestedRequest = history
      .flatMap((evidence) => evidence.judgmentRequests)
      .find((request) => request.id === inbox.request.id);
    if (!requestedRequest) throw new NotFoundException('judgment request evidence not found');

    return {
      request: requestView(requestedRequest),
      requestVersion: inbox.requestVersion,
      inbox: {
        id: inbox.id,
        deliveredAt: inbox.deliveredAt,
        notificationDeepLink: inbox.deepLink,
        pushDelivery: inbox.pushDelivery,
      },
      reviewState: reviewState(
        inbox.request,
        requestedEvidence.id,
        currentEvidence.id,
      ),
      // Evidence currentness and request actionability are separate facts. A PASS or a request
      // for more evidence closes the request without retroactively making this evidence old; only
      // a later evidence revision does that.
      isCurrent: requestedEvidence.id === currentEvidence.id,
      task: {
        id: inbox.task.id,
        title: inbox.task.title,
        objective: inbox.task.description,
        status: inbox.task.status,
        projectId: inbox.task.projectId,
        projectTitle: inbox.task.project?.title ?? null,
        acceptanceCriteria: inbox.task.acceptanceCriteria,
        completionCriterion: inbox.task.completionCriterion,
      },
      criterion: requestedEvidence.criterion,
      evidence: {
        id: requestedEvidence.id,
        revision: requestedEvidence.revision.toString(),
        digest: requestedEvidence.evidenceDigest,
        submittedAt: requestedEvidence.submittedAt,
        actorType: requestedEvidence.actorType,
        actorId: requestedEvidence.actorId,
        actorName: names.get(requestedEvidence.actorId) ?? null,
        sourceSessionId: requestedEvidence.sourceSessionId,
        sourceAttemptId: requestedEvidence.sourceAttemptId,
        structured: requestedEvidence.evidence,
        ...completionEvidenceHighlights(requestedEvidence.evidence),
      },
      currentEvidence: {
        id: currentEvidence.id,
        revision: currentEvidence.revision.toString(),
        digest: currentEvidence.evidenceDigest,
        requestId: currentRequest?.id ?? null,
      },
      // This is the only approval preview the web may render. It is authored here from the
      // EVIDENCE_JUDGMENT write contract and bound to the exact still-open/current request fact. The
      // dependency graph is deliberately absent: dependent readiness is re-read after the commit,
      // never predicted before it.
      approvalImpact: requestedRequest.status === 'OPEN'
        && requestedEvidence.id === currentEvidence.id
        && inbox.task.completionCriterion === 'EVIDENCE_JUDGMENT'
        ? {
            authority: 'SERVER' as const,
            action: 'PASS' as const,
            conditionalOn: {
              requestId: requestedRequest.id,
              evidenceDigest: requestedEvidence.evidenceDigest,
              requestStatus: 'OPEN' as const,
              evidenceIsCurrent: true as const,
            },
            task: {
              id: inbox.task.id,
              resultingStatus: 'DONE' as const,
              basis: 'EVIDENCE_JUDGMENT' as const,
            },
            request: {
              id: requestedRequest.id,
              resultingStatus: 'DECIDED' as const,
              decision: 'PASS' as const,
            },
            signal: { resultingOpen: false as const },
            blocker: { resultingOpen: false as const },
          }
        : null,
      history: history.map((evidence) => ({
        id: evidence.id,
        revision: evidence.revision.toString(),
        digest: evidence.evidenceDigest,
        submittedAt: evidence.submittedAt,
        actorType: evidence.actorType,
        actorId: evidence.actorId,
        actorName: names.get(evidence.actorId) ?? null,
        criterion: evidence.criterion,
        structured: evidence.evidence,
        ...completionEvidenceHighlights(evidence.evidence),
        isCurrentEvidence: evidence.id === currentEvidence.id,
        requests: evidence.judgmentRequests.map(requestView),
      })),
      derived: {
        taskStatus: inbox.task.status,
        openRequestId: currentRequest?.id ?? null,
        signalOpen: derivedSignalOpen,
        blockerOpen: derivedBlockerOpen || legacyOpenBlockers > 0,
        legacyOpenBlockerCount: legacyOpenBlockers,
        dependencyGraph: graph,
      },
    };
  }

  async decide(ownerId: string, requestId: string, input: DecideTaskJudgmentDto) {
    if (input.requestId !== requestId) {
      throw new ConflictException({
        code: 'EVIDENCE_JUDGMENT_REQUEST_ROUTE_MISMATCH',
        requiredAction: 'SUBMIT_THE_REQUEST_CURRENTLY_OPEN_IN_THIS_REVIEW',
        message: 'The decision payload requestId does not match this review.',
      });
    }
    const request = await this.prisma.taskJudgmentRequest.findFirst({
      where: { id: requestId, ownerId, kind: 'EVIDENCE_JUDGMENT', recipientId: ownerId },
      select: { taskId: true },
    });
    if (!request) throw new NotFoundException('judgment request not found');

    if (input.action === 'PASS') {
      await this.tasks.judge(ownerId, request.taskId, {
        requestId,
        evidenceDigest: input.evidenceDigest,
        evidence: input.note,
      });
    } else {
      await this.tasks.requestMoreEvidence(ownerId, request.taskId, {
        requestId,
        evidenceDigest: input.evidenceDigest,
        note: input.note,
      });
    }
    // A decision response is a fresh read of every derived projection, not a client-authored
    // status patch. The web refetches once more after this response so cache and route state share
    // the same server truth.
    return this.get(ownerId, requestId);
  }
}

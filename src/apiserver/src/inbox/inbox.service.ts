import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ApprovalStatus,
  InboxApprovalItem,
  InboxResolvedItem,
  InboxResponse,
} from '@orbit/shared';
import { GENERATING_SESSION_FILTER } from '../common/session-generating';
import { PrismaService } from '../prisma/prisma.service';
import { approvalKind, approvalSummary, sessionRole } from './inbox-item';

/**
 * Everything in this account that is waiting on a person, in one list.
 *
 * The per-session `GET /sessions/:id/approvals` answers "what is this session asking", which is
 * the wrong question when the user is the bottleneck across twenty projects: to find the thing
 * that has been blocked longest you had to open every session in turn. The list view could only
 * say *that* a session was asking (`pendingApprovals`, a count with no timestamp), never for how
 * long or about what — so this is the endpoint that carries `waitingSince`, and the reason the
 * inbox can be ordered by it.
 */
@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param resolvedSince when given, also return the approvals settled at or after this instant,
   *        for the inbox's "Resolved" section. Omitted, `resolved` comes back empty — the common
   *        case is a poll for what is still waiting, and the answered ones are the larger set.
   */
  async list(ownerId: string, resolvedSince?: string): Promise<InboxResponse> {
    const since = parseSince(resolvedSince);

    const pendingRows = await this.prisma.approval.findMany({
      where: {
        status: 'PENDING',
        // "Needs you" as sessions.service.ts already defines it: an Open session, generating,
        // holding a PENDING approval. A prompt raised by a session since completed or trashed is
        // nobody's turn to answer, and a session that is not generating has no live turn blocked
        // on one — counting those would put rows in the inbox that clicking cannot clear.
        session: { ownerId, ...OPEN_SESSION, ...GENERATING_SESSION_FILTER },
      },
      // Oldest first: the inbox is ordered by how long something has been waiting, and the point
      // of the view is that the top row is the one that has been blocked longest.
      orderBy: { createdAt: 'asc' },
      select: APPROVAL_SELECT,
    });

    // Deliberately NOT gated on `generating`, unlike the pending half: answering an approval is
    // often the last thing a session needed, so by the time the user looks at what they just
    // cleared the run may well have finished. Still scoped to sessions that are not in the trash
    // — a deleted session's history is not on offer anywhere else either.
    const resolvedRows = since
      ? await this.prisma.approval.findMany({
          where: {
            status: { not: 'PENDING' },
            decidedAt: { gte: since },
            session: { ownerId, deletedAt: null },
          },
          // Most recently settled first: "here is what you just dealt with".
          orderBy: { decidedAt: 'desc' },
          take: RESOLVED_MAX,
          select: APPROVAL_SELECT,
        })
      : [];

    const coordinated = await this.coordinatorProjects(ownerId, [...pendingRows, ...resolvedRows]);
    return {
      pending: pendingRows.map((row) => this.toItem(row, coordinated)),
      resolved: resolvedRows.map((row) => this.toResolved(row, coordinated)),
    };
  }

  /**
   * Which of these sessions is a project's coordinator, and which project.
   *
   * A coordinator session carries no task, so the ordinary session → task → project path finds
   * nothing for it; the binding is a pointer on Project the other way round. One query for the
   * whole page rather than one per row, and scoped by ownerId like every other read here.
   */
  private async coordinatorProjects(
    ownerId: string,
    rows: ApprovalRow[],
  ): Promise<Map<string, { id: string; title: string }>> {
    const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
    if (!sessionIds.length) return new Map();
    const projects = await this.prisma.project.findMany({
      where: { ownerId, coordinatorSessionId: { in: sessionIds } },
      select: { id: true, title: true, coordinatorSessionId: true },
    });
    return new Map(projects.map((p) => [p.coordinatorSessionId!, { id: p.id, title: p.title }]));
  }

  private toItem(
    row: ApprovalRow,
    coordinated: Map<string, { id: string; title: string }>,
  ): InboxApprovalItem {
    const coordinatorOf = coordinated.get(row.sessionId);
    const project = row.session.task?.project ?? coordinatorOf;
    return {
      approvalId: row.id,
      kind: approvalKind(row.toolName),
      toolName: row.toolName,
      summary: approvalSummary(row.toolName, row.input),
      sessionId: row.sessionId,
      sessionTitle: row.session.title,
      ...(row.session.workspaceId ? { workspaceId: row.session.workspaceId } : {}),
      ...(row.session.task ? { taskId: row.session.task.id, taskTitle: row.session.task.title } : {}),
      ...(project ? { projectId: project.id, projectTitle: project.title } : {}),
      role: sessionRole(row.session, coordinatorOf != null),
      waitingSince: row.createdAt.toISOString(),
    };
  }

  private toResolved(
    row: ApprovalRow,
    coordinated: Map<string, { id: string; title: string }>,
  ): InboxResolvedItem {
    return {
      ...this.toItem(row, coordinated),
      status: row.status as ApprovalStatus,
      decision: row.status === 'ALLOWED' ? 'allow' : 'deny',
      // Non-null by construction: the query selected on `decidedAt >= since`.
      resolvedAt: row.decidedAt!.toISOString(),
      ...(row.message ? { message: row.message } : {}),
    };
  }
}

/**
 * How many settled approvals one window may return. The pending half needs no cap — what is
 * waiting on a person is few, which is the premise of the whole view — but `resolvedSince` is a
 * bound the CALLER chooses, and `resolvedSince=1970-01-01` would otherwise ask for every approval
 * the account has ever answered. Ordered newest-first, so what a cap drops is always the oldest
 * end of the window rather than an arbitrary slice; the section this feeds is "resolved today",
 * which does not reach it.
 */
const RESOLVED_MAX = 200;

/** Open, as the session list means it: neither completed nor trashed. `archivedAt` is migration
 *  0076's compatibility mirror of `completedAt` and is checked for the same reason the list's own
 *  query COALESCEs the two — a row written by an older replica may carry only the mirror. */
const OPEN_SESSION = { deletedAt: null, completedAt: null, archivedAt: null } as const;

/** Everything a card needs, and nothing that would make this a per-row query: the session it is
 *  asking from, the task that session is doing, and that task's project. The coordinator case is
 *  the one thing this cannot reach — see `coordinatorProjects`. */
const APPROVAL_SELECT = {
  id: true,
  sessionId: true,
  toolName: true,
  input: true,
  status: true,
  message: true,
  createdAt: true,
  decidedAt: true,
  session: {
    select: {
      title: true,
      workspaceId: true,
      dispatchOrigin: true,
      task: {
        select: {
          id: true,
          title: true,
          verifiesTaskId: true,
          project: { select: { id: true, title: true } },
        },
      },
    },
  },
} satisfies Prisma.ApprovalSelect;

type ApprovalRow = Prisma.ApprovalGetPayload<{ select: typeof APPROVAL_SELECT }>;

/** An unparseable window is a 400 rather than a silently ignored filter: answering the whole
 *  history when the caller asked for today is worse than refusing. */
function parseSince(resolvedSince?: string): Date | undefined {
  if (resolvedSince == null || resolvedSince === '') return undefined;
  const at = new Date(resolvedSince);
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestException('resolvedSince must be an ISO instant');
  }
  return at;
}

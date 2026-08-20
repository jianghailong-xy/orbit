import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ProjectAutomationPolicy,
  ProjectIdentitySource,
  ProjectRole,
  ProjectStatus,
  TaskStatus,
} from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  DEFAULT_TASK_PAGE_SIZE,
  MAX_TASK_PAGE_SIZE,
  decodeTaskPageCursor,
  encodeTaskPageCursor,
} from '../tasks/tasks.service';
import { CreateProjectDto, UpdateProjectDto } from './dto';

/**
 * "This project's coordinator belongs in a workspace that will not have it."
 *
 * Exported because it is a contract value rather than a message: the control loop opens a blocker
 * with this code (§7.5, §11), and clients switch on it to send the owner to the one setting that
 * resolves it.
 */
export const COORDINATOR_UNAVAILABLE_CODE = 'COORDINATOR_UNAVAILABLE';

/**
 * What a project created from inside a session is bound to: the conversation it is coordinated
 * from, and where that conversation runs.
 *
 * Both halves or neither, which is why it is one argument rather than two. A session with no
 * record of where it was opened cannot answer what the next `coordinator` call asks of it, and a
 * workspace with no session is the state this pair exists to stop producing — a project that opens
 * a SECOND conversation about work that has already been discussed in one. `createInSession`
 * resolves both from the same session row, so the two cannot disagree.
 */
export interface ProjectCoordinatorSeed {
  sessionId: string;
  workspaceId: string;
}

export interface ProjectTaskPageQuery {
  /** Absent = the project's top level. Present = that task's direct children, and only those. */
  parentId?: string;
  cursor?: string;
  limit?: string | number;
  status?: string;
}

/**
 * What ONE row of the project's task tree needs, and nothing else.
 *
 * The tree's first screen shows a title, where the work stands, when it is due and who would run
 * it — so `description` is out for the reason it is out of `TASK_LIST_SELECT` (~500 bytes a task,
 * parsed and thrown away by every client that renders a row), and `comments`, `sessions` and
 * `children` are out because each is an unbounded collection that turns one page into a fan-out.
 *
 * The child tally a row needs in order to know whether it has anything to expand is added by
 * `taskPage` rather than listed here, because it is scoped to the request's owner and project.
 * It is a `_count` — one joined aggregate — and NOT `children: true` with a `.length`, which is
 * the difference between an integer per row and every subtask of every row on the page.
 */
const PROJECT_TASK_TREE_SELECT = {
  id: true,
  title: true,
  status: true,
  parentTaskId: true,
  acceptanceCriteria: true,
  createdAt: true,
  updatedAt: true,
  dueDate: true,
  // Both instants a row carries, and they answer different questions: `dueDate` is when the work
  // is wanted by, `runAt` is when it starts by itself. Omitting this one made a schedule saved
  // through the task API unreadable through the project tree — the client could set it and then
  // could not see it, which reads as the write having been lost.
  runAt: true,
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.TaskSelect;

/**
 * What every project response says about its coordination, and the two rows it is read from.
 *
 * `coordinatorAgentId` lives on a `project_member` row rather than on a column of `project`,
 * because the coordinator is one role of a team and the same fact in two places is the one that
 * drifts. Clients are handed the fact, not the row: the team itself is not this phase's API, and a
 * `members` array in every project payload would be one.
 */
const COORDINATION_INCLUDE = {
  members: { where: { role: ProjectRole.COORDINATOR }, select: { agentId: true } },
  runtime: { select: { coordinatorGeneration: true } },
} satisfies Prisma.ProjectInclude;

type WithCoordination = {
  members: Array<{ agentId: string }>;
  runtime: { coordinatorGeneration: bigint } | null;
};

/**
 * Fold those two rows into the two fields a client reads, and drop the rows.
 *
 * `coordinatorGeneration` is how many times the coordinator SESSION has been replaced, which is
 * the one thing that distinguishes "this project has always been coordinated here" from "its
 * conversation has been reopened four times" — the identity (`coordinatorAgentId`) is unchanged by
 * every one of those.
 */
function withCoordination<T extends WithCoordination>(
  project: T,
): Omit<T, keyof WithCoordination> & {
  coordinatorAgentId: string | null;
  coordinatorGeneration: bigint;
} {
  const { members, runtime, ...rest } = project;
  return {
    ...rest,
    coordinatorAgentId: members[0]?.agentId ?? null,
    // A project whose runtime row is somehow missing reads as generation 0 rather than as an
    // error: the row is created with the project and backfilled by the migration, so its absence
    // can only mean "nothing has rotated", and a 500 on a read would be the wrong way to say that.
    coordinatorGeneration: runtime?.coordinatorGeneration ?? 0n,
  };
}

/**
 * Projects: what a body of work is trying to achieve, and how anyone would know it got there.
 *
 * Nothing here dispatches, cancels, holds or releases a TASK, and that is a property to preserve
 * rather than an omission to fill in: a project carries no authority over how its tasks run, so no
 * write on this service can change what the sweep, the claim gate or a runner does.
 * `TaskListsService.remove` has to disarm its tasks before deleting a list precisely because a
 * list *does* carry that authority; the equivalent here would be code with nothing to do.
 *
 * `coordinator` opens a session, which is the one thing on this service that starts anything — and
 * it starts a conversation ABOUT the project, not any of its work. Nothing on the dispatch path
 * reads the binding it writes, so the property above survives it intact.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  /**
   * The fields that decide whether an action the coordinator wants to take may happen — and the
   * complete list of them, which is the property that matters.
   *
   * Two things read it, and they must not disagree: writing any of them bumps `configRevision`
   * (so a revoke that races an action is a comparison rather than an archaeology), and the runner
   * door refuses all of them (an agent does not widen its own authority). A field that can change
   * what the coordinator is allowed to do and is not in here is a hole in both.
   *
   * `coordinatorAgentId` is deliberately NOT one: it says WHO decides, not what a decider may do.
   */
  static readonly AUTHORIZATION_FIELDS = [
    'coordinatorEnabled',
    'automationPolicy',
    'maxConcurrentTasks',
    'sessionBudgetPerDay',
  ] as const;

  /** One wording for every reason an agent id is not one this project may coordinate with —
   *  unknown, another owner's, or deleted. Distinguishing them would answer "does this id exist"
   *  for ids the caller has no business knowing about. */
  private static readonly NO_SUCH_AGENT =
    'no such agent to coordinate this project — coordinatorAgentId must name an agent of this ' +
    'account that has not been deleted';

  /**
   * One wording for "the session you said you are in is not one I will make a coordinator of",
   * whichever of the several reasons applies. See `coordinatorFromSession`.
   */
  private static readonly NO_SESSION_COORDINATOR =
    'no session to record as this project’s coordinator — the session this request came from ' +
    'is not one this runner is running for this owner, or the workspace it ran in cannot be run in';

  /**
   * The other half of the binding, refused. `coordinator_session_id` is UNIQUE, so a session
   * coordinates at most one project; a second project recorded from the same conversation has to
   * be told so rather than quietly landing unbound, because an unbound project reported as success
   * is the defect this whole path exists to stop producing. Worded with the remedy in it: the
   * caller is an agent deciding what to do next, not a person reading a log.
   */
  private static readonly ALREADY_COORDINATING =
    'this session already coordinates another project, and a session coordinates at most one — ' +
    'so this project was not created. Record it from a session that coordinates nothing yet.';

  /**
   * One wording for "this project's coordinator is not where you asked", whether that was noticed
   * before a session was created or after losing the race to bind one. Two phrasings would read as
   * two different rules to anyone who hit both.
   */
  private static readonly ELSEWHERE =
    'this project already has a coordinator, and it runs in a different workspace — open it where ' +
    'it is, or delete it first. Moving a coordinator is not something this endpoint does as a side ' +
    'effect of asking for one.';

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Ownership check for the write paths, and the 404 every unknown or cross-tenant id gets.
   *
   * Cheap on purpose (cf. `TaskListsService.assertOwned`): a project's detail read counts its
   * tasks, which is the right shape for a detail page and absurd as authorization for setting
   * one field.
   */
  private async assertOwned(ownerId: string, id: string): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id, ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('project not found');
  }

  /**
   * Blank prose is stored as null so "not set" has exactly one representation — the same rule
   * `TaskListsService.update` applies to a list's instructions, and for the same reason: an empty
   * string and a null must not be able to mean different things to whatever reads them later.
   * `undefined` (the field was not sent) is passed through untouched, so a rename cannot blank a
   * goal.
   */
  private static blankToNull(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    return value?.trim() ? value : null;
  }

  /**
   * `coordinator` is a SERVER-DERIVED argument, never a field of `CreateProjectDto`: the only
   * caller that passes one is `createInSession`, which resolved it from the session the request
   * came from. Putting it on the DTO would let any caller name any session and any workspace on a
   * project it is creating — which is to say claim a conversation it does not own as this
   * project’s coordinator, and point it into a workspace it was never given.
   */
  async create(ownerId: string, dto: CreateProjectDto, coordinator?: ProjectCoordinatorSeed) {
    if (!dto.title) throw new BadRequestException('title is required');
    try {
      // `await` inside the `try`, not a returned promise: a returned one rejects in the caller,
      // where the catch below cannot see it.
      const project = await this.prisma.project.create({
        data: {
          title: dto.title,
          ownerId,
          goal: ProjectsService.blankToNull(dto.goal),
          acceptanceCriteria: ProjectsService.blankToNull(dto.acceptanceCriteria),
          instructions: ProjectsService.blankToNull(dto.instructions),
          // The defaults for a NEW project, written here rather than left to the column defaults —
          // and they are different values. The columns default to `false` / MANUAL because that is
          // what every project that existed before this feature has to keep; a project created
          // now is one somebody is recording in order to have it coordinated, so it starts
          // coordinated, at the guarded level. Doing it the other way round (new-project values as
          // the column defaults, old rows rewritten by the migration) turns every project created
          // between the migration and this code into an automatic one, and rewrites exactly the
          // rows nobody asked about.
          coordinatorEnabled: true,
          automationPolicy: ProjectAutomationPolicy.GUARDED_AUTO,
          // The control loop's row, created with the project so that "has a runtime row" is never
          // a question a later reader has to answer with a fallback.
          //
          // `coordinatorIdentityLandingId` is the landing the membership below was derived FROM,
          // written in the same insert as the membership itself. Nobody has CHOSEN a coordinator
          // here — the agent seated is the one whose session recorded the project — so the source
          // stays DERIVED (the column default) and this project's identity remains correctable if
          // its landing later moves (migration 0113, validation 04R). Recording the baseline is
          // what lets migration 0114 tell that later move apart from an owner's explicit choice.
          runtime: {
            create: coordinator ? { coordinatorIdentityLandingId: coordinator.workspaceId } : {},
          },
          // Both columns in the SAME insert as the project itself, which is the whole of
          // "bound atomically": one statement, so there is no instant in which the project exists
          // pointing at no conversation, and no failure in which the row lands and the binding
          // does not. A second write would have both.
          ...(coordinator
            ? {
                coordinatorSessionId: coordinator.sessionId,
                coordinatorWorkspaceId: coordinator.workspaceId,
                // And the identity behind that conversation, in the same insert. The agent running
                // the session that recorded this project is the agent coordinating it — the same
                // fact the two columns above state about the CONVERSATION, stated about WHO. It is
                // what survives every later rotation of that conversation, so a project planned in
                // a session does not lose its coordinator the first time the session is replaced.
                members: {
                  create: { agentId: coordinator.workspaceId, role: ProjectRole.COORDINATOR },
                },
              }
            : {}),
        },
        include: COORDINATION_INCLUDE,
      });
      return withCoordination(project);
    } catch (e) {
      // One insert, and exactly one unique index it can violate — `coordinator_session_id`, and
      // only when a coordinator was seeded (`id` is a server-generated uuid v7). The rows nested
      // above add none: both are keyed by the project id this insert is generating, so nothing
      // else can already hold them. So P2002 here means one thing, and it is a 409 rather than the
      // 500 an unhandled Prisma error becomes:
      // "a session coordinates at most one project" is a rule the caller can act on.
      //
      // There is nothing half-written to clean up. A rejected INSERT writes no row, so the project
      // this conflict is about does not exist — which is what makes the report safe to act on.
      if (coordinator && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(ProjectsService.ALREADY_COORDINATING);
      }
      throw e;
    }
  }

  /**
   * A project recorded by an agent from inside a session, which is where a project usually gets
   * recorded now that `project_create` reaches a runner.
   *
   * THAT session becomes the project's coordinator, and its workspace the workspace of record.
   * The conversation in which a body of work was planned is the conversation about that body of
   * work — so coming back to the project comes back to the reasoning, and `coordinator` hands the
   * session back instead of opening a second one that knows none of it. Recording only the
   * workspace was the near miss: the project was openable, but opening it started a stranger in
   * the right room.
   *
   * Neither half is client-controlled: both are read off the session row this request came from,
   * under this owner and this runner — see `coordinatorFromSession`.
   *
   * Headless `project_create` (a cron bridge, no session) keeps calling `create` and keeps getting
   * a project bound to nothing, which is the truthful answer: no session, nothing to inherit.
   * `coordinator` opens one for it the way it always has.
   */
  async createInSession(
    ownerId: string,
    runnerId: string,
    sessionId: string,
    dto: CreateProjectDto,
  ) {
    return this.create(
      ownerId,
      dto,
      await this.coordinatorFromSession(ownerId, runnerId, sessionId),
    );
  }

  /**
   * The session a runner request says it is coming from, and the workspace it runs in — or a 403.
   *
   * Scoped by BOTH `ownerId` and `assignedRunnerId`, so the header can only ever name a session
   * this very runner is running for this very owner. The credential authenticates a machine, and
   * a machine that could name any session id would be able to plant a project pointing into
   * somebody else's workspace and then open a coordinator in it.
   *
   * Every rejection is the SAME 403 with the same wording — unknown id, another owner's session,
   * another runner's session, a deleted one, one whose workspace has since been deleted or
   * disabled, one that never had a workspace. Distinguishing them would answer "does this session
   * id exist" for ids the caller has no business knowing about, and the caller can act on none of
   * the distinctions anyway. 403 rather than 404 for the same reason `resolveAgentCreator` refuses
   * an unusable `X-Orbit-Workspace-Id` with one: the id is context the caller asserted about
   * itself, not a resource it asked for.
   *
   * Refusing is the point. Creating the project anyway, minus the binding, is exactly the
   * coordinator-less project this whole path exists to stop producing.
   */
  private async coordinatorFromSession(
    ownerId: string,
    runnerId: string,
    sessionId: string,
  ): Promise<ProjectCoordinatorSeed> {
    let id: string;
    try {
      // `publicIdHeaders` already normalized base62 to a UUID; it deliberately leaves a value it
      // could not decode alone for the handler to reject, which is this. Decoding again is
      // idempotent on a UUID, so the middleware's work stands and garbage is a 403 rather than
      // the P2023 a `@db.Uuid` column answers a base62-shaped string with.
      id = toUuid(sessionId);
    } catch {
      throw new ForbiddenException(ProjectsService.NO_SESSION_COORDINATOR);
    }
    const session = await this.prisma.session.findFirst({
      where: {
        id,
        ownerId,
        assignedRunnerId: runnerId,
        deletedAt: null,
        // The two states `sessions.create` refuses, checked here rather than trusted. Workspaces
        // are soft-deleted, so the FK never nulls for one, and `enabled` is an ordinary column a
        // person flips at any time — either way the id goes on naming a workspace no coordinator
        // can be opened in. Seeding a default from one produces exactly the unopenable project
        // this path exists to stop producing, and it produces it silently: the create succeeds and
        // the failure only surfaces later, at the coordinator, as a 403 about a workspace nobody
        // chose. `enabled` is compared to `true` rather than read for falsiness because the column
        // is non-nullable with a default, which is how sessions.create reads it.
        workspace: { deletedAt: null, enabled: true },
      },
      select: { workspaceId: true },
    });
    if (!session?.workspaceId) throw new ForbiddenException(ProjectsService.NO_SESSION_COORDINATOR);
    // `id` rather than the header: what was validated is what gets bound, in the spelling the
    // column keys by.
    return { sessionId: id, workspaceId: session.workspaceId };
  }

  /**
   * The owner's projects, newest first.
   *
   * Finished and cancelled ones are included unless the caller narrows by status. `status` says
   * what happened to the work, not whether anyone wants to look at it, so it is not the column to
   * decide a default visibility from — a project nobody can see through the only endpoint that
   * lists projects is deleted in every respect except the one that matters when something goes
   * wrong.
   *
   * The task tally is a `_count`, not an embedded task array. `GET /task-lists/:id` embeds its
   * list's tasks and had to grow a `?tasks=none` escape hatch when one list reached 27k of them;
   * starting from the count is the same decision made once instead of twice.
   */
  async list(ownerId: string, status?: ProjectStatus) {
    const projects = await this.prisma.project.findMany({
      where: { ownerId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tasks: true } }, ...COORDINATION_INCLUDE },
    });
    // Bounded by the page, not by the project: at most one coordinator row and one runtime row
    // apiece, both joined by their own primary/unique key.
    return projects.map(withCoordination);
  }

  /**
   * One project, with how its work is distributed — but not the work itself, for the reason
   * `list` gives above. One grouped query, so the cost is bounded by the number of task statuses
   * rather than by the number of tasks.
   */
  async get(ownerId: string, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, ownerId },
      include: { _count: { select: { tasks: true } }, ...COORDINATION_INCLUDE },
    });
    if (!project) throw new NotFoundException('project not found');
    const byStatus = await this.prisma.task.groupBy({
      by: ['status'],
      where: { projectId: id },
      _count: { _all: true },
    });
    return {
      ...withCoordination(project),
      tasksByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
    };
  }

  /**
   * What every verification in this project concluded, and what those conclusions are still
   * holding up (contract AC6 / §13.2).
   *
   * The audit read face for the whole mechanism, and it answers three questions that are otherwise
   * only answerable by reading the code: which conclusion is current (`verdictRevision` — the same
   * value the action key is built from, so an action row and a conclusion can be lined up), what
   * each non-PASS conclusion left behind (the defect subtask, the action that raised it, whether
   * it is resolved), and — `blockedTasks` — exactly which tasks are not dispatchable because of
   * one, with the reason. That last list is the same read the dispatch guard makes at commit time,
   * so "why is this task not running" has an answer somebody can fetch rather than reconstruct.
   *
   * Ids come back as Base62: the columns are classified in `PUBLIC_ID_FIELDS`, so the response
   * interceptor rewrites them, and `evidence` was written in Base62 to begin with.
   */
  async verifications(ownerId: string, projectId: string) {
    await this.assertOwned(ownerId, projectId);
    const verifications = await this.prisma.task.findMany({
      where: { projectId, ownerId, verifiesTaskId: { not: null } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        title: true,
        status: true,
        verdict: true,
        verdictRevision: true,
        verifiesTaskId: true,
        verifies: { select: { id: true, title: true, status: true } },
      },
    });
    const failures = await this.prisma.taskVerificationFailure.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        defect: { select: { id: true, title: true, status: true } },
        raisedByAction: { select: { id: true, status: true, refusalCode: true, idempotencyKey: true } },
      },
    });
    const blockedTasks = await this.prisma.$queryRaw<Array<{
      taskId: string;
      reason: string;
      failureId: string;
      verifierTaskId: string;
      subjectTaskId: string;
      defectTaskId: string | null;
    }>>(Prisma.sql`
      SELECT blocked."id" AS "taskId", 'SUBJECT_DEFECT_OPEN' AS "reason", f."id" AS "failureId",
             f."verifier_task_id" AS "verifierTaskId", f."subject_task_id" AS "subjectTaskId",
             f."defect_task_id" AS "defectTaskId"
        FROM "task_verification_failure" f
        JOIN "task" blocked ON blocked."id" = f."subject_task_id"
        JOIN "task" defect ON defect."id" = f."defect_task_id"
       WHERE f."project_id" = ${projectId}::uuid AND f."resolved_at" IS NULL
         AND defect."status"::text NOT IN ('DONE', 'CANCELLED')
      UNION ALL
      SELECT d."task_id" AS "taskId", 'UPSTREAM' AS "reason", f."id" AS "failureId",
             f."verifier_task_id" AS "verifierTaskId", f."subject_task_id" AS "subjectTaskId",
             f."defect_task_id" AS "defectTaskId"
        FROM "task_verification_failure" f
        JOIN "task_dependency" d ON d."depends_on_task_id" = f."subject_task_id"
       WHERE f."project_id" = ${projectId}::uuid AND f."resolved_at" IS NULL
         AND f."blocks_downstream" = true
       ORDER BY "taskId", "reason", "failureId"
    `);
    return {
      projectId,
      verifications: verifications.map((row) => ({
        verifierTaskId: row.id,
        title: row.title,
        status: row.status,
        verdict: row.verdict,
        verdictRevision: String(row.verdictRevision),
        subjectTaskId: row.verifiesTaskId,
        subjectTitle: row.verifies?.title ?? null,
        subjectStatus: row.verifies?.status ?? null,
      })),
      failures: failures.map((row) => ({
        id: row.id,
        verifierTaskId: row.verifierTaskId,
        subjectTaskId: row.subjectTaskId,
        verdict: row.verdict,
        verdictRevision: String(row.verdictRevision),
        blocksDownstream: row.blocksDownstream,
        defectTaskId: row.defectTaskId,
        defectTitle: row.defect?.title ?? null,
        defectStatus: row.defect?.status ?? null,
        raisedByActionId: row.raisedByActionId,
        actionStatus: row.raisedByAction?.status ?? null,
        actionRefusalCode: row.raisedByAction?.refusalCode ?? null,
        // The key carries the project and verifier UUIDs by construction (the ledger's uniqueness
        // is declared on it), so it is hashed rather than echoed. The pair that identifies it —
        // verifier and revision — is right here in the clear.
        actionIdempotencyKeyHash: row.raisedByAction
          ? createHash('sha256').update(row.raisedByAction.idempotencyKey).digest('hex')
          : null,
        evidence: row.evidence,
        resolvedAt: row.resolvedAt,
        resolvedByTaskId: row.resolvedByTaskId,
        createdAt: row.createdAt,
      })),
      blockedTasks,
    };
  }

  /**
   * One level of the project's task tree, newest first.
   *
   * The tree is read a level at a time rather than as a tree. `parentId` absent means the
   * project's top level (`parentTaskId IS NULL`) and NEVER a subtask; `parentId` present means
   * that task's direct children and never a grandchild. So the cost of opening a project is one
   * page of its roots, and the cost of expanding a node is one page of that node's children —
   * neither is the size of the project, which is the property the whole endpoint exists for.
   *
   * Every query here is bounded by all three of `ownerId`, `projectId` and `parentTaskId`
   * together. The project alone would be the shape that has to be avoided: "load the project's
   * tasks and assemble the tree in memory" is exactly the read that stops working at the size a
   * project reaches when it is worth having.
   *
   * `(createdAt DESC, id DESC)` because `createdAt` alone is not a total order — tasks filed in
   * one batch share a millisecond, and a page boundary landing inside such a group would repeat
   * some of them and skip others. `id` breaks the tie, and the cursor carries both.
   */
  async taskPage(ownerId: string, projectId: string, query: ProjectTaskPageQuery = {}) {
    await this.assertOwned(ownerId, projectId);

    const limit = query.limit === undefined ? DEFAULT_TASK_PAGE_SIZE : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASK_PAGE_SIZE) {
      throw new BadRequestException(`limit must be an integer from 1 to ${MAX_TASK_PAGE_SIZE}`);
    }

    const status = ProjectsService.parseTaskStatus(query.status);
    const parentTaskId = query.parentId
      ? await this.assertParentInProject(ownerId, projectId, query.parentId)
      : null;

    const scope: Prisma.TaskWhereInput = {
      ownerId,
      projectId,
      parentTaskId,
      ...(status ? { status } : {}),
    };
    const cursor = query.cursor ? decodeTaskPageCursor(query.cursor) : undefined;
    const where: Prisma.TaskWhereInput = cursor
      ? {
          AND: [
            scope,
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : scope;

    // One row over the page: the only thing `nextCursor` must not do is promise a page that turns
    // out to be empty, and counting the remainder to find that out would cost the scan the paging
    // is here to avoid.
    const rows = await this.prisma.task.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        ...PROJECT_TASK_TREE_SELECT,
        // Scoped to the same owner and project as the page it would open, so the number a row
        // shows is the number expanding it returns. Today those clauses match every child a task
        // can have — a subtask is created into its parent's project and cannot be moved out of it
        // while it is still linked — which is exactly why they are stated rather than assumed: an
        // invariant enforced elsewhere is not a reason for this count to be a guess.
        _count: { select: { children: { where: { ownerId, projectId } } } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(({ _count, ...task }) => ({ ...task, childCount: _count.children }));
    return {
      items,
      nextCursor: hasMore && page.length ? encodeTaskPageCursor(page[page.length - 1]) : null,
    };
  }

  /**
   * The parent a subtask page may be asked for: a task this owner has, in THIS project.
   *
   * Both halves are checked in the one query that resolves it, so a parent in someone else's
   * account and a parent in the caller's own next project are the same 404 — an id that is not
   * part of this tree is not part of it, and saying which kind of not-part-of-it it was would
   * answer a question about another project's contents.
   */
  private async assertParentInProject(
    ownerId: string,
    projectId: string,
    parentId: string,
  ): Promise<string> {
    const parent = await this.prisma.task.findFirst({
      where: { id: parentId, ownerId, projectId },
      select: { id: true },
    });
    if (!parent) throw new NotFoundException('parent task not found');
    return parent.id;
  }

  /**
   * A task status, or a 400 naming the ones that exist.
   *
   * Only the real `TaskStatus` values: `GET /tasks/page` also answers to RUNNABLE, RUNNING and
   * ONGOING, and those are questions about runs and tabs rather than about a tree. An unknown
   * value is refused rather than ignored, for the reason the project filter refuses one — a
   * silently dropped filter reports the unfiltered tree as if it were the answer.
   */
  private static parseTaskStatus(status?: string): TaskStatus | undefined {
    if (status === undefined || status.trim() === '') return undefined;
    const value = status.trim().toUpperCase();
    if (!Object.values<string>(TaskStatus).includes(value)) {
      throw new BadRequestException(`status must be one of ${Object.values(TaskStatus).join(', ')}`);
    }
    return value as TaskStatus;
  }

  /**
   * The session this project is coordinated from, opening one if it has none it can still use.
   *
   * Resolve-or-create, for the reason `TaskListsService.console` is: the point of the binding is
   * that coming back to a project comes back to the same conversation, with the reasoning behind
   * everything decided in it still there. Calling this twice therefore returns one session and
   * says `created: false` the second time — it is not a "new coordinator" endpoint that happens to
   * be reachable twice.
   *
   * A project recorded from inside a session arrives here ALREADY bound, to the conversation it
   * was planned in (`createInSession`). So its first open creates nothing: the resolve branch
   * hands that session straight back, which is the whole of "do not open a second conversation
   * about work that has already been discussed in one".
   *
   * A bound session is reused even when it has FAILED: that is a terminal state Orbit revives with
   * a new turn, and the history is the thing worth keeping. Only a session the user put in Trash,
   * or one deleted out from under the pointer, earns a replacement — those are the two cases where
   * the conversation is genuinely gone rather than merely finished.
   *
   * What this deliberately will NOT do is move an existing coordinator. A request naming a
   * different workspace than the binding was made in is a 409, not a re-point: the conversation is
   * where the work was discussed, and relocating it is a decision someone has to make on purpose.
   * Replacing a coordinator is its own endpoint, and this is not it.
   */
  async coordinator(
    ownerId: string,
    id: string,
    workspaceId?: string,
  ): Promise<{ sessionId: string; created: boolean; workspaceId: string | null }> {
    const project = await this.prisma.project.findFirst({
      where: { id, ownerId },
      select: {
        id: true,
        title: true,
        coordinatorSessionId: true,
        coordinatorWorkspaceId: true,
        coordinatorSession: { select: { id: true, deletedAt: true } },
      },
    });
    if (!project) throw new NotFoundException('project not found');

    // Trashed, not merely ended: reviving a session out of Trash behind the user's back would undo
    // a deletion they performed deliberately.
    if (project.coordinatorSession && !project.coordinatorSession.deletedAt) {
      // Only when BOTH are known. A workspace deleted since the binding leaves `null` here (the FK
      // is SET NULL), and "different from something we no longer know" is not a conflict anyone
      // could act on — so that case returns the coordinator it has, which re-points nothing.
      if (
        workspaceId &&
        project.coordinatorWorkspaceId &&
        workspaceId !== project.coordinatorWorkspaceId
      ) {
        throw new ConflictException(ProjectsService.ELSEWHERE);
      }
      return {
        sessionId: project.coordinatorSession.id,
        created: false,
        workspaceId: project.coordinatorWorkspaceId,
      };
    }

    // Where a coordinator opens — which on a project that has had one is not a decision this call
    // gets to make. See `coordinatorLanding`.
    const { workspaceId: runIn, fixed } = await this.coordinatorLanding(ownerId, project, workspaceId);

    // Ownership, soft-deletion, "is it disabled" and "is it bound to a runner" are all checked by
    // sessions.create, which is the only thing that may build a session row. Re-deriving any of
    // that here would be a second opinion on a question that already has an owner.
    //
    // Its refusals are translated on the FIXED path, and only there. A project choosing its first
    // workspace can be told plainly that the one it named is disabled or unbound, because the
    // caller can name another. A replacement cannot: the only workspace it is allowed to open in
    // is the one that will not have it, so "workspace is disabled" is the whole of the blocker —
    // the coordinator is unavailable until its owner rebinds it, which is a different sentence
    // with a different addressee. Anything that is not one of those two refusals is a fault rather
    // than a state of this project, and is left alone.
    let session: { id: string };
    try {
      session = await this.sessions.create(
        ownerId,
        {
          workspaceId: runIn,
          title: `协调：${project.title}`.slice(0, 80),
          prompt: ProjectsService.buildCoordinatorOpening(project.title, project.id),
        },
        { source: 'user' },
      );
    } catch (e) {
      if (fixed && (e instanceof ForbiddenException || e instanceof BadRequestException)) {
        throw ProjectsService.coordinatorUnavailable(
          `the workspace this project is coordinated in will not run a session (${
            (e.getResponse() as { message?: string }).message ?? e.message
          })`,
        );
      }
      throw e;
    }

    // Written only after the session exists, so a failed create leaves the project exactly as it
    // was rather than pointing at a session that was never made — and written as a compare-and-swap
    // against the pointer this call read, not as an unconditional update. Two people opening the
    // coordinator at once both see it unbound and both write; the swap is what makes exactly one
    // of those writes land, in the database rather than in this process.
    //
    // The condition is the value we READ rather than "still null", because the reuse path above
    // also replaces a trashed session — swapping on what we saw covers both without a second branch.
    //
    // A row lock held across the create would avoid the wasted session altogether. Not here, for
    // the reason the console gives: sessions.create is heavy, Prisma's interactive transactions
    // time out at five seconds, and holding a lock across one trades a rare harmless race for a
    // rarer and far more confusing failure.
    // `ownerId` is in the swap as well as the id. The project was resolved by owner above, so this
    // cannot currently narrow anything — it is here because this is a WRITE, and a write that
    // carries its own tenant scope stays correct if the read above is ever moved, cached or
    // refactored into something that does not.
    //
    // The swap and the rotation count are ONE statement, because the count is the DATABASE's:
    // `project_coordinator_rotation_count` (migration 0112) advances the generation on any update
    // that replaces one session pointer with a different one. A replacement that landed without
    // its count, or a count without its replacement, would each make the same generation describe
    // two different conversations — and a generation is what later keys are derived from, so two
    // runs would look like one. Written here, that held only while this service was the only
    // writer; written as a trigger, it holds for the 0110 binary still serving requests during a
    // rolling deploy as well (validation 04, P1-06).
    //
    // Which leaves this one statement to make: only a REPLACEMENT counts, and the trigger's
    // condition is the same one this code applied — a first coordinator is generation 0, "the
    // coordinator this project has always had".
    let claimed: { count: number };
    try {
      claimed = await this.prisma.project.updateMany({
        where: { id, ownerId, coordinatorSessionId: project.coordinatorSessionId },
        data: { coordinatorSessionId: session.id, coordinatorWorkspaceId: runIn },
      });
    } catch (e) {
      // The swap did not happen — it FAILED, which is not the same as losing the race below and is
      // the case that used to leak. The session this call made is live, in a workspace, and no
      // project points at it; the only difference from a lost race is that nobody won, so the
      // cleanup is the same one and it runs before anything else can return or throw.
      this.logger.error(
        `the coordinator swap on project ${id} failed after its session was created — discarding ` +
          `session ${session.id}`,
        e instanceof Error ? e.stack : String(e),
      );
      await this.discardLoser(ownerId, session.id);
      throw e;
    }
    if (claimed.count === 0) {
      // We lost. Discard the session this call made BEFORE deciding anything else, so that every
      // path out of here — adopted, conflicted, or retryable — has already dealt with it. If the
      // discard itself fails, this throws rather than returning: reporting success while a live
      // agent sits in a workspace nobody points at is the one outcome that must never be reachable.
      await this.discardLoser(ownerId, session.id);

      const winner = await this.prisma.project.findFirst({
        where: { id, ownerId },
        select: {
          coordinatorWorkspaceId: true,
          coordinatorSession: { select: { id: true, deletedAt: true } },
        },
      });
      // Adopted only if it is a conversation the caller can actually open. A pointer that is empty
      // again, or that leads into Trash, is not something to hand back as this project's
      // coordinator — the caller would get an id it cannot use and a `created: false` saying that
      // was the intended answer. Both are transient, so both say "try again".
      if (!winner?.coordinatorSession || winner.coordinatorSession.deletedAt) {
        throw new ConflictException(
          'this project’s coordinator changed while one was being opened for it — try again',
        );
      }
      // The cross-workspace contract holds however the binding got there. Losing a race is not a
      // reason to hand back a coordinator somewhere the caller did not ask for and would have been
      // refused a moment earlier — the answer to "not where you asked" must not depend on timing.
      if (
        workspaceId &&
        winner.coordinatorWorkspaceId &&
        workspaceId !== winner.coordinatorWorkspaceId
      ) {
        throw new ConflictException(ProjectsService.ELSEWHERE);
      }
      return {
        sessionId: winner.coordinatorSession.id,
        created: false,
        workspaceId: winner.coordinatorWorkspaceId,
      };
    }
    return { sessionId: session.id, created: true, workspaceId: runIn };
  }

  /**
   * Where this project's coordinator may open, and whether that was fixed or chosen.
   *
   * A project that records a coordination workspace opens there, and the answer is `fixed`. Not as
   * a preference with fallbacks behind it — as the only permitted answer. §7.5 freezes a rotation
   * as "the SESSION is replaced; the agent and the workspace are not", so every way this call
   * could land somewhere else is a silent migration wearing a different hat:
   *
   *   * a caller naming another workspace is the 409 the live-coordinator branch already gives,
   *     and the answer must not depend on whether the old conversation happens to be in Trash;
   *   * a recorded workspace that has been soft-deleted or disabled used to fall through to "the
   *     workspace most of this project's tasks run in", which moves the coordinator on the most
   *     ordinary path there is — the trashed-coordinator path — and moves it silently. It is now
   *     the blocker §7.5 calls for: the coordinator is unavailable, and rebinding it is the
   *     owner's decision to make;
   *   * a project whose recorded workspace was hard-deleted out from under it (the FK's SET NULL)
   *     has no home to go back to. That is the same blocker rather than a free choice: this call
   *     knows the project HAD a coordinator, and picking a new home for it is precisely what it is
   *     not allowed to do.
   *
   * Only a project that has never had one gets to choose, which is a binding rather than a
   * rotation: what the caller said, else where this project's work already runs.
   */
  private async coordinatorLanding(
    ownerId: string,
    project: {
      id: string;
      coordinatorSessionId: string | null;
      coordinatorWorkspaceId: string | null;
    },
    workspaceId?: string,
  ): Promise<{ workspaceId: string; fixed: boolean }> {
    if (project.coordinatorWorkspaceId) {
      if (workspaceId && workspaceId !== project.coordinatorWorkspaceId) {
        throw new ConflictException(ProjectsService.ELSEWHERE);
      }
      const home = await this.lastCoordinatorWorkspace(ownerId, project);
      if (!home) {
        throw ProjectsService.coordinatorUnavailable(
          'the workspace this project is coordinated in has been deleted or disabled',
        );
      }
      return { workspaceId: home, fixed: true };
    }
    if (project.coordinatorSessionId) {
      throw ProjectsService.coordinatorUnavailable(
        'this project no longer records the workspace its coordinator ran in',
      );
    }
    const chosen = workspaceId ?? (await this.busiestAssignee(project.id));
    if (!chosen) {
      throw new BadRequestException(
        'no workspace to open the coordinator in — none of this project’s tasks has an assignee ' +
          'to borrow one from. Assign a task, or pass workspaceId.',
      );
    }
    return { workspaceId: chosen, fixed: false };
  }

  /**
   * The one refusal that means "this project's coordinator belongs somewhere it cannot open".
   *
   * Structured rather than prose, because it is the HTTP shape of the `COORDINATOR_UNAVAILABLE`
   * blocker the control loop persists once blockers exist (contract §7.5, §11): the same code, the
   * same owner and the same required action, so the endpoint and the loop cannot come to describe
   * one situation two ways. `owner: USER` is the whole point of it — nothing the server retries
   * fixes this, and moving the coordinator to a workspace that does work is exactly what §7.5
   * forbids.
   *
   * It carries no ids. Error bodies are the one response `PublicIdInterceptor` does not rewrite,
   * so a uuid put in here would go out raw; the caller already reads this project's workspace, in
   * base62, from the project itself.
   */
  private static coordinatorUnavailable(reason: string): ConflictException {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: COORDINATOR_UNAVAILABLE_CODE,
      message: `${reason} — its coordinator cannot be opened anywhere else`,
      owner: 'USER',
      requiredAction:
        'rebind this project’s coordination workspace (or restore/enable the one it names), then ' +
        'open the coordinator again',
    });
  }

  /**
   * Get rid of a coordinator this call created and then lost the race to bind.
   *
   * `remove` rather than `end`, which is the difference between a finished session and one that is
   * gone: the loser is a conversation nobody will ever open — no project points at it and nothing
   * links to it — so leaving it in Open is litter that looks exactly like a real coordinator. The
   * soft delete also recycles the runtime on its way out (it ends the session first, exactly as
   * `end` would), so this is strictly more cleanup, not different cleanup. Nothing is destroyed:
   * the row, the transcript and the billing stay, and it is restorable from Trash.
   *
   * A failure here is re-thrown, never swallowed. The whole reason the loser is discarded is that
   * an unreferenced live session must not exist; a caught-and-ignored failure would report success
   * in precisely the case where that guarantee was not met. The id is logged first, because at that
   * point it is the only place the orphan is named — the caller's retry will resolve the winner and
   * never mention this session again.
   */
  private async discardLoser(ownerId: string, sessionId: string): Promise<void> {
    try {
      await this.sessions.remove(ownerId, sessionId);
    } catch (e) {
      this.logger.error(
        `lost the coordinator race and could not discard session ${sessionId} — it may still be ` +
          'live and is bound to no project',
        e instanceof Error ? e.stack : String(e),
      );
      throw e;
    }
  }

  /**
   * The workspace this project records as its coordinator's, if that workspace can still run one.
   *
   * "last" in the name is the case that named it — where the previous coordinator ran — and the
   * workspace `createInSession` recorded is the same fact arrived at from the other side: it is
   * where the coordinator it bound at creation was already running. Both are read identically, and
   * deliberately: the question here is "where does this project say its coordinator belongs".
   *
   * Checked for liveness rather than trusted, and the check is now what DECIDES rather than what
   * filters. Workspaces are SOFT-deleted, so the FK's SET NULL never fires for one and the column
   * goes on naming a workspace `sessions.create` will refuse. This used to fall through to the
   * borrow-a-workspace fallback, which is the silent migration `coordinatorLanding` exists to
   * refuse; returning null here is now how that project reports `COORDINATOR_UNAVAILABLE`.
   */
  private async lastCoordinatorWorkspace(
    ownerId: string,
    project: { coordinatorWorkspaceId: string | null },
  ): Promise<string | null> {
    if (!project.coordinatorWorkspaceId) return null;
    const workspace = await this.prisma.workspace.findFirst({
      // `enabled` alongside the soft delete, because both are the same question here — can this
      // project's coordinator open where it belongs — and the caller has to be told no in the same
      // words either way. A disabled workspace reaching `sessions.create` would come back as a 403
      // about a workspace, which says nothing about the project or about who has to fix it.
      where: { id: project.coordinatorWorkspaceId, ownerId, deletedAt: null, enabled: true },
      select: { id: true },
    });
    return workspace?.id ?? null;
  }

  /**
   * The workspace most of this project's tasks are assigned to, or null.
   *
   * A coordinator is a conversation about the project, so it belongs where the project's work
   * actually runs. Soft-deleted workspaces are excluded rather than merely sorted last:
   * `sessions.create` filters on `deletedAt: null`, so borrowing one produces a coordinator that
   * cannot be opened at all — a 403 in place of the 400 that would at least have said what to do.
   */
  private async busiestAssignee(projectId: string): Promise<string | null> {
    const rows = await this.prisma.task.groupBy({
      by: ['assigneeId'],
      where: { projectId, assigneeId: { not: null }, assignee: { deletedAt: null } },
      _count: { _all: true },
      orderBy: { _count: { assigneeId: 'desc' } },
      take: 1,
    });
    return rows[0]?.assigneeId ?? null;
  }

  /**
   * The opening message of a project's coordinator.
   *
   * Self-contained, because the agent reading it has no idea which project it is in or that a
   * coordinator is a thing — so it names the project and carries its id, which is the only thing
   * in the message that ties the conversation back to a row.
   *
   * That id is spelled base62, the same as the `id` the agent gets back from `project_get`. Prose
   * is the one boundary `PublicIdInterceptor` cannot reach — it rewrites response *fields*, and a
   * message body is not one — so the encode happens here, where the id becomes text. An id worth
   * carrying is an id meant to be used, and a coordinator told one spelling and shown another has
   * no way to tell it is looking at its own project.
   *
   * It names the tools a coordinator actually has, and only those. `project_get`, the task tools
   * and `project_update` all reach a runner now, so the older wording — "assume you have nothing
   * that can change anything" — had stopped being caution and become a false statement: the one
   * session built to coordinate a project was the one told not to try. A prompt that undersells
   * the tools produces a coordinator that asks a human to do what it was handed the authority to
   * do; a prompt that oversells them produces an opening turn spent hunting for tools that are not
   * there, and then a confident report assembled from whatever it found instead. Both are wrong in
   * the same way, so this names the real set.
   *
   * Read before write, in that order, because neither the goal nor the acceptance criteria is
   * repeated in a task's description — a coordinator that starts by editing has nothing to have
   * based the edit on. And coordinating is not doing: the implementation belongs to each task's
   * own session, which is what having a project full of tasks is for.
   *
   * Still no promise of listing or deleting projects, opening another coordinator, or driving a
   * runner directly. None of those reaches a runner, and naming one would recreate the hunt.
   */
  private static buildCoordinatorOpening(title: string, projectId: string): string {
    return (
      `你是项目「${title}」（id: ${uuidToBase62(projectId)}）的协调会话。\n\n` +
      `这里用来跟进这个项目的进展、协调它下面的任务，不是用来替它干活的——具体实现交给各个任务自己的会话去做。\n\n` +
      `先读再说：用 project_get 读这个项目的目标、验收标准和作业指导，再用 task_list（projectId 传上面那个 id）` +
      `看它下面的任务各自停在哪里。这两样都不在任务的描述里，不读就只能靠猜。读完先简短汇报现状。\n\n` +
      `该动的时候你手上有工具，按我这次的要求来定：project_update 改这个项目的标题、目标、验收标准、作业指导，` +
      `或在工作真的落地时把 status 记成 DONE / CANCELLED；task_create、task_update、task_start 管它下面的任务。` +
      `我没让你改的，先说清楚该动什么、为什么，由我来决定。\n\n` +
      `没给你的工具就别去找：列出或删除项目、另开一个协调会话、直接指挥 runner，都不在你手上。`
    );
  }

  /** Each field is written only when the caller sent it, so closing a project cannot blank the goal
   *  that says what it was for, and a rename cannot reopen it. Settling `status` changes nothing
   *  about the project's tasks, which keep running or not running exactly as before — this phase
   *  adds no rule that a DONE project finishes its work, or that unfinished work reopens it. */
  async update(ownerId: string, id: string, dto: UpdateProjectDto) {
    const current = await this.prisma.project.findFirst({
      where: { id, ownerId },
      select: { id: true, coordinatorEnabled: true },
    });
    if (!current) throw new NotFoundException('project not found');

    // Checked here so an incomplete request costs nothing, and checked AGAIN under the row lock
    // below, which is the one that decides: what a project was when this read ran is not what it
    // is when the write commits.
    ProjectsService.assertLevelNamedWhenTurningOn(current.coordinatorEnabled, dto);

    const agentId =
      dto.coordinatorAgentId === undefined || dto.coordinatorAgentId === null
        ? (dto.coordinatorAgentId as null | undefined)
        : await this.resolveAgent(ownerId, dto.coordinatorAgentId);

    const authorizationWrites = ProjectsService.AUTHORIZATION_FIELDS.filter(
      (field) => dto[field] !== undefined,
    );

    const data: Prisma.ProjectUpdateInput = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.goal !== undefined ? { goal: ProjectsService.blankToNull(dto.goal) } : {}),
      ...(dto.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: ProjectsService.blankToNull(dto.acceptanceCriteria) }
        : {}),
      ...(dto.instructions !== undefined
        ? { instructions: ProjectsService.blankToNull(dto.instructions) }
        : {}),
      ...(dto.coordinatorEnabled !== undefined
        ? { coordinatorEnabled: dto.coordinatorEnabled }
        : {}),
      ...(dto.automationPolicy !== undefined ? { automationPolicy: dto.automationPolicy } : {}),
      ...(dto.maxConcurrentTasks !== undefined
        ? { maxConcurrentTasks: dto.maxConcurrentTasks }
        : {}),
      ...(dto.sessionBudgetPerDay !== undefined
        ? { sessionBudgetPerDay: dto.sessionBudgetPerDay }
        : {}),
      // One bump per write of the authorization set, however many of its fields the write carried:
      // a revision is a version of that set, not a count of columns. `increment` rather than a
      // read-then-write, so two writes cannot land on the same number.
      ...(authorizationWrites.length > 0 ? { configRevision: { increment: 1 } } : {}),
    };

    try {
      const project = await this.prisma.$transaction(async (tx) => {
        // The project row first, and this is the lock a coordinator has to take before committing
        // anything the fields above authorize. Taking it here is what makes "the user revoked it"
        // and "the coordinator acted on what it read" two orderings rather than an interleaving:
        // whichever commits first, the other sees it. It also fixes the order of the two writes
        // below (project before its team row), which is the order every path takes.
        const [locked] = await tx.$queryRaw<Array<{ coordinator_enabled: boolean }>>`
          SELECT "coordinator_enabled" FROM "project"
          WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
          FOR NO KEY UPDATE`;
        if (!locked) throw new NotFoundException('project not found');
        // The value the lock produced, not the one read before it: a concurrent write that turned
        // this project off is exactly the case the check has to see.
        ProjectsService.assertLevelNamedWhenTurningOn(locked.coordinator_enabled, dto);
        if (agentId !== undefined) {
          await ProjectsService.writeCoordinatorAgent(tx, ownerId, id, agentId);
        }
        return tx.project.update({ where: { id }, data, include: COORDINATION_INCLUDE });
      });
      return withCoordination(project);
    } catch (e) {
      // The partial unique index behind "one coordinator per project", reached only by a second
      // writer that got between the read and the write above. Reported as the rule it is rather
      // than as a 500 — the caller can re-read and decide.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'this project already has a coordinator agent — re-read it and set the one you meant',
        );
      }
      // A foreign key that no longer resolves: the agent was deleted between the check and the
      // write. Same answer as naming a deleted one outright.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new BadRequestException(ProjectsService.NO_SUCH_AGENT);
      }
      throw e;
    }
  }

  /**
   * Switching automation ON is the one write that may not inherit a value.
   *
   * "Carry on with whatever is safe" is already spelled by not sending the field at all, so a
   * request that turns a project into an automatic one without saying how far it may go is one
   * whose author has not decided yet — and the level they would have been given by default is
   * something they would then have to discover from its behaviour. Changing an already-enabled
   * project's other fields is untouched by this: it has a level, and its owner is looking at it.
   * Turning it off never needs one either — "stop" is unambiguous.
   */
  private static assertLevelNamedWhenTurningOn(
    enabledNow: boolean,
    dto: UpdateProjectDto,
  ): void {
    if (dto.coordinatorEnabled !== true || enabledNow || dto.automationPolicy !== undefined) return;
    throw new BadRequestException(
      'turning on this project’s coordinator requires an explicit automationPolicy ' +
        `(${Object.values(ProjectAutomationPolicy).join(', ')}) in the same request — ` +
        'leaving it out would pick a level of automation on your behalf',
    );
  }

  /**
   * The workspace behind a `coordinatorAgentId`, or a 400 naming what is wrong with it.
   *
   * An Agent is a `workspace` row today (MCP `agent_list`, `orbit agent` and `task.assigneeId` all
   * mean this table), so this is the same ownership-and-liveness check every other agent-shaped id
   * gets. Checked here rather than left to the foreign key because the foreign key cannot tell a
   * cross-tenant id from a deleted one, and both have to be refused with something the caller can
   * act on.
   */
  private async resolveAgent(ownerId: string, agentId: string): Promise<string> {
    const agent = await this.prisma.workspace.findFirst({
      where: { id: agentId, ownerId, deletedAt: null },
      select: { id: true },
    });
    if (!agent) throw new BadRequestException(ProjectsService.NO_SUCH_AGENT);
    return agent.id;
  }

  /**
   * Set, replace or remove the project's coordinator — one row, whichever of the three it is.
   *
   * Replacing edits the existing row rather than deleting and re-inserting: the membership is the
   * identity, and a delete/insert pair would make a coordinator briefly absent inside the
   * transaction for no reason. Naming the agent that is already coordinating is a no-op, so a
   * client that replays its own request writes nothing.
   *
   * Setting or replacing re-checks the agent HERE, under a lock, and not only in `resolveAgent`
   * before the transaction started. Agents are soft-deleted, so the foreign key cannot refuse one:
   * it proves the row exists, which a soft-deleted row does. Without the lock the check and the
   * write straddle another transaction's delete, and the membership commits pointing at an agent
   * that is gone (validation 04, P1-03).
   */
  private static async writeCoordinatorAgent(
    tx: Prisma.TransactionClient,
    ownerId: string,
    projectId: string,
    agentId: string | null,
  ): Promise<void> {
    if (agentId !== null) await ProjectsService.lockLiveAgent(tx, ownerId, agentId);
    const current = await tx.projectMember.findFirst({
      where: { projectId, role: ProjectRole.COORDINATOR },
      select: { id: true, agentId: true },
    });
    // Every one of the four outcomes below is the owner deciding WHO, so every one of them records
    // that — in this transaction, next to the row it is about (validation 04R2, P1-04R2-01).
    // Without it the next writer that only knows the 0110 columns relocates the coordination
    // workspace and the database silently re-derives the identity from it, which is a change to
    // WHO that nobody authorized and that PAC R3 forbids inferring from WHERE.
    //
    // Naming the agent that is already coordinating is still a decision, so it is recorded even
    // though the membership row does not change: it is the one case the database cannot recognise
    // structurally, because a seat that equals the landing is exactly what a derivation looks
    // like. Clearing is recorded for the same reason — "this project has no coordinator" is a
    // choice a landing event must not answer by seating one.
    await ProjectsService.recordExplicitIdentity(tx, projectId);
    if (agentId === null) {
      if (current) await tx.projectMember.delete({ where: { id: current.id } });
      return;
    }
    if (current?.agentId === agentId) return;
    if (current) {
      await tx.projectMember.update({ where: { id: current.id }, data: { agentId } });
      return;
    }
    await tx.projectMember.create({
      data: { projectId, agentId, role: ProjectRole.COORDINATOR },
    });
  }

  /**
   * "This identity was chosen, not worked out" — the one fact `project` and `project_member` cannot
   * state between them.
   *
   * An upsert rather than an update: a project inserted by a binary that predates `project_runtime`
   * has no runtime row until the deferred trigger gives it one at COMMIT, which is after this runs.
   * Creating it here is not a race with that trigger — the trigger's own insert absorbs the
   * conflict — and it is the only way the choice being made now is on record by the time the same
   * COMMIT reconciles the project.
   *
   * `coordinatorIdentityLandingId` is cleared with it: it is the baseline a DERIVED identity is
   * measured against, and keeping a stale one next to an EXPLICIT source would be a second answer
   * to a question that now has one.
   */
  private static async recordExplicitIdentity(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<void> {
    await tx.projectRuntime.upsert({
      where: { projectId },
      update: {
        coordinatorIdentitySource: ProjectIdentitySource.EXPLICIT,
        coordinatorIdentityLandingId: null,
      },
      create: {
        projectId,
        coordinatorIdentitySource: ProjectIdentitySource.EXPLICIT,
      },
    });
  }

  /**
   * Hold this agent still, alive, and the caller's, for the rest of the transaction.
   *
   * `FOR SHARE` rather than a plain read, and it is the whole fix. Deleting an agent is an UPDATE
   * of `deleted_at`, which takes `FOR NO KEY UPDATE` — a lock that conflicts with this one and not
   * with the `FOR KEY SHARE` the membership's foreign key takes by itself. So the two orderings
   * are now orderings rather than an interleaving:
   *
   *   * this transaction first — the delete waits behind it, then finds a coordinator membership
   *     and is refused (`WorkspacesService.remove`);
   *   * the delete first — this SELECT waits, re-evaluates its WHERE against the row the deleter
   *     committed (Postgres re-checks a locked row's qualifier), finds `deleted_at` set, returns
   *     nothing, and the membership is refused with the same 400 as naming a deleted agent.
   *
   * Neither order can commit a coordinator pointing at a deleted agent, and neither can deadlock:
   * this path takes the project's row lock and then an agent's, and the delete path takes an
   * agent's and never a project's.
   */
  private static async lockLiveAgent(
    tx: Prisma.TransactionClient,
    ownerId: string,
    agentId: string,
  ): Promise<void> {
    const held = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "workspace"
      WHERE id = ${agentId}::uuid AND "owner_id" = ${ownerId}::uuid AND "deleted_at" IS NULL
      FOR SHARE`;
    if (held.length === 0) throw new BadRequestException(ProjectsService.NO_SUCH_AGENT);
  }

  /**
   * Delete a project, but only while it is empty.
   *
   * A task's `projectId` is what the task is FOR, so there is no harmless way to remove a project
   * out from under one: detaching would erase that record invisibly (nothing about a project-less
   * task says it ever had a project), and deleting the tasks would destroy work nobody asked to
   * lose. Refusing is the only option that leaves the caller able to decide, so this reports how
   * many tasks are in the way and stops.
   *
   * The count and the delete run in one transaction that takes the project's row lock first. That
   * lock is what makes the check binding rather than advisory: inserting a task that references
   * this project takes FOR KEY SHARE on this very row, which FOR UPDATE conflicts with, so a
   * concurrent file-into-the-project either commits before the count sees it or waits behind the
   * delete and then fails its foreign key. (The same mechanism `TasksService.deleteAndStopRuns`
   * relies on for tasks and their sessions.)
   *
   * And if something still gets past all of that, `ON DELETE RESTRICT` refuses at the database.
   * P2003 is translated to the same 409 the check raises, so one race cannot produce two different
   * answers to the same question.
   */
  async remove(ownerId: string, id: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "project"
          WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
          FOR UPDATE`;
        if (locked.length === 0) throw new NotFoundException('project not found');
        const tasks = await tx.task.count({ where: { projectId: id } });
        if (tasks > 0) throw new ConflictException(this.notEmptyMessage(tasks));
        await tx.project.delete({ where: { id } });
      });
    } catch (e) {
      // The database's own refusal, phrased as the endpoint's. Reached only by a writer that beat
      // the lock — but a 500 there would say "we broke" about a rule working exactly as intended.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new ConflictException(this.notEmptyMessage());
      }
      throw e;
    }
    return { ok: true };
  }

  /** One wording for both paths, so the answer does not depend on who noticed. */
  private notEmptyMessage(tasks?: number): string {
    return (
      `This project still holds ${tasks ?? 'one or more'} task(s) and cannot be deleted — ` +
      'move them to another project or delete them first'
    );
  }
}

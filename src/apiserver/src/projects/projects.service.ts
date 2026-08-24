import { createHash, randomUUID } from 'node:crypto';
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
import { toUuid } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MergeReceiptRow, mergeReceiptRow } from '../sessions/merge-receipt';
import { DependencyState, dependencyStateFromCounts } from '../tasks/task-dependencies';
import {
  DEFAULT_TASK_PAGE_SIZE,
  MAX_TASK_PAGE_SIZE,
  decodeTaskPageCursor,
  encodeTaskPageCursor,
} from '../tasks/tasks.service';
import { ProjectStatus as SharedProjectStatus } from '@orbit/shared';
import { CreateProjectDto, ReopenProjectDto, UpdateProjectDto } from './dto';
import { admitReopen, reopenImpact, type ReopenImpact } from './project-attribution-surface';
import { AcceptanceRefusal, ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectPanorama, readProjectPanorama } from './project-panorama';
import {
  DEFAULT_BLOCKING_LIMIT,
  MAX_BLOCKING_LIMIT,
  ProjectBlockingLeaderboard,
  readProjectBlockingLeaderboard,
} from './project-panorama-blocking';
import { taskNotRetiredSql, verificationFailureIsHistorySql } from '../tasks/task-supersession';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';

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
export const PROJECT_TASK_TREE_SELECT = {
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
  // §13.1 / §13.2, and the reason they are on the TREE rather than only on the task: this is the
  // page a plan is read through, and "which of these rows completes itself", "which of them is a
  // check" and "of what, concluding what" are the three questions a phase is judged by. Without
  // them a coordinator looking at its own project cannot tell a verification from a subtask.
  completionPolicy: true,
  verdict: true,
  verifiesTaskId: true,
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.TaskSelect;

/**
 * What a page row says about its place in the project's dependency graph.
 *
 * Derived on every read from the current graph, never stored — the same rule the rest of the
 * system derives `dependencyState` by (`task-dependencies.ts`), so a row here and the same task on
 * the task list cannot disagree about whether it is waiting.
 *
 * None of these four names is id-shaped, which is deliberate: `PUBLIC_ID_FIELDS` classifies by
 * field NAME, so a tally called `blockedById` would be run through the Base62 encoder as though it
 * were an address. Counts are counts.
 */
interface ProjectTaskDependencyFields {
  /** Prerequisites that are neither DONE nor CANCELLED — what this task is still waiting on. */
  unmetCount: number;
  /** Tasks that name this one as a prerequisite: what finishing it would release. */
  blocksCount: number;
  /** Longest prerequisite path to this task inside this project. A source sits at 0. */
  topoLevel: number;
  /**
   * `READY` | `BLOCKED` | `BLOCKED_FAILED`, from the one vocabulary the task list already uses.
   * `NONE` is not a fourth word here: a row with no prerequisites at all is a row nothing is
   * holding back, which is what READY says, and a client rendering a lock icon would have had to
   * treat the two identically anyway.
   */
  dependencyState: Exclude<DependencyState, 'NONE'>;
}

/** The raw tallies the graph query returns, before the state rule is applied to them. */
interface ProjectTaskDependencyRow extends Omit<ProjectTaskDependencyFields, 'dependencyState'> {
  id: string;
  prerequisiteCount: number;
  terminalCount: number;
  doneCount: number;
}

/** A task with no edges at all — also the shape a row falls back to, so no key ever goes missing. */
const UNCONNECTED_TASK: ProjectTaskDependencyFields = {
  unmetCount: 0,
  blocksCount: 0,
  topoLevel: 0,
  dependencyState: 'READY',
};

/** The shared rule, with this payload's collapse of `NONE` onto `READY` applied once. */
function projectTaskDependencyState(
  counts: Parameters<typeof dependencyStateFromCounts>[0],
): ProjectTaskDependencyFields['dependencyState'] {
  const state = dependencyStateFromCounts(counts);
  return state === 'NONE' ? 'READY' : state;
}

/**
 * What every project response says about its coordination, and the two rows it is read from.
 *
 * `coordinatorAgentId` lives on a `project_member` row rather than on a column of `project`,
 * because the coordinator is one role of a team and the same fact in two places is the one that
 * drifts. Clients are handed the fact, not the row: the team itself is not this phase's API, and a
 * `members` array in every project payload would be one.
 */
/**
 * The most tasks one project-graph response carries. Far above the size at which a node-link
 * picture is still readable — the client refuses to draw long before this — so it is a fence
 * against an unbounded response rather than a display limit.
 */
const PROJECT_DEPENDENCY_GRAPH_MAX_NODES = 500;

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
   * `acceptance` carries its own default so that the several dozen existing constructions of this
   * service — every one of them in a test, over a Prisma double — keep compiling and keep meaning
   * what they meant. Nest still injects the module's singleton in production: the parameter is
   * typed, so `design:paramtypes` names it and the DI container resolves it like the other two.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly acceptance: ProjectAcceptanceService = new ProjectAcceptanceService(prisma),
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
   * The tenancy check a task-scoped project route needs: this owner's task, filed under this
   * owner's project. One query rather than two, so a task that exists but belongs to another
   * project cannot be read through this project's URL — and `not found` is the same answer for
   * "no such task" and "not yours", which is what stops the route from confirming ids.
   */
  async assertTaskInProject(ownerId: string, projectId: string, taskId: string): Promise<void> {
    await this.assertOwned(ownerId, projectId);
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId, projectId },
      select: { id: true },
    });
    if (!task) throw new NotFoundException('task not found');
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
   *
   * `acceptance` is the other half of "is this project done". `tasksByStatus` measures the PROCESS
   * and can read 100% while nothing the project was for has been checked; the acceptance tally is
   * the OUTCOME — how many of the stated criteria the latest attempt concluded PASS about, from
   * §13.4's per-criterion rows. It sits beside `acceptanceCriteria`, the free text, and replaces
   * nothing about it: the prose is still what a person edits, and this is what a run concluded.
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
    const acceptance = await this.acceptance.criteriaSummary(id, project.acceptanceCriteria);
    return {
      ...withCoordination(project),
      tasksByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      acceptance,
    };
  }

  /**
   * The two sets of numbers the project page leads with: where its work actually stands, and what
   * shape its dependency graph is.
   *
   * Separate from `get` rather than folded into it, because they answer different questions at
   * different costs: `get` is the project's own record and its per-status tally, this walks every
   * dependency edge in the project. A page that only wants the title should not pay for the walk.
   */
  async panorama(ownerId: string, projectId: string): Promise<ProjectPanorama> {
    await this.assertOwned(ownerId, projectId);
    return readProjectPanorama(this.prisma, ownerId, projectId);
  }

  /**
   * Which unfinished tasks are holding up the most of this project, most first.
   *
   * The question the buckets raise and cannot answer: `blocked: 30` says the project is stuck and
   * says nothing about where to push. Ranked by how much each task releases through the WHOLE
   * dependency chain rather than one hop out — see `readProjectBlockingLeaderboard` for why the
   * direct edge count is not a usable ranking.
   */
  async panoramaBlocking(
    ownerId: string,
    projectId: string,
    query: { limit?: string } = {},
  ): Promise<ProjectBlockingLeaderboard> {
    await this.assertOwned(ownerId, projectId);
    const limit = query.limit === undefined ? DEFAULT_BLOCKING_LIMIT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BLOCKING_LIMIT) {
      throw new BadRequestException(`limit must be an integer from 1 to ${MAX_BLOCKING_LIMIT}`);
    }
    return readProjectBlockingLeaderboard(this.prisma, ownerId, projectId, limit);
  }

  /** The stored outcome, or undefined when a row predates the audit fields this read projects.
   *  `outcome` is a JSON column, so its shape is a claim about older rows rather than a type. */

  /** One decision, with the actions it produced and the two run states it moved between. */

  /** One outbox row. `dedupeKey` carries embedded ids for the same reason an action key does. */

  /** The coordinator conversation's run and lifecycle state, derived the one way every other
   *  Session payload derives it — a second mapping here is a second answer to "is it finished". */

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
    // One pass over the project's graph for the whole page, never one per row: the level a task
    // sits at is a fact about the graph rather than about the row, so it cannot be answered by
    // selecting more columns of `task`.
    const dependencies = await this.taskDependencyFields(
      ownerId,
      projectId,
      page.map((task) => task.id),
    );
    const items = page.map(({ _count, ...task }) => ({
      ...task,
      childCount: _count.children,
      // Never spread-with-fallback into nothing: a row that somehow missed the graph pass still
      // carries all four keys, because an absent key reads to a client as "this endpoint does not
      // report dependencies" rather than as "this task has none".
      ...(dependencies.get(task.id) ?? UNCONNECTED_TASK),
    }));
    return {
      items,
      nextCursor: hasMore && page.length ? encodeTaskPageCursor(page[page.length - 1]) : null,
    };
  }

  /**
   * Where each of these tasks sits in its project's dependency graph, in one recursive query.
   *
   * Four derived facts, and they are not all scoped the same way, because they answer different
   * questions:
   *   - `unmetCount`, `blocksCount` and `dependencyState` count EVERY edge this owner has into or
   *     out of the task. A prerequisite filed under another project still stops the dispatcher, so
   *     a project-scoped tally here would show `READY` on a row nothing will start.
   *   - `topoLevel` is the longest prerequisite path INSIDE this project, which is what a reader
   *     of this project's plan is asking for. A task whose only prerequisite is elsewhere is a
   *     source of this graph, at level 0, and its `dependencyState` still says it is waiting.
   *
   * The level is a longest path, not a shortest one: a task belongs below everything it waits on,
   * so a node reachable at depths 1 and 3 sits at 3. `UNION` (not `UNION ALL`) is what keeps that
   * affordable — the recursion dedupes `(task, level)` pairs against everything already produced,
   * so a diamond is walked once per level rather than once per path, and a 118-node project costs
   * one query instead of 118.
   */
  private async taskDependencyFields(
    ownerId: string,
    projectId: string,
    taskIds: string[],
  ): Promise<Map<string, ProjectTaskDependencyFields>> {
    if (taskIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<ProjectTaskDependencyRow>>(Prisma.sql`
      WITH RECURSIVE
      "scoped" AS (
        SELECT t."id"
          FROM "task" t
         WHERE t."owner_id" = ${ownerId}::uuid AND t."project_id" = ${projectId}::uuid
      ),
      "inbound" AS (
        SELECT d."task_id" AS "id", p."status"::text AS "status"
          FROM "task_dependency" d
          JOIN "scoped" s ON s."id" = d."task_id"
          JOIN "task" p ON p."id" = d."depends_on_task_id" AND p."owner_id" = ${ownerId}::uuid
      ),
      "tally" AS (
        SELECT "id",
               COUNT(*)::int AS "prerequisiteCount",
               COUNT(*) FILTER (WHERE "status" NOT IN ('DONE', 'CANCELLED'))::int AS "unmetCount",
               COUNT(*) FILTER (WHERE "status" IN ('CANCELLED', 'FAILED'))::int AS "terminalCount",
               COUNT(*) FILTER (WHERE "status" = 'DONE')::int AS "doneCount"
          FROM "inbound"
         GROUP BY "id"
      ),
      "outbound" AS (
        SELECT d."depends_on_task_id" AS "id", COUNT(*)::int AS "blocksCount"
          FROM "task_dependency" d
          JOIN "scoped" s ON s."id" = d."depends_on_task_id"
          JOIN "task" c ON c."id" = d."task_id" AND c."owner_id" = ${ownerId}::uuid
         GROUP BY d."depends_on_task_id"
      ),
      "edge" AS (
        SELECT d."task_id", d."depends_on_task_id"
          FROM "task_dependency" d
          JOIN "scoped" a ON a."id" = d."task_id"
          JOIN "scoped" b ON b."id" = d."depends_on_task_id"
      ),
      "walk" AS (
        SELECT s."id", 0 AS "lvl"
          FROM "scoped" s
         WHERE NOT EXISTS (SELECT 1 FROM "edge" e WHERE e."task_id" = s."id")
         UNION
        SELECT e."task_id", w."lvl" + 1
          FROM "walk" w
          JOIN "edge" e ON e."depends_on_task_id" = w."id"
         -- A DAG's longest path is shorter than its node count, so this bound is unreachable by a
         -- well-formed graph and is the fence that stops a cycle that slipped past the write-side
         -- check from spinning here forever.
         WHERE w."lvl" < (SELECT COUNT(*) FROM "scoped")
      ),
      "topo" AS (SELECT "id", MAX("lvl")::int AS "topoLevel" FROM "walk" GROUP BY "id")
      SELECT s."id",
             COALESCE(t."unmetCount", 0) AS "unmetCount",
             COALESCE(o."blocksCount", 0) AS "blocksCount",
             COALESCE(p."topoLevel", 0) AS "topoLevel",
             COALESCE(t."prerequisiteCount", 0) AS "prerequisiteCount",
             COALESCE(t."terminalCount", 0) AS "terminalCount",
             COALESCE(t."doneCount", 0) AS "doneCount"
        FROM "scoped" s
        LEFT JOIN "tally" t ON t."id" = s."id"
        LEFT JOIN "outbound" o ON o."id" = s."id"
        LEFT JOIN "topo" p ON p."id" = s."id"
       WHERE s."id" IN (${Prisma.join(taskIds)})
    `);
    return new Map(
      rows.map((row) => [
        row.id,
        {
          unmetCount: row.unmetCount,
          blocksCount: row.blocksCount,
          topoLevel: row.topoLevel,
          dependencyState: projectTaskDependencyState({
            prerequisites: row.prerequisiteCount,
            terminal: row.terminalCount,
            done: row.doneCount,
          }),
        },
      ]),
    );
  }

  /**
   * This project's dependency graph: every task filed under it, and every dependency edge whose
   * BOTH ends are also filed under it.
   *
   * Its own endpoint rather than `GET /tasks/:id/dependency-graph` pointed at the project's first
   * task, which was the cheaper option and was evaluated first. Three things make that endpoint
   * answer a different question than this page asks:
   *   - it is a breadth-first walk out of ONE focus, so what comes back is that task's weakly
   *     connected component. A project's unconnected tasks are simply not in the picture, and a
   *     picture that silently omits tasks is worse on a project page than no picture;
   *   - its traversal is scoped by `ownerId` and never by project (`tasks.service.ts`), so a
   *     dependency filed across a project boundary drags the neighbouring project's tasks in;
   *   - its depth is capped at `MAX_DEPENDENCY_GRAPH_MAX_DEPTH` (32), and a chain-shaped project
   *     of 118 tasks is 117 levels deep.
   *
   * The response deliberately reuses that endpoint's vocabulary — `nodes`, `edges` carrying
   * `sourceTaskId` -> `targetTaskId` in prerequisite-to-dependent order, `truncated` — so the
   * client reads both graphs with one set of words (`web/src/lib/taskDependencyGraph.ts`) instead
   * of a second one that means the same things.
   *
   * An edge with one end outside the project is dropped rather than drawn to a stub node: it
   * belongs to another project's plan, and a node this page cannot open is worse than a missing
   * line. What a task waits on across that boundary is what the task page's `dependencyState`
   * already reports.
   */
  async dependencyGraph(ownerId: string, projectId: string) {
    await this.assertOwned(ownerId, projectId);

    // One row past the cap, so a project too large to answer for is REPORTED as truncated rather
    // than served short and read as the whole plan.
    const rows = await this.prisma.task.findMany({
      where: { ownerId, projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PROJECT_DEPENDENCY_GRAPH_MAX_NODES + 1,
      select: { id: true, title: true, status: true, parentTaskId: true },
    });
    const truncated = rows.length > PROJECT_DEPENDENCY_GRAPH_MAX_NODES;
    const nodes = truncated ? rows.slice(0, PROJECT_DEPENDENCY_GRAPH_MAX_NODES) : rows;
    const ids = nodes.map((node) => node.id);
    const edges = ids.length
      ? await this.prisma.taskDependency.findMany({
          where: { taskId: { in: ids }, dependsOnTaskId: { in: ids } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { taskId: true, dependsOnTaskId: true },
        })
      : [];

    return {
      nodes,
      // `depends_on_task_id` is the PREREQUISITE and `task_id` is the task waiting on it — the
      // opposite order to how the column names read, and the one thing here that is easy to get
      // backwards. Arrows flow prerequisite -> dependent, so the prerequisite is the source.
      edges: edges.map((edge) => ({
        sourceTaskId: edge.dependsOnTaskId,
        targetTaskId: edge.taskId,
      })),
      truncated,
      limits: { maxNodes: PROJECT_DEPENDENCY_GRAPH_MAX_NODES },
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
   * Still no promise of listing projects, opening another coordinator, or driving a runner
   * directly. None of those reaches a runner, and naming one would recreate the hunt. Deletion
   * does reach the runner now, but stays out of startup guidance: it is a destructive cleanup
   * operation for an explicit request, not part of ordinary coordination.
   */

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

    // §13.4 AE7: a write that settles the project takes the EXCLUSIVE lock, and takes it as the
    // transaction's first statement. Everything that could change the acceptance facts holds
    // `FOR NO KEY UPDATE` on the same row, and the two conflict — which is what makes "the fact
    // changed" and "the project was accepted" two orderings rather than an interleaving. §8.6 LO3
    // forbids starting weak and upgrading, so the strength is chosen here, before the first read.
    const settling = dto.status === ProjectStatus.DONE;
    // What the reopen below did, for the caller that asked for it. Declared outside the retry
    // closure and overwritten by each attempt, so a retried transaction reports what the attempt
    // that COMMITTED found rather than what an aborted one saw.
    let reopened: { fromEpoch: string; toEpoch: string; retiredRuns: number; wasLegacy: boolean }
      | null = null;
    try {
    // Retried whole. The project row is locked and re-read inside the closure, and every field the
    // update derives — the acceptance recompute, the coordinator rebind — comes from that read, so
    // a re-run writes against the row the winner left rather than the one an aborted attempt saw.
      const project = await withTransactionRetry(this.prisma, async (tx) => {
        // The project row first, and this is the lock a coordinator has to take before committing
        // anything the fields above authorize. Taking it here is what makes "the user revoked it"
        // and "the coordinator acted on what it read" two orderings rather than an interleaving:
        // whichever commits first, the other sees it. It also fixes the order of the two writes
        // below (project before its team row), which is the order every path takes.
        const select = Prisma.sql`
          SELECT "coordinator_enabled", "config_revision", "status"::text AS "status",
                 "accepted_run_id" AS "accepted_run_id", "legacy_accepted_at" AS "legacy_accepted_at",
                 "acceptance_epoch" AS "acceptance_epoch"
            FROM "project"
           WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid`;
        const [locked] = await tx.$queryRaw<Array<{
          coordinator_enabled: boolean;
          config_revision: bigint;
          status: string;
          accepted_run_id: string | null;
          legacy_accepted_at: Date | null;
          acceptance_epoch: bigint;
        }>>(settling
          ? Prisma.sql`${select} FOR UPDATE`
          : Prisma.sql`${select} FOR NO KEY UPDATE`);
        if (!locked) throw new NotFoundException('project not found');
        // Under the lock, so the comparison and the write cannot be separated by another writer.
        // Throwing here rolls the transaction back, which is the whole guarantee a stale write
        // needs: refused AND nothing written, including the team row below.
        ProjectsService.assertConfigRevision(dto.expectedConfigRevision, locked.config_revision);
        // The value the lock produced, not the one read before it: a concurrent write that turned
        // this project off is exactly the case the check has to see.
        ProjectsService.assertLevelNamedWhenTurningOn(locked.coordinator_enabled, dto);

        // §13.4 AE2, in the transaction that writes DONE and after the lock that orders it. AE5:
        // this is the one place `project.status = DONE` is decided, so a user in the web app, the
        // CLI, MCP `project_update` and a coordinator inside a turn all meet the same check.
        //
        // Idempotent by re-reading the LOCKED row rather than by trusting the caller: a project
        // that is already DONE is not re-gated and not re-bound, so pressing the button twice
        // produces one binding and one audit row.
        if (settling && locked.status !== ProjectStatus.DONE) {
          const gate = await this.acceptance.assertDoneAllowed(tx, id);
          data.acceptedRunId = gate.runId;
          await ProjectAcceptanceService.writeAudit(
            tx, id, 'done_bound', `bound to acceptance attempt ${gate.attempt}`,
            { attempt: String(gate.attempt), acceptanceDigest: gate.digest }, gate.runId,
          );
        }

        // Unit L7: the second confirmation, evaluated HERE and not at the door that asked for it.
        // A reopen starts a new acceptance epoch, and the number a person was shown when they
        // decided that has to be the number the row still holds when the decision commits —
        // otherwise a second tab that reopened it first turns one considered reopen into two.
        //
        // Judged on BOTH settled statuses, because that is what actually advances the epoch:
        // migration 0150's `project_acceptance_advance_epoch` fires on DONE → OPEN and on
        // CANCELLED → OPEN alike. Gating only on DONE would leave one reopen confirmed and the
        // other silent while both cost the project its acceptance standing. What the branch below
        // does — retiring runs, dropping the binding — is unchanged and still DONE's alone.
        //
        // The acknowledgement is optional on this path and required on `POST :id/reopen`, which is
        // the door a person acts through: an older client and the repair paths keep the reopen they
        // have always had (§8 CM1), and nothing that omits it gains a fence it never asked for.
        if (dto.status === ProjectStatus.OPEN && locked.status !== ProjectStatus.OPEN) {
          const impact = reopenImpact({
            status: locked.status as 'DONE' | 'CANCELLED' | 'OPEN',
            acceptanceEpoch: String(locked.acceptance_epoch),
            liveAcceptanceRuns: 0,
            legacyAccepted: locked.legacy_accepted_at !== null,
          });
          if (dto.acknowledgedAcceptanceEpoch !== undefined) {
            const admitted = admitReopen(impact, dto.acknowledgedAcceptanceEpoch);
            if (!admitted.allowed) {
              throw new ConflictException({
                statusCode: 409,
                error: 'Conflict',
                code: admitted.code,
                message: admitted.message,
                owner: 'USER',
                requiredAction: impact.requiredAction,
                fromEpoch: impact.fromEpoch,
                toEpoch: impact.toEpoch,
              });
            }
          }
          reopened = {
            fromEpoch: impact.fromEpoch,
            toEpoch: impact.toEpoch,
            retiredRuns: 0,
            wasLegacy: impact.wasLegacy,
          };
        }

        // The reverse door, and the reason a stale PASS cannot be reused: reopening a project
        // retires every acceptance run it has. AE4 says old evidence does not need invalidating
        // because the digest stops matching — true for a fact change, and NOT true here, since a
        // reopen on its own changes none of the four projections. So this is the one invalidation
        // that has to be written rather than derived.
        if (dto.status === ProjectStatus.OPEN && locked.status === ProjectStatus.DONE) {
          const retired = await tx.projectAcceptanceRun.updateMany({
            where: { projectId: id, supersededAt: null },
            data: { supersededAt: new Date(), supersededReason: 'reopened_by_user' },
          });
          if (reopened) reopened.retiredRuns = retired.count;
          data.acceptedRunId = null;
          // A legacy DONE that a person reopens stops being one: its next DONE has to earn a run
          // like any other, which is how the compatibility stamp expires instead of accumulating.
          data.legacyAcceptedAt = null;
          await ProjectAcceptanceService.writeAudit(
            tx, id, 'reopened_by_user', 'the owner reopened this project',
            { previousAcceptedRunId: locked.accepted_run_id, wasLegacy: locked.legacy_accepted_at !== null },
            locked.accepted_run_id,
          );
        }

        if (agentId !== undefined) {
          await ProjectsService.writeCoordinatorAgent(tx, ownerId, id, agentId);
        }
        return tx.project.update({ where: { id }, data, include: COORDINATION_INCLUDE });
      }, loggedRetry(this.logger, 'projects.update'));
      // `reopened` is absent — not null — on every write that did not reopen anything, so a client
      // branching on it cannot read "this write reopened nothing" as "this write reopened
      // something with no detail".
      return reopened ? { ...withCoordination(project), reopened } : withCoordination(project);
    } catch (e) {
      // A refused DONE is a thing somebody has to be able to look up afterwards — "I pressed it and
      // nothing happened" is the report, and the refusal itself rolled back with the transaction
      // that raised it. Written outside that transaction, best effort: failing to record why a
      // write was refused must not turn the refusal into a 500.
      if (e instanceof AcceptanceRefusal) {
        await this.prisma.projectAcceptanceAudit
          .create({
            data: {
              projectId: id,
              kind: 'done_refused',
              reason: e.code,
              detail: e.getResponse() as Prisma.InputJsonValue,
            },
          })
          .catch(() => undefined);
        throw e;
      }
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
   * Unit L7: what reopening this project would cost, before anybody spends it.
   *
   * The read half of the second confirmation. It answers three questions a person cannot answer
   * from the project page as it stands — which epoch the project is in, which one a reopen would
   * start, and how many acceptance attempts stop being current when it does — and it hands back
   * the `acknowledgement` the write then has to echo. That round trip is what makes the
   * confirmation about THIS project at THIS moment rather than about a dialog somebody clicked
   * through: an epoch read a minute ago and reopened now is refused, not merged.
   *
   * Read-only and unlocked on purpose. It is a preview, and a preview that took the row lock would
   * serialize every project page against every acceptance write for a number that the write path
   * re-reads under its own lock anyway.
   */
  async reopenPreview(ownerId: string, id: string): Promise<ReopenImpact> {
    const project = await this.prisma.project.findFirst({
      where: { id, ownerId },
      select: { status: true, acceptanceEpoch: true, legacyAcceptedAt: true },
    });
    if (!project) throw new NotFoundException('project not found');
    // The attempts that are live TODAY: a run already superseded by a later attempt is not
    // something this reopen retires, and counting it would overstate what the person is agreeing
    // to. Only meaningful for a settled project, which is why `reopenImpact` zeroes it otherwise.
    const liveAcceptanceRuns = await this.prisma.projectAcceptanceRun.count({
      where: { projectId: id, supersededAt: null },
    });
    return reopenImpact({
      status: project.status as 'OPEN' | 'DONE' | 'CANCELLED',
      acceptanceEpoch: String(project.acceptanceEpoch),
      liveAcceptanceRuns,
      legacyAccepted: project.legacyAcceptedAt !== null,
    });
  }

  /**
   * Unit L7: reopen a settled project, having said which epoch that decision was made against.
   *
   * `update` with `status: OPEN` is what actually reopens — this is not a second implementation of
   * it, and deliberately not: two paths that both reopen are two chances to disagree about what a
   * reopen retires. What this door adds is that the acknowledgement is not optional here, so the
   * only way to reach it is to have read what it costs.
   *
   * The refusals a person can hit are answered BEFORE the write rather than by letting the update
   * fall over: an OPEN project has nothing to reopen (`PROJECT_NOT_SETTLED`), and an epoch that has
   * moved since it was read is `REOPEN_ACKNOWLEDGEMENT_STALE` — raised again under the row lock by
   * `update`, which is the copy that decides. Checking here as well is what makes the common case a
   * clear answer instead of a rolled-back transaction.
   */
  async reopen(ownerId: string, id: string, dto: ReopenProjectDto) {
    const impact = await this.reopenPreview(ownerId, id);
    const admitted = admitReopen(impact, dto.acknowledgedAcceptanceEpoch);
    if (!admitted.allowed) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: admitted.code,
        message: admitted.message,
        owner: 'USER',
        requiredAction: impact.requiredAction,
        fromEpoch: impact.fromEpoch,
        toEpoch: impact.toEpoch,
      });
    }
    return this.update(ownerId, id, {
      status: SharedProjectStatus.OPEN,
      acknowledgedAcceptanceEpoch: dto.acknowledgedAcceptanceEpoch,
      ...(dto.expectedConfigRevision !== undefined
        ? { expectedConfigRevision: dto.expectedConfigRevision }
        : {}),
    });
  }

  /**
   * The compare-and-swap every control write goes through, or nothing if the caller did not state
   * a revision.
   *
   * Not sending one is a legitimate request — it is what every client sent before this existed,
   * and what a caller with no reason to fence still sends. Sending one is a claim: "I composed
   * this against revision N". If the project has moved on, the edit is refused with both numbers
   * in the body, so the client can re-read, re-decide and retry rather than guess what changed.
   */
  private static assertConfigRevision(expected: string | undefined, actual: bigint): void {
    if (expected === undefined) return;
    if (expected === String(actual)) return;
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'STALE_CONFIG_REVISION',
      message:
        `this project is at configRevision ${actual}, not ${expected} — its coordination settings ` +
        'changed after you read them, so nothing was written',
      owner: 'USER',
      requiredAction: 're-read this project, decide against the current settings, and write again',
      expectedConfigRevision: expected,
      configRevision: String(actual),
    });
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
    // Retried whole: a delete re-reads what it is deleting under the row lock, and deleting
    // something already gone is the same answer on any attempt.
      await withTransactionRetry(this.prisma, async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "project"
          WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
          FOR UPDATE`;
        if (locked.length === 0) throw new NotFoundException('project not found');
        const tasks = await tx.task.count({ where: { projectId: id } });
        if (tasks > 0) throw new ConflictException(this.notEmptyMessage(tasks));
        await tx.project.delete({ where: { id } });
      }, loggedRetry(this.logger, 'projects.remove'));
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

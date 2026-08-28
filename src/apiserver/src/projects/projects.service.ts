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
  RunStatus,
  TaskStatus,
} from '@prisma/client';
import {
  type SessionFilingState,
  type SessionLifecycleState,
  type SessionRunState,
  toUuid,
} from '@orbit/shared';
import { isSessionGenerating } from '../common/session-generating';
import { SingleFlight } from '../common/single-flight';
import {
  completionAckObligationsBy,
  readCompletionAckObligations,
} from '../common/completion-ack-obligation';
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
import {
  CreateProjectDto,
  DecideCompletionAckOwnerDecisionDto,
  MAX_PROJECT_ACCEPTANCE_CRITERIA_CHARS,
  MAX_PROJECT_ACCEPTANCE_CRITERIA_ITEMS,
  MAX_PROJECT_ACCEPTANCE_VERIFICATION_METHOD_CHARS,
  ReopenProjectDto,
  RequestCompletionAckOwnerDecisionDto,
  UpdateProjectDto,
  type UpdateProjectAcceptanceCriterionDto,
} from './dto';
import { admitReopen, reopenImpact, type ReopenImpact } from './project-attribution-surface';
import { AcceptanceRefusal, ProjectAcceptanceService } from './project-acceptance.service';
import {
  criteriaLegacyProjection,
  sha256,
} from './project-acceptance';
import { DEFAULT_FOLD_OPTIONS, foldProjectGraph } from './project-graph-fold';
import {
  buildCoordinatorInstructions,
  buildCoordinatorOpening,
  coordinatorSessionTitle,
} from './coordinator-opening';
import { authorityPrincipal, refuseHumanOnlyAction } from './coordinator-authority';
import { withSessionState } from '../sessions/session-state';
import { SessionsService } from '../sessions/sessions.service';
import { ProjectPanorama, readProjectPanorama } from './project-panorama';
import { emptyProjectListRollup, readProjectListRollups } from './project-list-rollup';
import {
  emptyProjectListAttention,
  readProjectListAttention,
} from './project-list-attention';
import {
  DEFAULT_BLOCKING_LIMIT,
  MAX_BLOCKING_LIMIT,
  ProjectBlockingLeaderboard,
  readProjectBlockingLeaderboard,
} from './project-panorama-blocking';
import { ProjectReadyToRun, readProjectReadyToRun } from './project-ready-to-run';
import { taskNotRetiredSql, verificationFailureIsHistorySql } from '../tasks/task-supersession';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import {
  TASK_COMPLETION_CRITERIA,
  type TaskCompletionCriterionValue,
} from '../tasks/task-completion-criterion';
import {
  MAX_TASK_CRITERION_OVERRIDE_REASON_CHARS,
  normaliseTaskCriterionOverrideReason,
  taskCriterionShapeAdvice,
  taskCriterionShapeAdviceBody,
} from '../tasks/task-criterion-shape-advice';

/**
 * "This project's coordinator belongs in a workspace that will not have it."
 *
 * Exported because it is a contract value rather than a message: the control loop opens a blocker
 * with this code (§7.5, §11), and clients switch on it to send the owner to the one setting that
 * resolves it.
 */
export const COORDINATOR_UNAVAILABLE_CODE = 'COORDINATOR_UNAVAILABLE';

/**
 * "This project's coordinator is a conversation somebody is still in."
 *
 * Exported for `COORDINATOR_UNAVAILABLE_CODE`'s reason, and spelled exactly as §7.5's rotation
 * spells it in the action audit: one situation, one name, whether it was reached by the loop
 * declining to rotate or by an owner trying to move the landing out from under a live run.
 */
export const COORDINATOR_SESSION_LIVE_CODE = 'COORDINATOR_SESSION_LIVE';

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

/** Authenticated provenance for an atomic creation-time owner decision. It is transport context,
 * never accepted from CreateProjectDto. */
export interface ProjectCreatePrincipal {
  type: 'OWNER' | 'RUNNER' | 'SYSTEM';
  id: string;
}

/** Internal retry signal: the coordinator pointer changed between the optimistic pre-read (which
 * tells us which rank-30 Session to lock first) and the rank-40 Project lock that validates it. */
class CoordinatorBindingChanged extends Error {}

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
  completionCriterion: true,
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
/**
 * The most tasks one project graph request reads before it gives up on being complete.
 *
 * Not a drawing limit — the fold decides what is drawn. This is the ceiling on how much of a
 * project one request will hold in memory to fold at all, and it sits far above the largest
 * project here (23,442 tasks) so that `truncated` means "this project is bigger than anything we
 * have ever seen" rather than "you have more than thirty tasks".
 */
const PROJECT_GRAPH_MAX_TASKS = 50_000;

const COORDINATION_INCLUDE = {
  members: { where: { role: ProjectRole.COORDINATOR }, select: { agentId: true } },
  runtime: { select: { coordinatorGeneration: true } },
} satisfies Prisma.ProjectInclude;

/**
 * A row on the project index, as opposed to a project document.
 *
 * The detail-only prose and policy fields are intentionally absent. In production, 22 OPEN
 * projects carried more than 60 KiB of acceptance criteria and instructions that every list
 * client parsed and discarded. The task total is absent too: the rollup already visits every
 * scoped task and returns that count, so asking Prisma for a second aggregate only repeats work.
 */
const PROJECT_LIST_SELECT = {
  id: true,
  title: true,
  status: true,
  goal: true,
  createdAt: true,
  updatedAt: true,
  ...COORDINATION_INCLUDE,
} satisfies Prisma.ProjectSelect;

const ACCEPTANCE_DEFINITIONS_INCLUDE = {
  orderBy: { ordinal: 'asc' as const },
  select: {
    id: true,
    ordinal: true,
    text: true,
    verificationMethod: true,
    completionCriterion: true,
    acceptanceCommand: true,
    acceptanceExpectedExitCode: true,
    evidenceTaskId: true,
    completionCriterionOverrideReason: true,
    revision: true,
    contentHash: true,
    semanticRevision: true,
    semanticHash: true,
    evaluationPlanRevision: true,
    evaluationPlanHash: true,
  },
};

type ProjectMutationPayload = Prisma.ProjectGetPayload<{
  include: typeof COORDINATION_INCLUDE & {
    acceptanceCriterionDefinitions: typeof ACCEPTANCE_DEFINITIONS_INCLUDE;
  };
}>;

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

type WithAcceptanceDefinitions = {
  acceptanceCriterionDefinitions?: Array<{
    id: string;
    ordinal: number;
    text: string;
    verificationMethod: string;
    completionCriterion: TaskCompletionCriterionValue;
    acceptanceCommand: string | null;
    acceptanceExpectedExitCode: number | null;
    evidenceTaskId: string | null;
    completionCriterionOverrideReason: string | null;
    revision: number;
    contentHash: string;
    semanticRevision: number;
    semanticHash: string;
    evaluationPlanRevision: number;
    evaluationPlanHash: string;
  }>;
  acceptanceCriteriaFormat?: string;
  acceptanceCriteria?: string | null;
  acceptance?: {
    criteria?: Array<{ id: string; verdict: string }>;
  } | null;
};

/** Fold the storage relation into the author-facing array. The legacy text stays beside it during
 * the compatibility window, while `migration` makes a conservative one-item backfill that looks
 * like an inline numbered list visible rather than silently claiming it was reviewed. */
function withAcceptanceDefinitions<T extends WithAcceptanceDefinitions>(project: T) {
  const { acceptanceCriterionDefinitions, ...rest } = project;
  const definitions = acceptanceCriterionDefinitions ?? [];
  const format = project.acceptanceCriteriaFormat ?? 'LEGACY_TEXT';
  const legacyLooksAmbiguous =
    format === 'LEGACY_TEXT' &&
    definitions.length === 1 &&
    /[;；]\s*(?:\(?\d+[.)、]|[（(]\d+[）)])/u.test(project.acceptanceCriteria ?? '');
  const currentStatus = new Map(
    (project.acceptance?.criteria ?? []).map((criterion) => [criterion.id, criterion.verdict]),
  );
  return {
    ...rest,
    acceptanceCriteriaItems: definitions.map((criterion) => ({
      id: criterion.id,
      ordinal: criterion.ordinal,
      text: criterion.text,
      verificationMethod: criterion.verificationMethod,
      completionCriterion: criterion.completionCriterion ?? 'HUMAN_SIGNOFF',
      acceptanceCommand: criterion.acceptanceCommand ?? null,
      acceptanceExpectedExitCode: criterion.acceptanceExpectedExitCode ?? null,
      evidenceTaskId: criterion.evidenceTaskId ?? null,
      completionCriterionOverrideReason: criterion.completionCriterionOverrideReason ?? null,
      // A view over the latest applicable acceptance run, never another authored/stored field.
      currentStatus: currentStatus.get(criterion.id) ?? 'UNDECIDED',
      revision: criterion.revision,
      contentHash: criterion.contentHash,
      // Rolling/mock compatibility: old readers can omit the two new digest lanes. Real rows on
      // migration 0195 always contain them, and then they are returned together as one coherent
      // projection rather than leaking `undefined` keys into legacy API shapes.
      ...(criterion.semanticRevision === undefined ? {} : {
        semanticRevision: criterion.semanticRevision,
        semanticHash: criterion.semanticHash,
        evaluationPlanRevision: criterion.evaluationPlanRevision,
        evaluationPlanHash: criterion.evaluationPlanHash,
      }),
    })),
    acceptanceCriteriaMigration: {
      source: format,
      needsReview: legacyLooksAmbiguous,
      reason: legacyLooksAmbiguous ? 'AMBIGUOUS_SINGLE_LINE_ENUMERATION' : null,
    },
  };
}

/**
 * The four buckets a project's coordination sorts into.
 *
 * A project-coordination bucket rather than a session run state, which is the distinction the
 * whole card turns on: a LIVE coordinator sitting in a workspace that was disabled underneath it
 * is still LIVE, because `coordinator`'s reuse branch returns the bound session and never reaches
 * the landing. The truth table is in `docs/project-coordinator-status-contract.md`.
 */
export type ProjectCoordinationState = 'NEVER_OPENED' | 'LIVE' | 'TRASHED' | 'UNAVAILABLE';

/** The read's name for the 400 `coordinatorLanding` throws when a FIRST coordinator has nowhere to
 *  open. The other refusal it predicts already has a name clients switch on
 *  (`COORDINATOR_UNAVAILABLE_CODE`), and this one is given a name for the same reason. */
const NO_LANDING_WORKSPACE_CODE = 'NO_LANDING_WORKSPACE';

/** The session columns the coordinator status read needs. `archivedAt` is here only because
 *  `withSessionState` folds it into `completedAt`; it is never served under its own name. */
const COORDINATOR_STATUS_SESSION_SELECT = {
  id: true,
  title: true,
  status: true,
  endReason: true,
  startedAt: true,
  finishedAt: true,
  completedAt: true,
  archivedAt: true,
  deletedAt: true,
  engineTurnActive: true,
} satisfies Prisma.SessionSelect;

type CoordinatorStatusSessionRow = Prisma.SessionGetPayload<{
  select: typeof COORDINATOR_STATUS_SESSION_SELECT;
}>;

/**
 * What `GET /projects/:id/coordinator/status` serves.
 *
 * Every fact with no value is `null` beside a closed-set `<field>AbsentReason` rather than dropped
 * — that is what lets a client tell "this project has never had a coordinator" from "this server
 * does not report one". Nothing is ever omitted from the body.
 */
export interface ProjectCoordinatorStatus {
  projectId: string;
  readAt: Date;
  state: ProjectCoordinationState;
  coordination: {
    sessionId: string | null;
    sessionIdAbsentReason: CoordinatorSessionAbsentReason;
    session: {
      id: string;
      title: string;
      runStatus: RunStatus;
      runState: SessionRunState;
      lifecycleState: SessionLifecycleState;
      /** @deprecated Compatibility mirror of `lifecycleState`, as on every Session payload. */
      filingState: SessionFilingState;
      endReason: string | null;
      endReasonAbsentReason: 'SESSION_NOT_ENDED' | null;
      startedAt: Date | null;
      startedAtAbsentReason: 'SESSION_NEVER_STARTED' | null;
      finishedAt: Date | null;
      finishedAtAbsentReason: 'SESSION_STILL_RUNNING' | null;
      completedAt: Date | null;
      completedAtAbsentReason: 'SESSION_NOT_COMPLETED' | null;
      deletedAt: Date | null;
      deletedAtAbsentReason: 'SESSION_NOT_TRASHED' | null;
      engineTurnActive: boolean;
      pendingApprovals: number;
    } | null;
    sessionAbsentReason: CoordinatorSessionAbsentReason;
    /** Serialised as a decimal string by the global `BigInt.prototype.toJSON`: the counter only
     *  ever goes up, and JSON numbers are doubles. */
    coordinatorGeneration: bigint;
    workspaceId: string | null;
    workspaceIdAbsentReason: CoordinationWorkspaceAbsentReason;
    workspaceName: string | null;
    workspaceNameAbsentReason: CoordinationWorkspaceAbsentReason | 'COORDINATION_WORKSPACE_TRASHED';
    agentId: string | null;
    agentIdAbsentReason: 'NO_COORDINATOR_AGENT' | null;
    agentName: string | null;
    agentNameAbsentReason: 'NO_COORDINATOR_AGENT' | null;
  };
  openability: {
    canOpen: boolean;
    willCreate: boolean;
    refusalCode: typeof COORDINATOR_UNAVAILABLE_CODE | typeof NO_LANDING_WORKSPACE_CODE | null;
    /** A refinement of `refusalCode`, null exactly when that is — so it shares
     *  `refusalCodeAbsentReason` rather than carrying a second one. */
    refusalDetail: CoordinatorRefusalDetail;
    refusalCodeAbsentReason: 'NOTHING_REFUSES' | null;
    requiredAction: string | null;
    requiredActionAbsentReason: 'NOTHING_REFUSES' | null;
    landing: {
      workspaceId: string | null;
      workspaceIdAbsentReason: LandingAbsentReason;
      workspaceName: string | null;
      workspaceNameAbsentReason: LandingAbsentReason;
      /** Always null. A landing is a place, not an identity, and `WorkspaceAliasInterceptor` would
       *  otherwise invent one from the `workspaceId` beside it. */
      agentId: null;
      agentName: null;
      fixed: boolean;
    };
  };
}

/** Told apart by the WORKSPACE, never by the generation — a first bind is generation 0 by design. */
type CoordinatorSessionAbsentReason = 'COORDINATOR_NEVER_OPENED' | 'COORDINATOR_SESSION_PURGED' | null;

/** The pointer is emptied by a workspace HARD delete only; a soft delete leaves it standing. */
type CoordinationWorkspaceAbsentReason =
  | 'NO_COORDINATION_WORKSPACE'
  | 'COORDINATION_WORKSPACE_PURGED'
  | null;

type CoordinatorRefusalDetail =
  | 'WORKSPACE_TRASHED'
  | 'WORKSPACE_DISABLED'
  | 'WORKSPACE_UNBOUND'
  | 'WORKSPACE_FORGOTTEN'
  | 'NO_TASK_ASSIGNEE'
  | null;

type LandingAbsentReason = 'COORDINATOR_ALREADY_LIVE' | 'LANDING_REFUSED' | null;

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
  private readonly listSingleFlight = new SingleFlight();

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

  /** The same answer for a landing, which is a workspace rather than an identity and so has one
   *  more way to be unusable: `enabled`. A disabled landing is refused HERE rather than left to
   *  `sessions.create`, because accepting it would write the `COORDINATOR_UNAVAILABLE` this call
   *  exists to resolve — the owner would rebind, get a 200, and find the coordinator just as
   *  unopenable as before. See `lastCoordinatorWorkspace` for the read side of the same two
   *  conditions. */
  private static readonly NO_SUCH_LANDING =
    'no such workspace to coordinate this project in — workspaceId must name an agent of this ' +
    'account that has not been deleted or disabled';

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
    // Only `coordinator` needs it — the one path that opens a conversation. Defaulted so the specs
    // that construct this service by hand to exercise a read do not each have to stub a session
    // service they never reach; Nest injects the real one by type, not by position.
    private readonly sessions: SessionsService = undefined as unknown as SessionsService,
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

  /** DONE is now the criterion evaluator's projection, never a request field's value. Kept in a
   * helper so later code remains typed over the complete DTO while this runtime boundary refuses
   * the one disallowed member. */
  private static refuseDirectDone(status: ProjectStatus | undefined): void {
    if (status !== ProjectStatus.DONE) return;
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'PROJECT_DONE_AUTOMATIC_ONLY',
      message:
        'project.status DONE is derived automatically when every criterion in the confirmed ' +
        'standard set is PASS; no user, runner, or judgment session may write it directly',
      requiredAction: 'confirm the current standard set and satisfy its declared criteria',
    });
  }

  /** Validate the invariant decorators cannot express across two optional properties. */
  private static assertOneAcceptanceAuthoringShape(dto: {
    acceptanceCriteria?: string | null;
    acceptanceCriteriaItems?: unknown;
  }): void {
    if (dto.acceptanceCriteria !== undefined && dto.acceptanceCriteriaItems !== undefined) {
      throw new BadRequestException(
        'acceptanceCriteria and acceptanceCriteriaItems are alternative authoring shapes; send one',
      );
    }
    if (dto.acceptanceCriteriaItems === null) {
      throw new BadRequestException(
        'acceptanceCriteriaItems must be an array; use [] to clear it or omit it to leave it unchanged',
      );
    }
  }

  /**
   * Unit T6: the acceptance-authoring act on this DTO is routed to owner review and refused for a
   * judgment session. `EDIT_ACCEPTANCE_CRITERIA` covers both authoring shapes, because they write
   * the same fact — gating only the structured one would leave the legacy text as an unguarded way
   * to rewrite the exam. DONE is handled separately as an automatic-only projection for everyone.
   *
   * Both are checked BEFORE the update's own transaction, so a refusal writes nothing. The session
   * is read once and only when the request actually asks for one of them. A no-session request is
   * NON_JUDGMENT by this role contract, so the user API and headless/internal paths keep their
   * existing behavior; that negative classification is not proof a person held the credential.
   */
  private async assertHumanOnlyProjectWrites(
    ownerId: string,
    dto: UpdateProjectDto,
    actingSessionId: string | undefined,
  ): Promise<void> {
    if (!actingSessionId) return;
    if (dto.acceptanceCriteria === undefined && dto.acceptanceCriteriaItems === undefined) return;
    const acting = await this.prisma.session.findFirst({
      where: { id: actingSessionId, ownerId },
      select: { dispatchOrigin: true },
    });
    const principal = authorityPrincipal(acting?.dispatchOrigin);
    const refusal = refuseHumanOnlyAction(principal, 'EDIT_ACCEPTANCE_CRITERIA');
    if (refusal) throw new ForbiddenException(refusal);
  }

  /** Normalize structurally bounded item text and keep the compatibility projection inside the
   * same total size older clients already enforce. This is repeated in the service because runner
   * tests and internal callers invoke it directly without Nest's validation pipe. */
  private static normalizeAcceptanceItems(
    items: Array<{
      text: string;
      verificationMethod: string;
      completionCriterion: TaskCompletionCriterionValue;
      acceptanceCommand?: string | null;
      acceptanceExpectedExitCode?: number | null;
      evidenceTaskId?: string | null;
      completionCriterionOverrideReason?: string | null;
    }>,
  ): Array<{
    text: string;
    verificationMethod: string;
    completionCriterion: TaskCompletionCriterionValue;
    acceptanceCommand: string | null;
    acceptanceExpectedExitCode: number | null;
    evidenceTaskId: string | null;
    completionCriterionOverrideReason: string | null;
  }> {
    if (!Array.isArray(items)) {
      throw new BadRequestException('acceptanceCriteriaItems must be an array');
    }
    if (items.length > MAX_PROJECT_ACCEPTANCE_CRITERIA_ITEMS) {
      throw new BadRequestException(
        `acceptanceCriteriaItems must contain at most ${MAX_PROJECT_ACCEPTANCE_CRITERIA_ITEMS} items`,
      );
    }
    const normalized = items.map((item, index) => {
      const text = typeof item?.text === 'string' ? item.text.trim() : '';
      const verificationMethod = typeof item?.verificationMethod === 'string'
        ? item.verificationMethod.trim()
        : '';
      const completionCriterion = item?.completionCriterion;
      const acceptanceCommand = typeof item?.acceptanceCommand === 'string'
        ? item.acceptanceCommand.trim()
        : null;
      const acceptanceExpectedExitCode = item?.acceptanceExpectedExitCode ?? null;
      const evidenceTaskId = item?.evidenceTaskId ?? null;
      const completionCriterionOverrideReason = normaliseTaskCriterionOverrideReason(
        item?.completionCriterionOverrideReason,
      );
      if (text === '') {
        throw new BadRequestException(`acceptance criterion ${index + 1} must not be blank`);
      }
      if (/[\r\n]/u.test(text)) {
        throw new BadRequestException(
          `acceptance criterion ${index + 1} must be one line during the legacy compatibility window`,
        );
      }
      if (verificationMethod === '') {
        throw new BadRequestException(
          `acceptance criterion ${index + 1} requires a verificationMethod`,
        );
      }
      if (verificationMethod.length > MAX_PROJECT_ACCEPTANCE_VERIFICATION_METHOD_CHARS) {
        throw new BadRequestException(
          `acceptance criterion ${index + 1} verificationMethod must contain at most ${MAX_PROJECT_ACCEPTANCE_VERIFICATION_METHOD_CHARS} characters`,
        );
      }
      if (!TASK_COMPLETION_CRITERIA.includes(completionCriterion)) {
        throw new BadRequestException(
          `acceptance criterion ${index + 1} requires completionCriterion ` +
          `(${TASK_COMPLETION_CRITERIA.join(', ')})`,
        );
      }
      if (
        completionCriterionOverrideReason !== null
        && completionCriterionOverrideReason.length > MAX_TASK_CRITERION_OVERRIDE_REASON_CHARS
      ) {
        throw new BadRequestException(
          `acceptance criterion ${index + 1} completionCriterionOverrideReason must contain at ` +
          `most ${MAX_TASK_CRITERION_OVERRIDE_REASON_CHARS} characters`,
        );
      }
      if (
        acceptanceExpectedExitCode !== null
        && !Number.isInteger(acceptanceExpectedExitCode)
      ) {
        throw new BadRequestException(
          `acceptance criterion ${index + 1} acceptanceExpectedExitCode must be an integer`,
        );
      }
      switch (completionCriterion) {
        case 'EXECUTABLE':
          if (!acceptanceCommand || acceptanceExpectedExitCode === null || !evidenceTaskId) {
            throw new BadRequestException(
              `acceptance criterion ${index + 1}: EXECUTABLE requires acceptanceCommand, ` +
              'acceptanceExpectedExitCode, and evidenceTaskId',
            );
          }
          break;
        case 'VERIFICATION':
          if (acceptanceCommand !== null || acceptanceExpectedExitCode !== null || !evidenceTaskId) {
            throw new BadRequestException(
              `acceptance criterion ${index + 1}: VERIFICATION requires evidenceTaskId and ` +
              'cannot declare an executable command',
            );
          }
          break;
        case 'HUMAN_SIGNOFF':
          if (acceptanceCommand !== null || acceptanceExpectedExitCode !== null || evidenceTaskId) {
            throw new BadRequestException(
              `acceptance criterion ${index + 1}: HUMAN_SIGNOFF cannot declare a command or ` +
              'evidenceTaskId',
            );
          }
          break;
      }
      const advice = taskCriterionShapeAdvice({
        acceptanceCriteria: text,
        completionCriterion,
      });
      if (advice && completionCriterionOverrideReason === null) {
        throw new ConflictException({
          ...taskCriterionShapeAdviceBody(advice),
          criterionOrdinal: index + 1,
        });
      }
      return {
        text,
        verificationMethod,
        completionCriterion,
        acceptanceCommand,
        acceptanceExpectedExitCode,
        evidenceTaskId,
        completionCriterionOverrideReason,
      };
    });
    const projection = criteriaLegacyProjection(normalized) ?? '';
    if (projection.length > MAX_PROJECT_ACCEPTANCE_CRITERIA_CHARS) {
      throw new BadRequestException(
        `structured acceptance criteria must fit the ${MAX_PROJECT_ACCEPTANCE_CRITERIA_CHARS}-character compatibility projection`,
      );
    }
    return normalized;
  }

  /** Apply a whole structured collection while preserving every id the caller retained. Existing
   * ordinals are first moved out of the way so swapping two rows never transiently violates the
   * unique `(project, ordinal)` constraint. */
  private static async replaceAcceptanceDefinitions(
    tx: Prisma.TransactionClient | PrismaService,
    projectId: string,
    items: UpdateProjectAcceptanceCriterionDto[],
  ): Promise<string | null> {
    const normalized = ProjectsService.normalizeAcceptanceItems(items);
    const existing = await tx.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId },
      orderBy: { ordinal: 'asc' },
      select: {
        id: true,
        text: true,
        verificationMethod: true,
        completionCriterion: true,
        acceptanceCommand: true,
        acceptanceExpectedExitCode: true,
        evidenceTaskId: true,
        completionCriterionOverrideReason: true,
        revision: true,
      },
    });
    const byId = new Map(existing.map((criterion) => [criterion.id, criterion]));
    const used = new Set<string>();
    const desired = normalized.map((criterion, index) => {
      const supplied = items[index]?.id;
      let id: string;
      if (supplied === undefined) {
        id = randomUUID();
      } else {
        try {
          id = toUuid(supplied);
        } catch {
          throw new BadRequestException(`acceptance criterion ${index + 1} has an invalid id`);
        }
        if (!byId.has(id)) {
          throw new BadRequestException(
            `acceptance criterion ${index + 1} does not belong to this project's current definitions`,
          );
        }
      }
      if (used.has(id)) {
        throw new BadRequestException(`acceptance criterion id ${supplied ?? id} is repeated`);
      }
      used.add(id);
      let evidenceTaskId: string | null = null;
      if (criterion.evidenceTaskId) {
        try {
          evidenceTaskId = toUuid(criterion.evidenceTaskId);
        } catch {
          throw new BadRequestException(
            `acceptance criterion ${index + 1} has an invalid evidenceTaskId`,
          );
        }
      }
      return { ...criterion, evidenceTaskId, id, ordinal: index + 1 };
    });

    const evidenceIds = [...new Set(desired.flatMap((criterion) =>
      criterion.evidenceTaskId ? [criterion.evidenceTaskId] : []))];
    const evidenceTasks = evidenceIds.length === 0
      ? []
      : await tx.task.findMany({
          where: { projectId, id: { in: evidenceIds } },
          select: {
            id: true,
            completionCriterion: true,
            acceptanceCommand: true,
            acceptanceExpectedExitCode: true,
            verifiesTaskId: true,
          },
        });
    const evidenceById = new Map(evidenceTasks.map((task) => [task.id, task]));
    for (const criterion of desired) {
      if (!criterion.evidenceTaskId) continue;
      const task = evidenceById.get(criterion.evidenceTaskId);
      if (!task) {
        throw new BadRequestException(
          `acceptance criterion ${criterion.ordinal} evidenceTaskId must name a task in this project`,
        );
      }
      if (
        criterion.completionCriterion === 'EXECUTABLE'
        && (
          task.completionCriterion !== 'EXECUTABLE'
          || task.acceptanceCommand !== criterion.acceptanceCommand
          || task.acceptanceExpectedExitCode !== criterion.acceptanceExpectedExitCode
        )
      ) {
        throw new BadRequestException(
          `acceptance criterion ${criterion.ordinal} EXECUTABLE evidenceTaskId must name an ` +
          'EXECUTABLE task with the same command and expected exit code',
        );
      }
      if (criterion.completionCriterion === 'VERIFICATION' && task.verifiesTaskId === null) {
        throw new BadRequestException(
          `acceptance criterion ${criterion.ordinal} VERIFICATION evidenceTaskId must name an ` +
          'independent verifier task',
        );
      }
    }

    if (existing.length > 0) {
      await tx.projectAcceptanceCriterionDefinition.updateMany({
        where: { projectId },
        data: { ordinal: { increment: 1_000_000_000 } },
      });
    }
    await tx.projectAcceptanceCriterionDefinition.deleteMany({
      where: { projectId, ...(used.size > 0 ? { id: { notIn: [...used] } } : {}) },
    });
    for (const criterion of desired) {
      const previous = byId.get(criterion.id);
      const contentHash = sha256(criterion.text);
      if (previous) {
        await tx.projectAcceptanceCriterionDefinition.update({
          where: { id: criterion.id },
          data: {
            ordinal: criterion.ordinal,
            text: criterion.text,
            verificationMethod: criterion.verificationMethod,
            completionCriterion: criterion.completionCriterion,
            acceptanceCommand: criterion.acceptanceCommand,
            acceptanceExpectedExitCode: criterion.acceptanceExpectedExitCode,
            evidenceTaskId: criterion.evidenceTaskId,
            completionCriterionOverrideReason: criterion.completionCriterionOverrideReason,
            contentHash,
            revision:
              previous.text === criterion.text
              && previous.verificationMethod === criterion.verificationMethod
              && previous.completionCriterion === criterion.completionCriterion
              && previous.acceptanceCommand === criterion.acceptanceCommand
              && previous.acceptanceExpectedExitCode === criterion.acceptanceExpectedExitCode
              && previous.evidenceTaskId === criterion.evidenceTaskId
                ? previous.revision
                : previous.revision + 1,
          },
        });
      } else {
        await tx.projectAcceptanceCriterionDefinition.create({
          data: {
            id: criterion.id,
            projectId,
            ordinal: criterion.ordinal,
            text: criterion.text,
            verificationMethod: criterion.verificationMethod,
            completionCriterion: criterion.completionCriterion,
            acceptanceCommand: criterion.acceptanceCommand,
            acceptanceExpectedExitCode: criterion.acceptanceExpectedExitCode,
            evidenceTaskId: criterion.evidenceTaskId,
            completionCriterionOverrideReason: criterion.completionCriterionOverrideReason,
            revision: 1,
            contentHash,
          },
        });
      }
    }
    return criteriaLegacyProjection(desired);
  }

  /**
   * `coordinator` is a SERVER-DERIVED argument, never a field of `CreateProjectDto`: the only
   * caller that passes one is `createInSession`, which resolved it from the session the request
   * came from. Putting it on the DTO would let any caller name any session and any workspace on a
   * project it is creating — which is to say claim a conversation it does not own as this
   * project’s coordinator, and point it into a workspace it was never given.
   */
  async create(
    ownerId: string,
    dto: CreateProjectDto,
    coordinator?: ProjectCoordinatorSeed,
    principal: ProjectCreatePrincipal = { type: 'SYSTEM', id: ownerId },
  ) {
    if (!dto.title) throw new BadRequestException('title is required');
    ProjectsService.assertOneAcceptanceAuthoringShape(dto);
    if (dto.ownerRatification && (principal.type !== 'OWNER' || principal.id !== ownerId)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'OWNER_RATIFICATION_ACTOR_FORBIDDEN',
        message:
          'ownerRatification can only be submitted by the owner in the same authenticated ' +
          'project-create request; an agent or runner cannot self-approve it',
      });
    }
    const structuredCriteria = dto.acceptanceCriteriaItems === undefined
      ? undefined
      : ProjectsService.normalizeAcceptanceItems(dto.acceptanceCriteriaItems);
    try {
      // `await` inside the `try`, not a returned promise: a returned one rejects in the caller,
      // where the catch below cannot see it.
      const writeProject = async (client: PrismaService | Prisma.TransactionClient) => {
        const created = await client.project.create({
          data: {
            title: dto.title,
            ownerId,
            goal: ProjectsService.blankToNull(dto.goal),
            acceptanceCriteria:
              structuredCriteria === undefined
                ? ProjectsService.blankToNull(dto.acceptanceCriteria)
                : criteriaLegacyProjection(structuredCriteria),
            ...(structuredCriteria === undefined
              ? {}
              : { acceptanceCriteriaFormat: 'STRUCTURED' }),
            instructions: ProjectsService.blankToNull(dto.instructions),
            // The defaults for a NEW project, written here rather than left to the column defaults —
            // and they are different values. The columns default to `false` / MANUAL because that is
            // what every project that existed before this feature has to keep; a project created
            // now is one somebody is recording in order to have it coordinated, so it starts
            // coordinated, at the guarded level. Doing it the other way round (new-project values as
            // the column defaults, old rows rewritten by the migration) turns every project created
            // between the migration and this code into an automatic one, and rewrites exactly the
            // rows nobody asked about.
            coordinatorEnabled: dto.coordinatorEnabled ?? true,
            automationPolicy: dto.automationPolicy ?? ProjectAutomationPolicy.GUARDED_AUTO,
            ...(dto.maxConcurrentTasks !== undefined
              ? { maxConcurrentTasks: dto.maxConcurrentTasks }
              : {}),
            ...(dto.sessionBudgetPerDay !== undefined
              ? { sessionBudgetPerDay: dto.sessionBudgetPerDay }
              : {}),
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
              create: coordinator
                ? { coordinatorIdentityLandingId: coordinator.workspaceId }
                : {},
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
          include: {
            ...COORDINATION_INCLUDE,
            acceptanceCriterionDefinitions: ACCEPTANCE_DEFINITIONS_INCLUDE,
          },
        });
        let finalProject = created;

        if (structuredCriteria !== undefined) {
          // The INSERT compatibility trigger first makes rows from the legacy projection so an old
          // binary remains able to create a project. Replace those rows, with the required methods,
          // before this transaction becomes visible; the final projection write also refreshes the
          // existing definition digest. No partially migrated structured project can commit.
          const projection = await ProjectsService.replaceAcceptanceDefinitions(
            client,
            created.id,
            dto.acceptanceCriteriaItems ?? [],
          );
          finalProject = await client.project.update({
            where: { id: created.id },
            data: { acceptanceCriteria: projection, acceptanceCriteriaFormat: 'STRUCTURED' },
            include: {
              ...COORDINATION_INCLUDE,
              acceptanceCriterionDefinitions: ACCEPTANCE_DEFINITIONS_INCLUDE,
            },
          });
        }

        // Explicit only for an atomic decision. Database triggers maintain ordinary creates; an
        // atomic structured create cannot wait for its deferred definition trigger because the
        // owner decision must bind the FINAL digest before this transaction commits.
        let ratification: Record<string, unknown> | null = null;
        if (dto.ownerRatification) {
          await this.acceptance.refreshCompletionContract(client, created.id, 'PROJECT_CREATED');
          ratification = await this.acceptance.ratifyByOwnerInTransaction(
            client,
            ownerId,
            created.id,
            {
              decision: dto.ownerRatification.decision,
              expectedContractDigest: dto.ownerRatification.expectedContractDigest ?? null,
              idempotencyKey: dto.ownerRatification.idempotencyKey,
              atomicCreate: true,
            },
          );
        }
        return { project: finalProject, ratification };
      };
      // Promoting an existing conversation changes two facts that must never split: the Project
      // points at this Session, and this Session's title becomes managed by that Project. Lock/write
      // the Session first (rank 30), then insert the new Project (rank 40). A unique conflict or any
      // other insert failure rolls the title change back with it, so a failed project_create cannot
      // leave the conversation renamed.
      const createdResult = coordinator
        ? await withTransactionRetry(this.prisma, async (tx) => {
            // The Project INSERT below re-checks its owner/workspace foreign keys. Take those
            // exact key-share locks before the Session row, preserving the global 10 → 15 → 30 →
            // 40 order instead of discovering a lower-ranked parent after promotion has started.
            await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              SELECT "id" FROM "user"
               WHERE "id" = ${ownerId}::uuid
               FOR KEY SHARE`);
            const landing = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              SELECT "id" FROM "workspace"
               WHERE "id" = ${coordinator.workspaceId}::uuid
                 AND "owner_id" = ${ownerId}::uuid
                 AND "deleted_at" IS NULL
                 AND "enabled" = TRUE
               FOR SHARE`);
            if (landing.length === 0) {
              throw new ForbiddenException(ProjectsService.NO_SESSION_COORDINATOR);
            }
            const renamed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              UPDATE "session"
                 SET "title_before_project_management" =
                       CASE WHEN "title_managed_by_project"
                            THEN "title_before_project_management"
                            ELSE COALESCE("title_before_project_management", "title") END,
                     "title" = ${coordinatorSessionTitle(dto.title)},
                     "title_managed_by_project" = TRUE,
                     "updated_at" = CURRENT_TIMESTAMP
               WHERE "id" = ${coordinator.sessionId}::uuid
                 AND "owner_id" = ${ownerId}::uuid
                 AND "workspace_id" = ${coordinator.workspaceId}::uuid
                 AND "deleted_at" IS NULL
              RETURNING "id"`);
            // `coordinatorFromSession` already checked this row. Re-check inside the transaction
            // because deletion or relocation between that read and this write must not create a
            // project pointing at context that is no longer usable.
            if (renamed.length === 0) {
              throw new ForbiddenException(ProjectsService.NO_SESSION_COORDINATOR);
            }
            return writeProject(tx);
          }, loggedRetry(this.logger, 'projects.create'))
        : structuredCriteria !== undefined || dto.ownerRatification !== undefined
          ? await withTransactionRetry(
              this.prisma,
              (tx) => writeProject(tx),
              loggedRetry(this.logger, 'projects.create'),
            )
          : await writeProject(this.prisma);
      if (coordinator) this.sessions?.announceProjectSessionChanged?.(coordinator.sessionId);
      const shaped = withAcceptanceDefinitions(withCoordination(createdResult.project));
      return createdResult.ratification
        ? { ...shaped, ownerRatification: createdResult.ratification }
        : shaped;
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
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'ALREADY_COORDINATING',
          message: ProjectsService.ALREADY_COORDINATING,
        });
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
    const project = await this.create(
      ownerId,
      dto,
      await this.coordinatorFromSession(ownerId, runnerId, sessionId),
      { type: 'RUNNER', id: runnerId },
    );
    return {
      // `project_create` runs inside the turn that is being promoted. A prompt attached to a
      // later claim cannot reach backwards into that turn, while rewriting Session.prompt would
      // falsify the conversation's opening and established runtimes would not re-read it anyway.
      // Returning the transition instruction makes it part of this tool result — and therefore
      // the current provider transcript — while runner inbox delivery supplies the same standing
      // context again on later messages, including warm and reclaimed runtimes.
      coordinatorInstructions: buildCoordinatorInstructions(project.title, project.id),
      // Keep the transition first in the serialized tool result. Project payloads can contain long
      // acceptance definitions, and the role change is what the currently-running turn must see.
      ...project,
    };
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
   * The task tally is a count, not an embedded task array. It comes from the same page-wide
   * aggregate that produces the buckets: asking Prisma for `_count.tasks` separately made the
   * database visit the largest project's task index twice merely to return the same population.
   *
   * `_count.tasks` is kept and is no longer the number a reader acts on: it counts DONE and
   * CANCELLED alongside the rest, so it says how big a project is and nothing about where it
   * stands. `buckets` and `lastActivityAt` are that — see `readProjectListRollups`, which
   * produces them for the WHOLE page in one grouped query rather than once per project. Open
   * blockers are folded separately into `attention`: their owner is the durable answer to who
   * must act, and joining them into the task aggregate would multiply both counts.
   */
  list(ownerId: string, status?: ProjectStatus) {
    // A projects page refresh can arrive from several open clients at once. The aggregate is the
    // expensive part, so identical concurrent reads share it; settlement removes the promise and
    // the next request always reads fresh state.
    return this.listSingleFlight.run(`${ownerId}:${status ?? '*'}`, () =>
      this.loadList(ownerId, status));
  }

  private async loadList(ownerId: string, status?: ProjectStatus) {
    const projects = await this.prisma.project.findMany({
      where: { ownerId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      select: PROJECT_LIST_SELECT,
    });
    if (projects.length === 0) return [];
    // Bounded by the page, not by the project: at most one coordinator row and one runtime row
    // apiece, both joined by their own primary/unique key.
    const [rollups, attention, activeObligations] = await Promise.all([
      readProjectListRollups(this.prisma, ownerId, status),
      readProjectListAttention(this.prisma, ownerId, status),
      readCompletionAckObligations(this.prisma, {
        tenantId: ownerId,
        projectIds: projects.map((project) => project.id),
      }),
    ]);
    const obligationsByProject = completionAckObligationsBy(activeObligations, 'projectId');
    return projects.map((project) => {
      // A project with no tasks has no group in the aggregate. It reports a zero total, five zero
      // buckets and no activity rather than making every client handle two shapes.
      const { taskCount, ...rollup } = rollups.get(project.id) ?? emptyProjectListRollup();
      return {
        ...withCoordination(project),
        // Preserve the established wire shape while sourcing the value from the rollup's one
        // task pass. Tenant scope now matches the buckets exactly even if malformed raw data ever
        // points another owner's task at this project.
        _count: { tasks: taskCount },
        ...rollup,
        // The same total shape for a project with no open blockers: clients never have to infer
        // whether an absent field means "none" or "this server did not compute attention".
        attention: attention.get(project.id) ?? emptyProjectListAttention(),
        controlPlaneObligations: obligationsByProject.get(project.id) ?? [],
      };
    });
  }

  /**
   * One project, with how its work is distributed — but not the work itself, for the reason
   * `list` gives above. One grouped query, so the cost is bounded by the number of task statuses
   * rather than by the number of tasks.
   *
   * `acceptance` is the other half of "is this project done". `tasksByStatus` measures the PROCESS
   * and can read 100% while nothing the project was for has been checked; the acceptance tally is
   * the OUTCOME — how many of the stated criteria the latest attempt concluded PASS about, from
   * §13.4's per-criterion rows. It sits beside the current structured definitions and the legacy
   * text projection: definitions are what a person edits, while this is what a frozen run
   * concluded.
   */
  async get(ownerId: string, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, ownerId },
      include: {
        _count: { select: { tasks: true } },
        ...COORDINATION_INCLUDE,
        acceptanceCriterionDefinitions: ACCEPTANCE_DEFINITIONS_INCLUDE,
      },
    });
    if (!project) throw new NotFoundException('project not found');
    const [byStatus, acceptance, controlPlaneObligations] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['status'],
        where: { projectId: id },
        _count: { _all: true },
      }),
      this.acceptance.criteriaSummary(id, project.acceptanceCriteria),
      readCompletionAckObligations(this.prisma, { tenantId: ownerId, projectIds: [id] }),
    ]);
    return withAcceptanceDefinitions({
      ...withCoordination(project),
      tasksByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      acceptance,
      controlPlaneObligations,
    });
  }

  /**
   * Pause one completion-ACK remediation for a typed owner input without transferring ownership
   * of the incident. The runner token supplies tenant + machine identity; the session header is
   * normalized here and PostgreSQL proves that all four identities name the current, non-revoked
   * delivery for the exact ACTIVE obligation revision.
   */
  async requestCompletionAckOwnerDecision(
    ownerId: string,
    projectId: string,
    runnerId: string,
    coordinatorSessionId: string | undefined,
    dto: RequestCompletionAckOwnerDecisionDto,
  ): Promise<Record<string, unknown>> {
    const suppliedSessionId = coordinatorSessionId?.trim();
    if (!suppliedSessionId) {
      throw new ForbiddenException({
        code: 'COMPLETION_ACK_OWNER_DECISION_SESSION_REQUIRED',
        message: 'x-orbit-session-id must name the current completion-ACK coordinator delivery',
      });
    }
    let sessionId: string;
    try {
      sessionId = toUuid(suppliedSessionId);
    } catch {
      throw new BadRequestException({
        code: 'COMPLETION_ACK_OWNER_DECISION_SESSION_INVALID',
        message: 'x-orbit-session-id must be an Orbit session id',
      });
    }
    await this.assertOwned(ownerId, projectId);
    try {
      const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
        SELECT completion_ack_request_owner_decision(
          ${ownerId}::uuid,
          ${projectId}::uuid,
          ${runnerId}::uuid,
          ${sessionId}::uuid,
          ${dto.obligationId},
          ${dto.obligationRevision},
          ${dto.reason},
          ${JSON.stringify(dto.request)}::jsonb
        ) AS result
      `);
      if (!row) throw new Error('COMPLETION_ACK_OWNER_DECISION_RESULT_MISSING');
      return row.result as unknown as Record<string, unknown>;
    } catch (error) {
      ProjectsService.rethrowCompletionAckOwnerDecisionError(error);
    }
  }

  /** Owner/JWT callback for the child request. It resumes the same AGENT-owned coordination; the
   * canonical 0201 obligation remains ACTIVE until the original completion callback commits. */
  async decideCompletionAckOwnerDecision(
    ownerId: string,
    projectId: string,
    requestId: string,
    dto: DecideCompletionAckOwnerDecisionDto,
  ): Promise<Record<string, unknown>> {
    await this.assertOwned(ownerId, projectId);
    try {
      const [row] = await this.prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
        SELECT completion_ack_decide_owner_decision(
          ${ownerId}::uuid,
          ${projectId}::uuid,
          ${requestId}::uuid,
          ${dto.obligationRevision},
          ${dto.idempotencyKey},
          ${JSON.stringify(dto.decision)}::jsonb
        ) AS result
      `);
      if (!row) throw new Error('COMPLETION_ACK_OWNER_DECISION_RESULT_MISSING');
      return row.result as unknown as Record<string, unknown>;
    } catch (error) {
      ProjectsService.rethrowCompletionAckOwnerDecisionError(error);
    }
  }

  private static rethrowCompletionAckOwnerDecisionError(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    const code = [
      'COMPLETION_ACK_OWNER_DECISION_PAYLOAD_INCOMPLETE',
      'COMPLETION_ACK_OWNER_DECISION_PROTOCOL_INVALID',
      'COMPLETION_ACK_OWNER_DECISION_ARGUMENT_INVALID',
      'COMPLETION_ACK_OWNER_DECISION_CALLBACK_INVALID',
    ].find((candidate) => message.includes(candidate));
    if (code) throw new BadRequestException({ code, message: code });
    if (message.includes('COMPLETION_ACK_OWNER_DECISION_CURRENT_DELIVERY_REQUIRED')) {
      throw new ForbiddenException({
        code: 'COMPLETION_ACK_OWNER_DECISION_CURRENT_DELIVERY_REQUIRED',
        message: 'only the exact current non-revoked coordinator delivery session may ask',
      });
    }
    if (message.includes('COMPLETION_ACK_OWNER_DECISION_REQUEST_NOT_FOUND')) {
      throw new NotFoundException({
        code: 'COMPLETION_ACK_OWNER_DECISION_REQUEST_NOT_FOUND',
        message: 'completion-ACK owner decision request not found',
      });
    }
    const conflict = [
      'COMPLETION_ACK_OWNER_DECISION_OBLIGATION_NOT_ACTIVE',
      'COMPLETION_ACK_OWNER_DECISION_IDEMPOTENCY_CONFLICT',
      'COMPLETION_ACK_OWNER_DECISION_ALREADY_OPEN',
      'COMPLETION_ACK_OWNER_DECISION_CALLBACK_CONFLICT',
      'COMPLETION_ACK_OWNER_DECISION_REQUEST_STALE',
    ].find((candidate) => message.includes(candidate));
    if (conflict) throw new ConflictException({ code: conflict, message: conflict });
    throw error;
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

  /**
   * The project's active and manually runnable tasks, plus otherwise-runnable paused candidates.
   *
   * Unlike the blocking leaderboard, this includes runnable leaves with an impact of zero and
   * excludes every task-level static condition the Run action would currently refuse. A task that
   * has just crossed into QUEUED/RUNNING remains beside that ready queue until its work Session
   * ends. A held task is only included when resuming its actual list is the sole remaining Run
   * gate. Keeping this separate preserves the full unfinished ranking consumed by the
   * chain-progress strip while giving the actionable card a stable execution surface.
   */
  async panoramaReady(
    ownerId: string,
    projectId: string,
    query: { limit?: string } = {},
  ): Promise<ProjectReadyToRun> {
    await this.assertOwned(ownerId, projectId);
    const limit = query.limit === undefined ? DEFAULT_BLOCKING_LIMIT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BLOCKING_LIMIT) {
      throw new BadRequestException(`limit must be an integer from 1 to ${MAX_BLOCKING_LIMIT}`);
    }
    // This query deliberately carries the exact Run gate, including the verification-epoch SQL.
    // PostgreSQL's JIT spends ~16s compiling that large expression on the 23k-task production
    // project while the query itself takes under a second. Keep the setting transaction-local so
    // it cannot change another endpoint sharing the pool connection.
    return withTransactionRetry(this.prisma, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL jit = off');
      return readProjectReadyToRun(tx, ownerId, projectId, limit);
    }, loggedRetry(this.logger, 'projects.panoramaReady'));
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
    // One pass over the project's graph for the whole page, never one per row: the level a task
    // sits at is a fact about the graph rather than about the row, so it cannot be answered by
    // selecting more columns of `task`.
    const [dependencies, activeObligations] = await Promise.all([
      this.taskDependencyFields(
        ownerId,
        projectId,
        page.map((task) => task.id),
      ),
      readCompletionAckObligations(this.prisma, {
        tenantId: ownerId,
        projectIds: [projectId],
        taskIds: page.map((task) => task.id),
      }),
    ]);
    const obligationsByTask = completionAckObligationsBy(activeObligations, 'taskId');
    const items = page.map(({ _count, ...task }) => {
      const dependency = dependencies.get(task.id) ?? UNCONNECTED_TASK;
      const controlPlaneObligations = obligationsByTask.get(task.id) ?? [];
      return {
        ...task,
        childCount: _count.children,
        // Never spread-with-fallback into nothing: a row that somehow missed the graph pass still
        // carries all four keys, because an absent key reads to a client as "this endpoint does not
        // report dependencies" rather than as "this task has none".
        ...dependency,
        blocked: dependency.dependencyState !== 'READY' || controlPlaneObligations.length > 0,
        controlPlaneObligations,
      };
    });
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
        SELECT d."task_id" AS "id", COALESCE(p."status"::text, 'FAILED') AS "status"
          FROM "task_dependency" d
          JOIN "scoped" s ON s."id" = d."task_id"
          LEFT JOIN "task" p
            ON p."id" = task_dependency_tail_id(d."depends_on_task_id")
           AND p."owner_id" = ${ownerId}::uuid
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
   * This project's dependency graph, folded to something a canvas can hold.
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
   * ## Marks, not rows
   *
   * What comes back is `marks`: a mark is one task, or a folded run of them, or one stage of a
   * motif that repeats across the project (`project-graph-fold.ts` decides which, and why). This
   * replaced a plain `take: 500` ordered by `created_at`, which was truncation by clock — on the
   * 23,442-task batch project here it drew 500 arbitrary tasks, silently dropped 22,942, and the
   * 500 it drew were 125 disconnected stubs of a pipeline. Folding that same project answers with
   * eight marks that account for every one of its tasks.
   *
   * `truncated` now means only what its name says: the project is larger than one request reads,
   * or its fold is larger than one response carries. Neither has ever been true in this database.
   *
   * ## Live runs
   *
   * Each mark carries `running` / `queued` from the Sessions on its tasks, not just the task's
   * stored status — see `liveTaskState` below for why the column alone cannot say whether a task
   * is being worked on.
   *
   * An edge with one end outside the project is dropped rather than drawn to a stub node: it
   * belongs to another project's plan, and a node this page cannot open is worse than a missing
   * line. What a task waits on across that boundary is what the task page's `dependencyState`
   * already reports.
   */
  async dependencyGraph(ownerId: string, projectId: string) {
    await this.assertOwned(ownerId, projectId);

    // One row past the ceiling, so a project too large to answer for is REPORTED as truncated
    // rather than served short and read as the whole plan.
    const rows = await this.prisma.task.findMany({
      where: { ownerId, projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PROJECT_GRAPH_MAX_TASKS + 1,
      select: { id: true, title: true, status: true, parentTaskId: true },
    });
    const overCeiling = rows.length > PROJECT_GRAPH_MAX_TASKS;
    const rowsInGraph = overCeiling ? rows.slice(0, PROJECT_GRAPH_MAX_TASKS) : rows;
    const liveByTaskId = rowsInGraph.length
      ? await this.liveTaskState(ownerId, projectId)
      : new Map<string, { running: boolean; queued: boolean }>();
    const tasks = rowsInGraph.map((task) => ({ ...task, ...(liveByTaskId.get(task.id) ?? {}) }));

    // Scoped by the two ends' project rather than by a list of task ids: the id list would be as
    // long as the project, and a 23,442-element `IN` is a query plan nobody wants.
    const dependencies = tasks.length
      ? await this.prisma.taskDependency.findMany({
          where: { task: { ownerId, projectId }, dependsOnTask: { ownerId, projectId } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { taskId: true, dependsOnTaskId: true },
        })
      : [];

    const fold = foldProjectGraph(
      tasks,
      // `depends_on_task_id` is the PREREQUISITE and `task_id` is the task waiting on it — the
      // opposite order to how the column names read, and the one thing here that is easy to get
      // backwards. Arrows flow prerequisite -> dependent, so the prerequisite is the source.
      dependencies.map((edge) => ({
        sourceTaskId: edge.dependsOnTaskId,
        targetTaskId: edge.taskId,
      })),
    );

    return {
      marks: fold.marks,
      edges: fold.edges,
      taskCount: fold.taskCount,
      folded: fold.folded,
      truncated: overCeiling || fold.truncated,
      limits: { maxTasks: PROJECT_GRAPH_MAX_TASKS, maxMarks: DEFAULT_FOLD_OPTIONS.maxMarks },
    };
  }

  /**
   * Which of this project's tasks have a run on them right now: `running` = a RUNNING Session,
   * `queued` = a PENDING one with nothing running yet.
   *
   * The graph needs this because `Task.status` does not carry it. Dispatch opens a Session and
   * leaves the row `OPEN` — only `reclaimStalledTask` and a retry ever write `IN_PROGRESS` — so a
   * project graph drawn from the column alone reports the task somebody is watching as untouched,
   * which is exactly the state a reader opens the picture to find.
   *
   * The same two flags, derived the same way, as `TasksService.withRunning`: the task list, the
   * task-rooted graph and this canvas must not describe one running task in three ways. Scoped by
   * the tasks' PROJECT rather than by their ids, for the reason the edge query is — the id list is
   * as long as the project, and a 23,442-element `IN` is a query plan nobody wants.
   */
  private async liveTaskState(
    ownerId: string,
    projectId: string,
  ): Promise<Map<string, { running: boolean; queued: boolean }>> {
    const busy = await this.prisma.session.groupBy({
      by: ['taskId', 'status'],
      where: {
        ownerId,
        status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
        task: { ownerId, projectId },
      },
      _count: { _all: true },
    });
    const running = new Set(
      busy.filter((row) => row.status === RunStatus.RUNNING).map((row) => row.taskId),
    );
    const queued = new Set(
      busy.filter((row) => row.status === RunStatus.PENDING).map((row) => row.taskId),
    );
    const live = new Map<string, { running: boolean; queued: boolean }>();
    for (const taskId of new Set([...running, ...queued])) {
      if (!taskId) continue;
      // A task with both is simply running; `queued` is only meaningful when nothing is running
      // yet. `session_task_execution_claim_idx` makes that pair impossible anyway — this is here
      // so the two flags mean the same thing they mean in `TasksService.withRunning`.
      live.set(taskId, {
        running: running.has(taskId),
        queued: queued.has(taskId) && !running.has(taskId),
      });
    }
    return live;
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

  /** Each field is written only when the caller sent it, so cancelling a project cannot blank the
   * goal that says what it was for, and a rename cannot reopen it. A requested status change alters
   * nothing about the project's tasks; DONE is not a request here at all, but the evaluator's
   * acceptance projection. */
  async update(ownerId: string, id: string, dto: UpdateProjectDto, actingSessionId?: string) {
    const current = await this.prisma.project.findFirst({
      where: { id, ownerId },
      select: { id: true, coordinatorEnabled: true, coordinatorSessionId: true },
    });
    if (!current) throw new NotFoundException('project not found');
    ProjectsService.assertOneAcceptanceAuthoringShape(dto);
    // DONE is a projection for every principal, so this uniform refusal precedes the role-specific
    // criteria-authoring check and cannot vary with an acting Session.
    ProjectsService.refuseDirectDone(dto.status);
    await this.assertHumanOnlyProjectWrites(ownerId, dto, actingSessionId);

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

    // Direct DONE has already been refused. This transaction authors ordinary project facts or a
    // reopen/cancellation; automatic settlement owns its own FOR UPDATE transaction in
    // ProjectAcceptanceService.reconcile.
    // What the reopen below did, for the caller that asked for it. Declared outside the retry
    // closure and overwritten by each attempt, so a retried transaction reports what the attempt
    // that COMMITTED found rather than what an aborted one saw.
    let reopened: { fromEpoch: string; toEpoch: string; retiredRuns: number; wasLegacy: boolean }
      | null = null;
    // A title sync must lock Session (rank 30) before Project (rank 40). The pointer is discovered
    // optimistically, then verified under the project lock; a concurrent rotation makes us retry
    // with its winner rather than reverse the lock order or leave the new coordinator stale.
    let expectedCoordinatorSessionId = current.coordinatorSessionId;
    // Retried whole. The project row is locked and re-read inside the closure, and every field the
    // update derives — the acceptance recompute and managed title — comes from that read, so a
    // re-run writes against the row the winner left rather than an aborted attempt's row.
    const writeProject = (expectedSessionId: string | null) =>
      withTransactionRetry(this.prisma, async (tx) => {
        if (dto.title !== undefined && expectedSessionId) {
          await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "session"
             WHERE "id" = ${expectedSessionId}::uuid
             FOR UPDATE`);
        }
        // This project lock is the lock a coordinator has to take before committing anything the
        // fields above authorize. Taking it here is what makes "the user revoked it"
        // and "the coordinator acted on what it read" two orderings rather than an interleaving:
        // whichever commits first, the other sees it. It also fixes the order of the two writes
        // below (project before its team row), which is the order every path takes.
        const select = Prisma.sql`
          SELECT "coordinator_enabled", "config_revision", "status"::text AS "status",
                 "coordinator_session_id" AS "coordinator_session_id",
                 "accepted_run_id" AS "accepted_run_id", "legacy_accepted_at" AS "legacy_accepted_at",
                 "acceptance_epoch" AS "acceptance_epoch"
            FROM "project"
           WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid`;
        const [locked] = await tx.$queryRaw<Array<{
          coordinator_enabled: boolean;
          config_revision: bigint;
          status: string;
          coordinator_session_id: string | null;
          accepted_run_id: string | null;
          legacy_accepted_at: Date | null;
          acceptance_epoch: bigint;
        }>>(Prisma.sql`${select} FOR NO KEY UPDATE`);
        if (!locked) throw new NotFoundException('project not found');
        if (
          dto.title !== undefined &&
          locked.coordinator_session_id !== expectedSessionId
        ) {
          throw new CoordinatorBindingChanged();
        }
        // Under the lock, so the comparison and the write cannot be separated by another writer.
        // Throwing here rolls the transaction back, which is the whole guarantee a stale write
        // needs: refused AND nothing written, including the team row below.
        ProjectsService.assertConfigRevision(dto.expectedConfigRevision, locked.config_revision);
        // The value the lock produced, not the one read before it: a concurrent write that turned
        // this project off is exactly the case the check has to see.
        ProjectsService.assertLevelNamedWhenTurningOn(locked.coordinator_enabled, dto);

        // Definitions and their compatibility projection change under the already-held project
        // lock. The evaluator can only settle in its own later FOR UPDATE transaction, against the
        // resulting digest and a confirmation naming that exact standard set.
        if (dto.acceptanceCriteriaItems !== undefined) {
          const projection = await ProjectsService.replaceAcceptanceDefinitions(
            tx, id, dto.acceptanceCriteriaItems,
          );
          await tx.project.update({
            where: { id },
            data: {
              acceptanceCriteria: projection,
              acceptanceCriteriaFormat: 'STRUCTURED',
            },
          });
        } else if (dto.acceptanceCriteria !== undefined) {
          await tx.project.update({
            where: { id },
            data: {
              acceptanceCriteria: ProjectsService.blankToNull(dto.acceptanceCriteria),
              acceptanceCriteriaFormat: 'LEGACY_TEXT',
            },
          });
        }
        if (dto.acceptanceCriteriaItems !== undefined || dto.acceptanceCriteria !== undefined) {
          await this.acceptance.ensureCurrentEvidenceVersion(tx, id);
        }

        // A criteria fact edit can atomically reopen a DONE through the database trigger. Re-read
        // that committed-within-this-transaction state so the explicit status branches below do
        // not also retire/audit the same run as a user reopen, and so a simultaneous DONE is gated
        // from OPEN against the new definitions rather than treated as an idempotent old DONE.
        const state = dto.acceptanceCriteriaItems !== undefined || dto.acceptanceCriteria !== undefined
          ? await tx.project.findUniqueOrThrow({
              where: { id },
              select: {
                status: true,
                acceptedRunId: true,
                legacyAcceptedAt: true,
                acceptanceEpoch: true,
              },
            })
          : {
              status: locked.status as ProjectStatus,
              acceptedRunId: locked.accepted_run_id,
              legacyAcceptedAt: locked.legacy_accepted_at,
              acceptanceEpoch: locked.acceptance_epoch,
            };

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
        if (dto.status === ProjectStatus.OPEN && state.status !== ProjectStatus.OPEN) {
          const impact = reopenImpact({
            status: state.status as 'DONE' | 'CANCELLED' | 'OPEN',
            acceptanceEpoch: String(state.acceptanceEpoch),
            liveAcceptanceRuns: 0,
            legacyAccepted: state.legacyAcceptedAt !== null,
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
        // reopen on its own changes none of the acceptance projections. So this is the one invalidation
        // that has to be written rather than derived.
        if (dto.status === ProjectStatus.OPEN && state.status === ProjectStatus.DONE) {
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
            { previousAcceptedRunId: state.acceptedRunId, wasLegacy: state.legacyAcceptedAt !== null },
            state.acceptedRunId,
          );
        }

        if (agentId !== undefined) {
          await ProjectsService.writeCoordinatorAgent(tx, ownerId, id, agentId);
        }
        const project = await tx.project.update({
          where: { id },
          data,
          include: {
            ...COORDINATION_INCLUDE,
            acceptanceCriterionDefinitions: ACCEPTANCE_DEFINITIONS_INCLUDE,
          },
        });
        let changedSessionId: string | null = null;
        if (dto.title !== undefined && locked.coordinator_session_id) {
          await tx.session.updateMany({
            where: {
              id: locked.coordinator_session_id,
              ownerId,
              titleManagedByProject: true,
            },
            data: { title: coordinatorSessionTitle(dto.title) },
          });
          // Even an unmanaged coordinator did visibly change: its projected `projectTitle` did.
          // Publish after commit so list/detail clients refresh the backlink as well as the title.
          changedSessionId = locked.coordinator_session_id;
        }
        return { project, changedSessionId };
      }, loggedRetry(this.logger, 'projects.update'));
    try {
      let projectResult: {
        project: ProjectMutationPayload;
        changedSessionId: string | null;
      } | null = null;
      for (let bindingAttempt = 1; bindingAttempt <= 4; bindingAttempt += 1) {
        try {
          projectResult = await writeProject(expectedCoordinatorSessionId);
          break;
        } catch (e) {
          if (!(e instanceof CoordinatorBindingChanged)) throw e;
          if (bindingAttempt === 4) {
            throw new ConflictException(
              'this project’s coordinator kept changing while its title was updated — try again',
            );
          }
          const refreshed = await this.prisma.project.findFirst({
            where: { id, ownerId },
            select: { coordinatorSessionId: true },
          });
          if (!refreshed) throw new NotFoundException('project not found');
          expectedCoordinatorSessionId = refreshed.coordinatorSessionId;
        }
      }
      if (!projectResult) throw new CoordinatorBindingChanged();
      const { project, changedSessionId } = projectResult;
      if (changedSessionId) this.sessions?.announceProjectSessionChanged?.(changedSessionId);
      // `reopened` is absent — not null — on every write that did not reopen anything, so a client
      // branching on it cannot read "this write reopened nothing" as "this write reopened
      // something with no detail".
      const shaped = withAcceptanceDefinitions(withCoordination(project));
      return reopened ? { ...shaped, reopened } : shaped;
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
    let releasedCoordinatorSessionId: string | null = null;
    try {
      // Retried whole: a delete re-reads what it is deleting under the row lock, and deleting
      // something already gone is the same answer on any attempt.
      await withTransactionRetry(this.prisma, async (tx) => {
        const locked = await tx.$queryRaw<Array<{
          id: string;
          coordinator_session_id: string | null;
        }>>`
          SELECT id, "coordinator_session_id" FROM "project"
          WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
          FOR UPDATE`;
        if (locked.length === 0) throw new NotFoundException('project not found');
        releasedCoordinatorSessionId = locked[0].coordinator_session_id;
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
    if (releasedCoordinatorSessionId) {
      // The Project is already durably gone. Provenance cleanup is best effort: surfacing its
      // failure would tell the caller DELETE failed even though retrying can now only return 404.
      try {
        await this.sessions?.releaseProjectTitleManagement?.(ownerId, releasedCoordinatorSessionId);
      } catch (e) {
        this.logger.error(
          `project ${id} was deleted but coordinator session ${releasedCoordinatorSessionId} ` +
            'kept its internal managed-title marker',
          e instanceof Error ? e.stack : String(e),
        );
      }
      // The relation itself is list-visible even if the internal cleanup failed.
      this.sessions?.announceProjectSessionChanged?.(releasedCoordinatorSessionId);
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
        // §9.2's policy is part of what a coordination run is opened WITH (v1.18, `PC-CX-65`):
        // the opening tells the coordinator what the control loop does on its own, and that
        // sentence is different under each of the three.
        automationPolicy: true,
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
          title: coordinatorSessionTitle(project.title),
          prompt: buildCoordinatorOpening(project.title, project.id),
        },
        { source: 'user', titleManagedByProject: true },
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
    // The pointer replacement remains one statement inside the transaction below: only a
    // REPLACEMENT counts, and the trigger's condition is the same one this code applied — a first
    // coordinator is generation 0, "the coordinator this project has always had".
    let claimed: { count: number };
    try {
      claimed = await withTransactionRetry(this.prisma, async (tx) => {
        // Updating the Project pointer re-checks its workspace FK. Hold the landing before any
        // Session (rank 15 → 30), and at FOR SHARE so a concurrent soft-delete/disable cannot turn
        // the freshly bound coordinator unavailable between validation and commit.
        const landing = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "workspace"
           WHERE "id" = ${runIn}::uuid AND "owner_id" = ${ownerId}::uuid
             AND "deleted_at" IS NULL AND "enabled" = TRUE
           FOR SHARE`);
        if (landing.length === 0) {
          throw ProjectsService.coordinatorUnavailable(
            'the coordinator workspace changed while its conversation was being opened',
          );
        }
        // Candidate and previous Session rows first (rank 30), in stable UUID order so two
        // simultaneous rotations cannot each hold one and wait for the other. The expensive
        // session creation happened before this transaction; these locks cover only the CAS.
        const sessionIds = [...new Set(
          [project.coordinatorSessionId, session.id].filter((value): value is string => !!value),
        )].sort();
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "session"
           WHERE "id" IN (${Prisma.join(sessionIds.map((value) => Prisma.sql`${value}::uuid`))})
           ORDER BY "id"
           FOR UPDATE`);

        // Then Project (rank 40). Re-read both pointer and title under this lock: the pointer is
        // the CAS identity, while the title may have changed since the candidate Session was
        // created. A winning bind therefore starts with the latest committed project name.
        const [locked] = await tx.$queryRaw<Array<{
          coordinator_session_id: string | null;
          title: string;
        }>>(Prisma.sql`
          SELECT "coordinator_session_id", "title"
            FROM "project"
           WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR NO KEY UPDATE`);
        if (!locked || locked.coordinator_session_id !== project.coordinatorSessionId) {
          return { count: 0 };
        }

        const swapped = await tx.project.updateMany({
          where: { id, ownerId, coordinatorSessionId: project.coordinatorSessionId },
          data: { coordinatorSessionId: session.id, coordinatorWorkspaceId: runIn },
        });
        if (swapped.count === 0) return swapped;

        // A manual rename can race in the tiny create-before-bind window. It clears the managed
        // bit, so this conditional write honors that choice while still binding the conversation.
        await tx.session.updateMany({
          where: { id: session.id, ownerId, titleManagedByProject: true },
          data: { title: coordinatorSessionTitle(locked.title) },
        });
        if (project.coordinatorSessionId && project.coordinatorSessionId !== session.id) {
          await tx.session.updateMany({
            where: { id: project.coordinatorSessionId, titleManagedByProject: true },
            data: { titleManagedByProject: false },
          });
        }
        return swapped;
      }, loggedRetry(this.logger, 'projects.coordinator'));
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
    if (project.coordinatorSessionId && project.coordinatorSessionId !== session.id) {
      this.sessions?.announceProjectSessionChanged?.(project.coordinatorSessionId);
    }
    this.sessions?.announceProjectSessionChanged?.(session.id);
    return { sessionId: session.id, created: true, workspaceId: runIn };
  }

  /**
   * Move where this project's coordinator opens — the endpoint `coordinator` says is not it.
   *
   * §7.5 freezes a rotation as "the SESSION is replaced; the agent and the workspace are not", and
   * every automatic path is held to it: `coordinator` refuses a different workspace with
   * `ELSEWHERE`, and `coordinatorLanding` turns a landing that has gone dead into
   * `COORDINATOR_UNAVAILABLE` rather than quietly borrowing another. Both of those name the same
   * addressee — the owner — and until this door existed there was nothing for them to open:
   * `REBIND_REQUIRED_ACTION` was an instruction with no verb behind it, and the card's only
   * affordance was a Retry that returned the same 409 forever.
   *
   * This is an owner's explicit decision, which is why it is a route of its own rather than a field
   * on `PATCH :id`: moving a coordinator is not something that should be reachable by a request
   * that meant to rename something. It is the rule's exit, not a hole in it — `coordinator` still
   * refuses to move one as a side effect of being asked for one.
   *
   * WHAT IT WRITES is `coordinator_workspace_id`, and nothing else.
   *
   *   * not `coordinator_session_id`: pointing a project at a different conversation is a ROTATION,
   *     which is the thing §7.5 froze. See the refusal below for what that costs;
   *   * not the coordinator identity — the `project_member` COORDINATOR row is WHO coordinates, and
   *     PAC R3 forbids deriving either of those from the other. An owner who means to move both
   *     sends `coordinatorAgentId` to `PATCH :id` as well, and gets to see it was two decisions;
   *   * not `coordinator_generation`: `project_coordinator_rotation_count` (migration 0112) counts
   *     one session pointer swapped for a different one, so a write that touches no pointer spends
   *     no generation. Nothing here has to arrange that — it follows from writing one column.
   *
   * The one write this DOES have a consequence for is the identity of a project that has none:
   * `project_coordinator_companions_bind` fires on NULL → set and seats a COORDINATOR membership
   * from the new landing when the project has no coordinator row at all. That is the database's own
   * invariant ("a project that names a coordination workspace HAS a coordinator"), it only ever
   * FILLS what nobody wrote, and it is left alone here for the same reason `create` leaves it alone.
   *
   * Not part of the authorization set, for `coordinatorAgentId`'s reason: it says where the next
   * coordinator opens, not what a coordinator may do. So it bumps no `configRevision`, and a
   * revision read before it is still the revision an authorization edit was composed against.
   */
  async rebindCoordinator(
    ownerId: string,
    id: string,
    workspaceId: string,
  ): Promise<{
    projectId: string;
    coordinatorWorkspaceId: string;
    /** Untouched by this call, and served so that "untouched" is visible rather than promised. */
    coordinatorSessionId: string | null;
    /** False when the project already recorded this landing — a replay writes nothing. */
    moved: boolean;
  }> {
    return withTransactionRetry(this.prisma, async (tx) => {
      // The landing FIRST, and that order is `lock-order.ts` rather than preference: `workspace` is
      // rank 15 and `project` is rank 40, so reading the project before the workspace would lock
      // upward — the exact shape rank 15 exists to keep out of these paths. Nothing here needs the
      // project row in order to know which landing was named, so the ranks and the data agree. The
      // visible consequence is that a caller who owns neither is answered about the landing rather
      // than about the project; neither refusal confirms the other's row exists, so nothing leaks.
      //
      // `FOR SHARE` because a workspace is SOFT-deleted and disabling one is an ordinary UPDATE of
      // a non-key column: the foreign key this row is about to be referenced by takes FOR KEY
      // SHARE, which neither of those conflicts with, so without this lock the check and the write
      // straddle them and the project commits pointing at a landing that just went dead.
      //
      // The four conditions are `lastCoordinatorWorkspace`'s, exactly — unknown, another owner's,
      // trashed, disabled — so the read side of "can this project's coordinator open where it
      // belongs" and the write side of "may it belong here" cannot come to disagree. Deliberately
      // NOT `runner_id IS NOT NULL`: an unbound workspace is refused by `sessions.create` rather
      // than by the column, it is a landing whose owner can bind a runner to it without moving
      // anything, and `NO_SUCH_LANDING` does not claim to have checked it.
      const [target] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "workspace"
         WHERE "id" = ${workspaceId}::uuid AND "owner_id" = ${ownerId}::uuid
           AND "deleted_at" IS NULL AND "enabled" = TRUE
         FOR SHARE`);
      if (!target) throw new BadRequestException(ProjectsService.NO_SUCH_LANDING);

      // Then the project under its own lock. This reads a pointer that `coordinator`'s
      // compare-and-swap also writes, and what it read has to still be true at the commit that
      // moves the landing out from under it. `FOR NO KEY UPDATE` rather than `FOR UPDATE` — this
      // settles nothing about acceptance, and §8.6 LO3 forbids starting weak and upgrading, so the
      // strength is chosen here.
      const [locked] = await tx.$queryRaw<Array<{
        coordinator_workspace_id: string | null;
        coordinator_session_id: string | null;
      }>>(Prisma.sql`
        SELECT "coordinator_workspace_id", "coordinator_session_id"
          FROM "project"
         WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
         FOR NO KEY UPDATE`);
      if (!locked) throw new NotFoundException('project not found');

      // Already there, answered as a no-op and answered BEFORE the pointer check below: a client
      // retrying a request whose response it never saw must not be told its own rebind was refused,
      // and a call that moves nothing has no reason to care what the conversation it is leaving
      // alone happens to be doing.
      if (locked.coordinator_workspace_id === target.id) {
        return {
          projectId: id,
          coordinatorWorkspaceId: target.id,
          coordinatorSessionId: locked.coordinator_session_id,
          moved: false,
        };
      }

      // The pair, which is what `project_coordinator_pointer_guard` (migration 0126, deliberately
      // KEPT by 0164) rules on: a project may not name a coordination workspace AND a coordinator
      // session that does not run in it. The guard is a BEFORE trigger over both columns, so a
      // landing that moves away from a standing pointer is not a row this database will hold — it
      // raises COORDINATOR_POINTER_RELOCATED, which would reach the caller as a 500 about nothing
      // they can act on.
      //
      // So the pointer is CHECKED here rather than cleared. Clearing it is the other way to satisfy
      // the guard and it is a rotation by another name: `coordinator` would then open a second
      // conversation about work that has already been discussed in one, which is the defect the
      // whole binding exists to prevent. Told instead, the owner decides — the conversation is
      // theirs to end and delete, and this endpoint is not allowed to do it on their behalf.
      //
      // Read without a lock: `session` is rank 30 and the project row is already held at 40, so
      // locking one here would be locking upward. It does not need one — the guard re-reads the
      // same row inside the UPDATE below, so a session that moves under us fails the write rather
      // than passing this check, and the failure is the same refusal arriving from the database.
      if (locked.coordinator_session_id != null) {
        const [bound] = await tx.$queryRaw<Array<{ workspace_id: string | null }>>(Prisma.sql`
          SELECT "workspace_id" FROM "session" WHERE "id" = ${locked.coordinator_session_id}::uuid`);
        if (bound?.workspace_id !== target.id) throw ProjectsService.coordinatorSessionLive();
      }

      // One column, one statement. `updateMany` rather than `update` so the owner predicate travels
      // with the WRITE as well as with the read above: this is a write, and a write that carries
      // its own tenant scope stays correct if the read is ever moved, cached or refactored.
      await tx.project.updateMany({
        where: { id, ownerId },
        data: { coordinatorWorkspaceId: target.id },
      });

      return {
        projectId: id,
        coordinatorWorkspaceId: target.id,
        coordinatorSessionId: locked.coordinator_session_id,
        moved: true,
      };
    }, loggedRetry(this.logger, 'projects.rebindCoordinator'));
  }

  /**
   * What this project's coordination IS, and what pressing "open the coordinator" would do.
   *
   * A read, and only a read: it takes no lock, opens nothing and writes nothing. The card it feeds
   * has to know whether a coordinator exists, whether the conversation is alive, whether it is in
   * Trash and whether the button would refuse — all four BEFORE the press, which is what the POST
   * alone can never say.
   *
   * `openability` is therefore a projection of the branches `coordinator` and `coordinatorLanding`
   * would take rather than a second set of rules, so a card built on this and the button behind it
   * cannot come to describe one project two ways. It is a prediction from committed rows and the
   * POST is what decides: it cannot see a workspace disabled BETWEEN this read and the press, and
   * it does not model refusals that are not about the landing (a provider that is not configured).
   * A client still handles a 409 or a 400 — this exists so the common cases are visible before the
   * press, not so the press becomes infallible.
   *
   * Every absent fact is `null` beside a closed-set reason rather than dropped. `ELSEWHERE` is
   * deliberately not modelled: it is a property of the request body, and this endpoint takes none.
   */
  async coordinatorStatus(ownerId: string, projectId: string): Promise<ProjectCoordinatorStatus> {
    const readAt = new Date();
    const project = await this.prisma.project.findFirst({
      // The same 404 every other project read gives an id belonging to somebody else, decided by
      // this query's own owner predicate rather than by a second lookup — so there is no window in
      // which the row is checked and then read.
      where: { id: projectId, ownerId },
      select: {
        id: true,
        coordinatorSessionId: true,
        coordinatorWorkspaceId: true,
        coordinatorSession: { select: COORDINATOR_STATUS_SESSION_SELECT },
        // Not re-scoped to `ownerId`: the column is only ever written to a workspace this owner
        // already owns (`createProjectInSession`, and the swap in `coordinator` behind
        // `lastCoordinatorWorkspace` / `busiestAssignee`), and it is reached here through a project
        // this query has already proved is theirs.
        coordinatorWorkspace: {
          select: { name: true, deletedAt: true, enabled: true, runnerId: true },
        },
        members: {
          where: { role: ProjectRole.COORDINATOR },
          select: { agentId: true, agent: { select: { name: true } } },
        },
        runtime: { select: { coordinatorGeneration: true } },
      },
    });
    if (!project) throw new NotFoundException('project not found');

    const session = project.coordinatorSession;
    const workspace = project.coordinatorWorkspace;
    // The same fold every other project payload takes, so "generation 0" cannot come to mean two
    // things. The agent's NAME is read off the membership row before the fold drops it.
    const { coordinatorAgentId, coordinatorGeneration } = withCoordination(project);
    const agentName = project.members[0]?.agent.name ?? null;
    const agentAbsentReason = coordinatorAgentId == null ? ('NO_COORDINATOR_AGENT' as const) : null;

    // Which of the recorded landing's columns refuses, if any — read ONCE, because `state` and
    // `openability.refusalDetail` are the same fact seen from two sides and must not be able to
    // drift apart. The first two conditions are `lastCoordinatorWorkspace`'s own filter; the third
    // is `sessions.create` refusing an unbound workspace, which `coordinator` translates on the
    // fixed branch — it is here so this read can say WHICH refusal rather than merely that there
    // is one. Evaluated in the order `coordinatorLanding` reaches them.
    const landingRefusal: CoordinatorRefusalDetail =
      workspace == null
        ? null
        : workspace.deletedAt != null
          ? 'WORKSPACE_TRASHED'
          : !workspace.enabled
            ? 'WORKSPACE_DISABLED'
            : workspace.runnerId == null
              ? 'WORKSPACE_UNBOUND'
              : null;
    const landingUsable = workspace != null && landingRefusal == null;

    // The four states, in the order the truth table decides them.
    let state: ProjectCoordinationState;
    if (session != null && session.deletedAt == null) state = 'LIVE';
    else if (project.coordinatorWorkspaceId != null) {
      state = landingUsable ? 'TRASHED' : 'UNAVAILABLE';
    } else if (project.coordinatorSessionId != null) state = 'UNAVAILABLE';
    else state = 'NEVER_OPENED';

    // Told apart by the WORKSPACE, not by the generation: both columns are written in the same
    // statement whenever a coordinator is bound, so a FIRST coordinator that was purged still sits
    // at generation 0. The generation is the fallback for the one case where the workspace was
    // hard-deleted too.
    const sessionAbsentReason: CoordinatorSessionAbsentReason =
      project.coordinatorSessionId != null
        ? null
        : project.coordinatorWorkspaceId != null || coordinatorGeneration > 0n
          ? 'COORDINATOR_SESSION_PURGED'
          : 'COORDINATOR_NEVER_OPENED';

    // The mirror image. Only a workspace HARD delete empties this pointer (the FK's SET NULL); a
    // soft delete leaves it standing, which is why a trashed workspace is still POINTED AT here.
    const workspaceAbsentReason: CoordinationWorkspaceAbsentReason =
      project.coordinatorWorkspaceId != null
        ? null
        : project.coordinatorSessionId != null || coordinatorGeneration > 0n
          ? 'COORDINATION_WORKSPACE_PURGED'
          : 'NO_COORDINATION_WORKSPACE';
    // The id survives a soft delete because it is what the owner needs in order to restore it; the
    // name does not, so nothing can print a workspace that is in Trash as though it were there.
    const workspaceNameAbsentReason =
      workspace == null
        ? workspaceAbsentReason
        : workspace.deletedAt != null
          ? ('COORDINATION_WORKSPACE_TRASHED' as const)
          : null;

    // Only a generating session can be holding a live approval, and the count is gated exactly the
    // way the session list gates it — including a self-driven turn, which stays at AWAITING_INPUT
    // while it runs and whose prompt is no less blocking for it.
    const pendingApprovals =
      session != null && isSessionGenerating(session)
        ? await this.prisma.approval.count({ where: { sessionId: session.id, status: 'PENDING' } })
        : 0;

    // What the POST would do if pressed right now, branch for branch.
    let refusalCode: ProjectCoordinatorStatus['openability']['refusalCode'] = null;
    let refusalDetail: CoordinatorRefusalDetail = null;
    let landingWorkspaceId: string | null = null;
    let landingWorkspaceName: string | null = null;
    if (state === 'LIVE') {
      // Nothing to predict: the reuse branch hands the bound session back and never reaches the
      // landing, which is why a live coordinator in a workspace that was disabled underneath it
      // still opens.
    } else if (workspace != null) {
      if (landingRefusal != null) {
        refusalCode = COORDINATOR_UNAVAILABLE_CODE;
        refusalDetail = landingRefusal;
      } else {
        landingWorkspaceId = project.coordinatorWorkspaceId;
        landingWorkspaceName = workspace.name;
      }
    } else if (project.coordinatorSessionId != null) {
      // It had a coordinator and no longer records where it ran. Picking a new home for it is
      // precisely what §7.5 forbids, so there is nothing to offer.
      refusalCode = COORDINATOR_UNAVAILABLE_CODE;
      refusalDetail = 'WORKSPACE_FORGOTTEN';
    } else {
      // The free branch: only a project that has never had one gets to choose, and what it chooses
      // is where this project's work already runs.
      const borrowed = await this.busiestAssignee(project.id);
      const home =
        borrowed == null
          ? null
          : await this.prisma.workspace.findUnique({
              where: { id: borrowed },
              select: { id: true, name: true },
            });
      if (home == null) {
        refusalCode = NO_LANDING_WORKSPACE_CODE;
        refusalDetail = 'NO_TASK_ASSIGNEE';
      } else {
        landingWorkspaceId = home.id;
        landingWorkspaceName = home.name;
      }
    }
    const landingAbsentReason: LandingAbsentReason =
      landingWorkspaceId != null ? null : state === 'LIVE' ? 'COORDINATOR_ALREADY_LIVE' : 'LANDING_REFUSED';
    // One wording per refusal, taken from the throw itself rather than restated — two phrasings
    // would read as two different rules to anyone who hit both the button and this card.
    const requiredAction =
      refusalCode == null
        ? null
        : refusalCode === COORDINATOR_UNAVAILABLE_CODE
          ? ProjectsService.REBIND_REQUIRED_ACTION
          : ProjectsService.NO_LANDING_WORKSPACE;
    const nothingRefuses = refusalCode == null ? ('NOTHING_REFUSES' as const) : null;

    return {
      projectId: project.id,
      readAt,
      state,
      coordination: {
        sessionId: project.coordinatorSessionId,
        sessionIdAbsentReason: sessionAbsentReason,
        session: session == null ? null : ProjectsService.coordinatorSessionState(session, pendingApprovals),
        sessionAbsentReason,
        coordinatorGeneration,
        // All four of these names are emitted even when null. `WorkspaceAliasInterceptor` only ever
        // ADDS the missing half of a workspace/agent pair, so a `workspaceId` served without an
        // `agentId` beside it comes back with `agentId` silently set to the WORKSPACE's id — and an
        // explicit null is what suppresses that.
        workspaceId: project.coordinatorWorkspaceId,
        workspaceIdAbsentReason: workspaceAbsentReason,
        workspaceName: workspaceNameAbsentReason == null && workspace != null ? workspace.name : null,
        workspaceNameAbsentReason,
        agentId: coordinatorAgentId,
        agentIdAbsentReason: agentAbsentReason,
        agentName,
        agentNameAbsentReason: agentAbsentReason,
      },
      openability: {
        canOpen: refusalCode == null,
        // False only on the reuse branch. Everywhere else the press makes a new conversation —
        // whether it would be allowed to is `canOpen`, which is a different question.
        willCreate: state !== 'LIVE',
        refusalCode,
        refusalDetail,
        refusalCodeAbsentReason: nothingRefuses,
        requiredAction,
        requiredActionAbsentReason: nothingRefuses,
        landing: {
          workspaceId: landingWorkspaceId,
          workspaceIdAbsentReason: landingAbsentReason,
          workspaceName: landingWorkspaceName,
          workspaceNameAbsentReason: landingAbsentReason,
          // Constant null, for the reason the four above are always emitted: a landing is a place,
          // not an identity, and the alias mirror would otherwise invent one.
          agentId: null,
          agentName: null,
          fixed: project.coordinatorWorkspaceId != null,
        },
      },
    };
  }

  /** The coordinator conversation's run and lifecycle state, derived the one way every other
   *  Session payload derives it — a second mapping here is a second answer to "is it finished". */
  private static coordinatorSessionState(
    session: CoordinatorStatusSessionRow,
    pendingApprovals: number,
  ): NonNullable<ProjectCoordinatorStatus['coordination']['session']> {
    const derived = withSessionState(session);
    return {
      id: session.id,
      title: session.title,
      runStatus: derived.runStatus,
      runState: derived.runState,
      lifecycleState: derived.lifecycleState,
      filingState: derived.filingState,
      endReason: session.endReason,
      endReasonAbsentReason: session.endReason == null ? 'SESSION_NOT_ENDED' : null,
      startedAt: session.startedAt,
      startedAtAbsentReason: session.startedAt == null ? 'SESSION_NEVER_STARTED' : null,
      finishedAt: session.finishedAt,
      finishedAtAbsentReason: session.finishedAt == null ? 'SESSION_STILL_RUNNING' : null,
      // The canonical fold of the legacy `archivedAt` mirror, not a second reading of it.
      completedAt: derived.completedAt,
      completedAtAbsentReason: derived.completedAt == null ? 'SESSION_NOT_COMPLETED' : null,
      deletedAt: session.deletedAt,
      deletedAtAbsentReason: session.deletedAt == null ? 'SESSION_NOT_TRASHED' : null,
      engineTurnActive: session.engineTurnActive,
      pendingApprovals,
    };
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
      throw new BadRequestException(ProjectsService.NO_LANDING_WORKSPACE);
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
      requiredAction: ProjectsService.REBIND_REQUIRED_ACTION,
    });
  }

  /**
   * The other refusal a rebind can give: "this project is still bound to a conversation, and it
   * does not run where you are moving the project to".
   *
   * `project_coordinator_pointer_guard` (0126) is what makes this a refusal rather than a policy:
   * a project may not name a coordination workspace and a coordinator session that runs somewhere
   * else, so moving the landing away from a standing pointer is a row the database will not hold.
   * The endpoint says so in words the owner can act on instead of letting a plpgsql exception
   * arrive as a 500 about `COORDINATOR_POINTER_RELOCATED`.
   *
   * `COORDINATOR_SESSION_LIVE` covers a pointer into Trash as well as one into a running turn,
   * because the two are one situation to the guard and to the caller: the pointer STANDS, and what
   * frees the project is the same act either way. The required action says both halves of it — a
   * soft delete leaves the pointer exactly where it was, and only the permanent delete empties it
   * (the FK is SET NULL).
   *
   * Structured for `coordinatorUnavailable`'s reason, and `owner: USER` for the same one: nothing
   * the server retries changes it. It carries no ids, because error bodies are the one response
   * `PublicIdInterceptor` does not rewrite and a uuid put in here would go out raw.
   */
  private static coordinatorSessionLive(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: COORDINATOR_SESSION_LIVE_CODE,
      message:
        'this project is still bound to a coordinator conversation, and that conversation does ' +
        'not run in the workspace you are moving it to — a project cannot name one place and be ' +
        'coordinated from another',
      owner: 'USER',
      requiredAction:
        'delete this project’s coordinator conversation — Trash it, then delete it permanently, ' +
        'which is what empties the pointer — and then rebind its coordination workspace',
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
    if (this.sessions.discardProjectCoordinatorCandidate) {
      const discarded = await this.sessions.discardProjectCoordinatorCandidate(ownerId, sessionId);
      if (!discarded) {
        // An ambiguous commit can make the candidate the real winner even though the CAS caller
        // observed a failure. The locked relation check is authoritative; never Trash that winner.
        this.logger.log(
          `coordinator candidate ${sessionId} was adopted before discard and was preserved`,
        );
      }
      return;
    }
    // Compatibility path for hand-built service doubles and a mixed-version SessionsService.
    // Clear the provisional marker before the soft-delete attempt. If recycling the runtime fails
    // and `remove` has to leave a live orphan behind, at least no Project can later overwrite its
    // title. The helper re-checks adoption under the Session lock, so a real winner keeps the bit.
    try {
      await this.sessions.releaseProjectTitleManagement?.(ownerId, sessionId);
    } catch (e) {
      this.logger.error(
        `coordinator candidate ${sessionId} could not release its managed-title marker before discard`,
        e instanceof Error ? e.stack : String(e),
      );
    }
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
    // Retry after soft-delete in case the first best-effort cleanup exhausted a transient retry.
    // This provenance cleanup still cannot make a successfully discarded candidate an API failure.
    try {
      await this.sessions.releaseProjectTitleManagement?.(ownerId, sessionId);
    } catch (e) {
      this.logger.error(
        `discarded coordinator candidate ${sessionId} kept its managed-title marker`,
        e instanceof Error ? e.stack : String(e),
      );
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
   * One wording for "this project's coordinator is not where you asked", whether that was noticed
   * before a session was created or after losing the race to bind one. Two phrasings would read as
   * two different rules to anyone who hit both.
   */
  private static readonly ELSEWHERE =
    'this project already has a coordinator, and it runs in a different workspace — open it where ' +
    'it is, or delete it first. Moving a coordinator is not something this endpoint does as a side ' +
    'effect of asking for one.';

  /**
   * The one thing that clears `COORDINATOR_UNAVAILABLE`, in the words the refusal itself uses.
   *
   * Named rather than written twice because `coordinatorStatus` predicts this refusal before the
   * press and `coordinatorUnavailable` delivers it after: two phrasings of one required action
   * would read as two different rules to anyone who saw both.
   */
  private static readonly REBIND_REQUIRED_ACTION =
    'rebind this project’s coordination workspace (or restore/enable the one it names), then ' +
    'open the coordinator again';

  /** The 400 a FIRST coordinator gets when this project has nowhere to borrow a workspace from.
   *  Named for the same reason `REBIND_REQUIRED_ACTION` is: the read predicts it, the throw
   *  delivers it, and they have to say the same thing. */
  private static readonly NO_LANDING_WORKSPACE =
    'no workspace to open the coordinator in — none of this project’s tasks has an assignee ' +
    'to borrow one from. Assign a task, or pass workspaceId.';
}

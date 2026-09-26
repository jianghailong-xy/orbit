import { Prisma } from '@prisma/client';
import type { TaskIntegrationState } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { readCriterionLanding } from '../projects/project-criterion-landing';
import { readCriterionSatisfaction } from '../projects/project-criterion-satisfaction';
import { readProjectIntegrationLines } from '../projects/project-integration-line';
import { readProjectBlockingLeaderboard } from '../projects/project-panorama-blocking';
import { readProjectPanorama, type ProjectPanorama } from '../projects/project-panorama';
import { ProjectsService } from '../projects/projects.service';
import { readPublicTask, type PublicTask } from './public-task';
import { linkNotFound, type ShareInclude } from './share-link';

/**
 * A project as a public link shows it: docs/share-links-design.md §1 (its layers), §6 (what no layer
 * ever shows) and §7 (the page: seven of the app project page's sixteen blocks, in their order —
 * Header, Work overview, Goal, Task graph, Chain progress, Acceptance criteria, Tasks).
 *
 * Every number and every lane here is the app's own: the panorama, the dependency graph, the task
 * page, the blocking ranking and the criteria lanes are the reads the project page itself makes
 * (projects/*), called with the link owner's id. What this file adds is only the projection — each
 * answer is built field by field from theirs, so a field those reads gain later reaches a visitor
 * only when somebody adds it here. share-links/public-project.pg.spec.ts plants the owner's private
 * values (instructions, blockers, branches, receipts, runners, compute) and shows them absent.
 */

/** A task named on the page: enough to say which, and how it stands. */
export interface PublicTaskRef {
  id: string;
  title: string;
  status: string;
}

/** The lane a task is in, as the app's task-work classifier puts it (RUNNING, READY, BLOCKED, …). */
type WorkState = string;

/** The live half of a task on the graph — a run in flight, or one queued — and its lane. */
interface PublicGraphTaskState {
  running: boolean;
  queued: boolean;
  workState: WorkState | null;
}

/**
 * One mark of the app's task graph (projects/project-graph-fold.ts): a task, a folded straight run
 * of tasks, or one stage of a repeated motif. Tasks are named by id, title and status, with the
 * state the app draws a node in; nothing else a task carries is on the graph.
 */
export type PublicGraphMark =
  | ({ kind: 'TASK'; id: string; taskId: string; title: string; status: string; parentTaskId: string | null } & PublicGraphTaskState)
  | {
      kind: 'RUN';
      id: string;
      title: string;
      taskCount: number;
      statusCounts: Record<string, number>;
      parentTaskId: string | null;
      members: ({ taskId: string; title: string; status: string } & PublicGraphTaskState)[];
      expandable: boolean;
    }
  | {
      kind: 'MOTIF';
      id: string;
      title: string;
      instanceCount: number;
      taskCount: number;
      statusCounts: Record<string, number>;
      parentTaskId: null;
      samples: ({ taskId: string; title: string; status: string } & PublicGraphTaskState)[];
    };

/**
 * Where a criterion's work has landed, in the only three things a visitor is told (contract §6):
 * on main, on the project's branch and so not on main yet, or no merge receipt either way. The
 * branch itself is never named.
 */
export type PublicLanding = 'ON_MAIN' | 'NOT_ON_MAIN_YET' | 'NO_MERGE_RECEIPT';

/** One stated criterion: its words, how it is checked, whether its work has met it, and where that
 *  work is; when it has not, the tasks holding it up. */
export interface PublicCriterion {
  ordinal: number;
  text: string;
  verificationMethod: string | null;
  /** Null when the read did not answer for it (a criterion written between two reads). */
  satisfied: boolean | null;
  landing: PublicLanding;
  heldUpBy: PublicTaskRef[];
}

/** Where a task is between done and on main, said without a branch, a receipt or a handler: the
 *  platform still has it in hand, it is on the project's branch, or it is on main. */
export type PublicTaskLanding = 'INTEGRATING' | 'ON_PROJECT_BRANCH' | 'ON_MAIN' | null;

/** One row of the Tasks block: what the app's banding and its row read, and nothing it does not. */
export interface PublicProjectTaskRow {
  id: string;
  title: string;
  status: string;
  workState: WorkState;
  landing: PublicTaskLanding;
  dependencyState: string;
  landingWaitCount: number;
  topoLevel: number;
  /** Prerequisites still owed work ("waits N"), wherever they are filed — a count, never a name. */
  unmetCount: number;
  /** Tasks that name this one as a prerequisite ("blocks N"). */
  blocksCount: number;
  childCount: number;
}

export interface PublicProject {
  id: string;
  title: string;
  status: string;
  /** When the project was started. */
  createdAt: Date;
  /** The most recent write to any of its tasks — what the project list calls its last activity. */
  lastActivityAt: Date | null;
  taskCount: number;
  overview: {
    buckets: Record<string, number>;
    shape: { taskCount: number; edgeCount: number; ratio: number; maxDepth: number; form: string };
    /** Which line its finished work lands on, so the card knows whether "On project branch" is a
     *  lane at all. Never the branch's name. */
    integrationLine: 'MAIN' | 'PROJECT_BRANCH' | null;
  };
  /** Only with Conversations: the project's coordinator conversation, which the link opens. */
  coordinator?: { sessionId: string };
  goal: string | null;
  graph: {
    marks: PublicGraphMark[];
    edges: { sourceMarkId: string; targetMarkId: string }[];
    taskCount: number;
    folded: boolean;
    truncated: boolean;
    /** The two ceilings the app's graph says it met, when it met one. */
    limits: { maxTasks: number; maxMarks: number };
  };
  /** Only for a chain-shaped project: the step it is on and the one after. */
  chain: { current: PublicTaskRef | null; next: PublicTaskRef | null } | null;
  criteria: PublicCriterion[];
  /** The project's top-level tasks, the first page of them, as the app's Tasks block reads them. */
  tasks: { items: PublicProjectTaskRow[]; hasMore: boolean };
}

/**
 * What a project link opens besides its root page, for the page's links to go to (the web's
 * resolver): its tasks with Task pages, and its conversations — every task's runs and its
 * coordinator — with Conversations. Newest first, and bounded: a reference past the bound is drawn
 * as its words, while the route itself still opens it.
 */
export interface ProjectScope {
  /** The project itself — the link's root page, which every page of it can link back to. */
  projectId: string;
  tasks: { id: string }[];
  conversations: { id: string }[];
}

/** How many of each kind a scope lists. */
const SCOPE_MAX = 2000;
/** The page of top-level tasks the Tasks block shows — the app's own first page. */
const TASKS_PAGE = '100';
/** The blocking ranking's depth the app's chain strip reads (two names of it). */
const CHAIN_RANKING = 5;

/** The layers of a project link that are in effect. Comments & files and Conversations sit under
 *  Task pages (contract §1, the dialog greys them out): with Task pages off, neither is shared. */
export function effectiveProjectInclude(include: Required<ShareInclude>): Required<ShareInclude> {
  if (include.taskPages) return include;
  return { ...include, commentsAndFiles: false, conversations: false };
}

/**
 * The owner's own reads, built from the client alone the way the read-only specs build them. The
 * task page and the graph derive what they say inside ProjectsService, and asking it — rather than
 * re-deriving any of it here — is what keeps the public page and the app on one answer.
 */
function ownersReads(prisma: PrismaService): ProjectsService {
  return new ProjectsService(prisma);
}

const PROJECT_SELECT = {
  id: true,
  title: true,
  status: true,
  goal: true,
  createdAt: true,
  coordinatorSessionId: true,
  // Read to decide whether the coordinator is shared, never written out: one in the Trash is paused.
  coordinatorSession: { select: { deletedAt: true } },
  acceptanceCriterionDefinitions: {
    orderBy: { ordinal: 'asc' },
    select: { id: true, ordinal: true, text: true, verificationMethod: true },
  },
} satisfies Prisma.ProjectSelect;

/** The project's coordinator conversation, when there is one and it is not in the Trash. */
function liveCoordinator(project: { coordinatorSessionId: string | null; coordinatorSession: { deletedAt: Date | null } | null }): string | null {
  return project.coordinatorSessionId && project.coordinatorSession && project.coordinatorSession.deletedAt == null
    ? project.coordinatorSessionId
    : null;
}

/**
 * The public projection of project `projectId` (owned by `ownerId`), with the layers `include`
 * turns on. A project gone since its link was resolved is the one 404.
 */
export async function readPublicProject(
  prisma: PrismaService,
  ownerId: string,
  projectId: string,
  include: Required<ShareInclude>,
): Promise<PublicProject> {
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId }, select: PROJECT_SELECT });
  if (!project) throw linkNotFound();
  const owners = ownersReads(prisma);

  const [panorama, lines, graph, page, satisfaction, landing, lastActivity] = await Promise.all([
    readProjectPanorama(prisma, ownerId, projectId),
    readProjectIntegrationLines(prisma, [projectId]),
    owners.dependencyGraph(ownerId, projectId),
    owners.taskPage(ownerId, projectId, { limit: TASKS_PAGE }),
    readCriterionSatisfaction(prisma, ownerId, projectId),
    readCriterionLanding(prisma, ownerId, projectId),
    prisma.task.aggregate({ where: { ownerId, projectId }, _max: { updatedAt: true } }),
  ]);
  const chain = panorama.shape.form === 'chain' && panorama.shape.taskCount > 0
    ? await readProjectBlockingLeaderboard(prisma, ownerId, projectId, CHAIN_RANKING)
    : null;

  const coordinator = include.conversations ? liveCoordinator(project) : null;
  const answered = new Map(satisfaction.map((row) => [row.definitionId, row]));
  const landed = new Map(landing.map((row) => [row.definitionId, row.landing]));

  return {
    id: project.id,
    title: project.title,
    status: project.status,
    createdAt: project.createdAt,
    lastActivityAt: lastActivity._max.updatedAt ?? null,
    taskCount: panorama.shape.taskCount,
    overview: {
      buckets: publicBuckets(panorama.buckets),
      shape: {
        taskCount: panorama.shape.taskCount,
        edgeCount: panorama.shape.edgeCount,
        ratio: panorama.shape.ratio,
        maxDepth: panorama.shape.maxDepth,
        form: panorama.shape.form,
      },
      integrationLine: lines.get(projectId)?.line ?? null,
    },
    ...(coordinator ? { coordinator: { sessionId: coordinator } } : {}),
    goal: project.goal,
    graph: {
      marks: graph.marks.map(publicMark),
      edges: graph.edges.map((edge) => ({ sourceMarkId: edge.sourceMarkId, targetMarkId: edge.targetMarkId })),
      taskCount: graph.taskCount,
      folded: graph.folded,
      truncated: graph.truncated,
      limits: { maxTasks: graph.limits.maxTasks, maxMarks: graph.limits.maxMarks },
    },
    chain: chain
      ? { current: chain.items[0] ? taskRef(chain.items[0]) : null, next: chain.items[1] ? taskRef(chain.items[1]) : null }
      : null,
    criteria: project.acceptanceCriterionDefinitions.map((definition) => {
      const derived = answered.get(definition.id);
      return {
        ordinal: definition.ordinal,
        text: definition.text,
        verificationMethod: definition.verificationMethod || null,
        satisfied: derived ? derived.satisfied : null,
        landing: publicLanding(landed.get(definition.id)),
        heldUpBy: heldUpBy(derived?.unmet ?? []),
      };
    }),
    tasks: {
      items: page.items.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        workState: task.workState,
        landing: publicTaskLanding(task.integration.state),
        dependencyState: task.dependencyState,
        landingWaitCount: task.landingWaitCount,
        topoLevel: task.topoLevel,
        unmetCount: task.unmetCount,
        blocksCount: task.blocksCount,
        childCount: task.childCount,
      })),
      hasMore: page.nextCursor != null,
    },
  };
}

/** The panorama's lanes, each copied by name: counts, and nothing a later lane might carry. */
function publicBuckets(buckets: ProjectPanorama['buckets']): Record<string, number> {
  const out: Record<string, number> = {
    running: buckets.running,
    ready: buckets.ready,
    blocked: buckets.blocked,
    awaitingVerification: buckets.awaitingVerification,
    done: buckets.done,
    failed: buckets.failed,
    cancelled: buckets.cancelled,
  };
  // The integration lanes are one set, present only for a project that integrates (§7.2 V6).
  for (const lane of ['integrating', 'onIntegrationLine', 'onUpstream', 'doneNotIntegrated', 'waitingForLanding'] as const) {
    const value = buckets[lane];
    if (typeof value === 'number') out[lane] = value;
  }
  return out;
}

type OwnersGraph = Awaited<ReturnType<ProjectsService['dependencyGraph']>>;
type OwnersMark = OwnersGraph['marks'][number];

function graphTask(task: { running?: boolean; queued?: boolean; workState?: string | null }): PublicGraphTaskState {
  return { running: task.running === true, queued: task.queued === true, workState: task.workState ?? null };
}

function publicMark(mark: OwnersMark): PublicGraphMark {
  const member = (m: { taskId: string; title: string; status: string; running?: boolean; queued?: boolean; workState?: string | null }) => ({
    taskId: m.taskId,
    title: m.title,
    status: m.status,
    ...graphTask(m),
  });
  switch (mark.kind) {
    case 'TASK':
      return {
        kind: 'TASK',
        id: mark.id,
        taskId: mark.taskId,
        title: mark.title,
        status: mark.status,
        parentTaskId: mark.parentTaskId,
        ...graphTask(mark),
      };
    case 'RUN':
      return {
        kind: 'RUN',
        id: mark.id,
        title: mark.title,
        taskCount: mark.taskCount,
        statusCounts: { ...mark.statusCounts },
        parentTaskId: mark.parentTaskId,
        members: mark.members.map(member),
        expandable: mark.expandable,
      };
    case 'MOTIF':
      return {
        kind: 'MOTIF',
        id: mark.id,
        title: mark.title,
        instanceCount: mark.instanceCount,
        taskCount: mark.taskCount,
        statusCounts: { ...mark.statusCounts },
        parentTaskId: null,
        samples: mark.samples.map(member),
      };
  }
}

function taskRef(task: { taskId: string; title: string; status: string }): PublicTaskRef {
  return { id: task.taskId, title: task.title, status: task.status };
}

/** The app's three landing answers, in the three phrases a visitor is given. */
function publicLanding(landing: string | undefined): PublicLanding {
  if (landing === 'LANDED') return 'ON_MAIN';
  if (landing === 'ON_INTEGRATION_LINE') return 'NOT_ON_MAIN_YET';
  return 'NO_MERGE_RECEIPT';
}

/** Every task holding a criterion open, once each, in the order its reasons name them. */
function heldUpBy(unmet: ReadonlyArray<{ heldUpBy: ReadonlyArray<{ taskId: string; title: string; status: string }> }>): PublicTaskRef[] {
  const seen = new Set<string>();
  const out: PublicTaskRef[] = [];
  for (const reason of unmet) {
    for (const task of reason.heldUpBy) {
      if (seen.has(task.taskId)) continue;
      seen.add(task.taskId);
      out.push(taskRef(task));
    }
  }
  return out;
}

/** A task's integration state, coarsened: whatever stopped it or who has it is the owner's to know. */
function publicTaskLanding(state: TaskIntegrationState): PublicTaskLanding {
  switch (state) {
    case 'ON_UPSTREAM':
      return 'ON_MAIN';
    case 'ON_INTEGRATION_LINE':
      return 'ON_PROJECT_BRANCH';
    case 'QUEUED':
    case 'RUNNING':
    case 'CONFLICT':
    case 'CHECK_FAILED':
    case 'ERROR':
    case 'AWAITING_OWNER':
      return 'INTEGRATING';
    default:
      return null;
  }
}

/** The project's tasks' runs a visitor may open: not in the Trash. */
const projectRuns = (projectId: string): Prisma.SessionWhereInput => ({ task: { projectId }, deletedAt: null });

/**
 * What a project link opens besides its root (ProjectScope): with Task pages, its tasks; with
 * Conversations, its tasks' runs and its coordinator.
 */
export async function readProjectScope(
  prisma: PrismaService,
  projectId: string,
  include: Required<ShareInclude>,
): Promise<ProjectScope> {
  const [tasks, runs, coordinator] = await Promise.all([
    include.taskPages
      ? prisma.task.findMany({
          where: { projectId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: SCOPE_MAX,
          select: { id: true },
        })
      : [],
    include.conversations
      ? prisma.session.findMany({
          where: projectRuns(projectId),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: SCOPE_MAX,
          select: { id: true },
        })
      : [],
    include.conversations ? readCoordinator(prisma, projectId) : null,
  ]);
  return {
    projectId,
    tasks: tasks.map((task) => ({ id: task.id })),
    conversations: [...(coordinator ? [{ id: coordinator }] : []), ...runs.map((run) => ({ id: run.id }))],
  };
}

async function readCoordinator(prisma: PrismaService, projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { coordinatorSessionId: true, coordinatorSession: { select: { deletedAt: true } } },
  });
  return project ? liveCoordinator(project) : null;
}

/**
 * A task page under a project link (`/shared/:token/tasks/:taskId`): the task link's projection
 * (public-task.ts) of one of the project's tasks, with the link's layers. Only with Task pages, and
 * only a task filed under this project — anything else is the one 404.
 */
export async function readPublicProjectTask(
  prisma: PrismaService,
  projectId: string,
  include: Required<ShareInclude>,
  taskId: string,
): Promise<PublicTask> {
  if (!include.taskPages) throw linkNotFound();
  const task = await prisma.task.findFirst({ where: { id: taskId, projectId }, select: { id: true } });
  if (!task) throw linkNotFound();
  // The attempt that replaced it is named by id when the link shares it too: filed here.
  return readPublicTask(prisma, taskId, include, (other) => other.projectId === projectId);
}

/** A conversation a project link opens, and what its page needs around the transcript. */
export interface ProjectConversation {
  project: { title: string };
  /** The task it is a run of, and that task's runs a visitor may open; null for the coordinator. */
  task: { id: string; title: string; runs: { sessionId: string }[] } | null;
}

/**
 * The conversation `sessionId` under a project link with Conversations: a run (not in the Trash)
 * of one of the project's tasks, or the project's coordinator. Anything else is the one 404.
 */
export async function readPublicProjectConversation(
  prisma: PrismaService,
  projectId: string,
  include: Required<ShareInclude>,
  sessionId: string,
): Promise<ProjectConversation> {
  if (!include.conversations) throw linkNotFound();
  const [project, run] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { title: true, coordinatorSessionId: true, coordinatorSession: { select: { deletedAt: true } } },
    }),
    prisma.session.findFirst({
      where: { id: sessionId, ...projectRuns(projectId) },
      select: {
        task: {
          select: {
            id: true,
            title: true,
            sessions: { where: { deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } },
          },
        },
      },
    }),
  ]);
  if (!project) throw linkNotFound();
  if (run?.task) {
    return {
      project: { title: project.title },
      task: {
        id: run.task.id,
        title: run.task.title,
        runs: run.task.sessions.map((session) => ({ sessionId: session.id })),
      },
    };
  }
  if (liveCoordinator(project) === sessionId) return { project: { title: project.title }, task: null };
  throw linkNotFound();
}

/**
 * An attachment's bytes for a project link: one of its tasks' input files with Comments & files, or
 * one belonging to a conversation it opens with Conversations. Anything else is the one 404.
 */
export async function readPublicProjectAttachment(
  prisma: PrismaService,
  projectId: string,
  include: Required<ShareInclude>,
  id: string,
): Promise<{ data: Buffer; mimeType: string }> {
  const within: Prisma.AttachmentWhereInput[] = [];
  if (include.commentsAndFiles) within.push({ task: { projectId } });
  if (include.conversations) {
    within.push({ session: projectRuns(projectId) });
    const coordinator = await readCoordinator(prisma, projectId);
    if (coordinator) within.push({ sessionId: coordinator });
  }
  if (within.length === 0) throw linkNotFound();
  const row = await prisma.attachment.findFirst({ where: { id, OR: within }, select: { data: true, mimeType: true } });
  if (!row) throw linkNotFound();
  return { data: Buffer.from(row.data), mimeType: row.mimeType };
}

/** How much a project link's layers hold — what the Share dialog counts for its owner. */
export interface ProjectShareCounts {
  tasks: number;
  comments: number;
  files: number;
  /** Its tasks' runs, not in the Trash. */
  runs: number;
  /** The runs, and the coordinator's conversation when it has one. */
  transcripts: number;
}

export async function projectShareCounts(prisma: PrismaService, projectId: string): Promise<ProjectShareCounts> {
  const [tasks, comments, files, runs, coordinator] = await Promise.all([
    prisma.task.count({ where: { projectId } }),
    prisma.taskComment.count({ where: { task: { projectId } } }),
    prisma.attachment.count({ where: { task: { projectId } } }),
    prisma.session.count({ where: projectRuns(projectId) }),
    readCoordinator(prisma, projectId),
  ]);
  return { tasks, comments, files, runs, transcripts: runs + (coordinator ? 1 : 0) };
}

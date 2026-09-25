import { CreatorType, Prisma } from '@prisma/client';
import { SessionRunState } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { withSessionState } from '../sessions/session-state';
import { taskOutcome, type TaskOutcome } from '../tasks/task-supersession';
import { linkNotFound, type ShareInclude } from './share-link';

/**
 * A task as a public link shows it: docs/share-links-design.md §1 (its layers), §6 (what no layer
 * ever shows) and §7 (the page it is drawn as).
 *
 * Every read here names its columns, and the answer is built field by field. The owner's
 * `GET /tasks/:id` spreads the whole row — the owner, the provider and model, the dispatch and
 * convergence ledgers, the known-good SHA, the refusal a runner wrote — and every comment's delivery
 * record; none of that is selected here, so a column added to `task` later reaches a visitor only
 * when somebody adds it to this file. share-links/public-task.pg.spec.ts holds the answer's field set
 * and plants those values in the owner's data to show they stay out.
 */

/** A task on the other end of a dependency. Its project decides whether a visitor may read its title. */
const EDGE_TASK = { id: true, title: true, status: true, projectId: true } satisfies Prisma.TaskSelect;

/** What a run says about itself on the page: how it went, and when. */
const RUN_SELECT = {
  id: true,
  status: true,
  endReason: true,
  completedAt: true,
  archivedAt: true,
  deletedAt: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  lastTurnAt: true,
} satisfies Prisma.SessionSelect;

const TASK_SELECT = {
  id: true,
  // Read to decide things, never written out: whose workspaces sign its comments, and which of its
  // dependencies share its project.
  ownerId: true,
  projectId: true,
  title: true,
  status: true,
  terminalReason: true,
  completionCriterion: true,
  description: true,
  acceptanceCriteria: true,
  acceptanceCommand: true,
  acceptanceExpectedExitCode: true,
  createdAt: true,
  project: { select: { title: true } },
  supersededBy: { select: { id: true, title: true } },
  dependsOn: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { dependsOnTask: { select: EDGE_TASK } } },
  dependedOnBy: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { task: { select: EDGE_TASK } } },
  // Its runs, newest first as the app lists them. One in the Trash is paused, like a session link
  // whose session is there (contract §3): not listed, and its conversation answers the one 404.
  sessions: { where: { deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: RUN_SELECT },
} satisfies Prisma.TaskSelect;

/** A task this one depends on, or one that depends on it, inside its project. */
export interface PublicTaskEdge {
  id: string;
  title: string;
  status: string;
}

/** One run: how it went, when it started and stopped, and — with Conversations — the way into it. */
export interface PublicTaskRun {
  state: SessionRunState;
  startedAt: Date;
  /** When the run last stopped working: its finish, or the end of its last turn while it waits for
   *  a reply. Null while it is queued or running. */
  endedAt: Date | null;
  durationMs: number | null;
  /** Only when the link includes Conversations. */
  sessionId?: string;
}

/** A comment as a visitor reads it: what it says, when, and who — a workspace, or "Owner". */
export interface PublicTaskComment {
  author: string;
  body: string;
  createdAt: Date;
}

/** One of the task's input files, described; its bytes come through /shared/:token/attachments/:id. */
export interface PublicTaskInput {
  id: string;
  fileName: string | null;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface PublicTask {
  id: string;
  title: string;
  status: string;
  /** `status` with a replaced attempt and a dropped one told apart (Superseded / Abandoned). */
  outcome: TaskOutcome;
  /** The attempt that replaced this one, by title; by id too only when the link shares it. */
  supersededBy: { id?: string; title: string } | null;
  /** Who settles it: its acceptance command, an independent check, submitted evidence, or its owner. */
  completionCriterion: string;
  createdAt: Date;
  /** The project it is filed under, named — the page's breadcrumb. */
  project: { title: string } | null;
  description: string | null;
  acceptanceCriteria: string | null;
  acceptanceCommand: string | null;
  acceptanceExpectedExitCode: number | null;
  /** Inside its project, each task named; across the line, only how many (contract §6). */
  dependencies: {
    prerequisites: PublicTaskEdge[];
    dependents: PublicTaskEdge[];
    prerequisitesInOtherProjects: number;
    dependentsInOtherProjects: number;
  };
  runs: PublicTaskRun[];
  /** Only with Comments & files. */
  comments?: PublicTaskComment[];
  /** Only with Comments & files. */
  inputs?: PublicTaskInput[];
}

/** How much each of a task link's layers holds — what the Share dialog counts for its owner. */
export interface TaskShareCounts {
  comments: number;
  files: number;
  transcripts: number;
}

/** What a human author is called on a public page, whoever they are (contract §6). */
export const PUBLIC_OWNER_NAME = 'Owner';
/** What an agent author is called when its workspace no longer exists to be named. */
const UNNAMED_AGENT = 'Agent';

const LIVE_RUN_STATES: ReadonlySet<SessionRunState> = new Set([SessionRunState.QUEUED, SessionRunState.RUNNING]);

/**
 * The public projection of task `taskId`, with the layers `include` turns on. `inScope` says which
 * tasks the link itself shares — only those are named by id where the contract leaves it to scope
 * (the attempt that superseded this one). A task gone since its link was resolved is the one 404.
 */
export async function readPublicTask(
  prisma: PrismaService,
  taskId: string,
  include: Required<ShareInclude>,
  inScope: (taskId: string) => boolean,
): Promise<PublicTask> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: TASK_SELECT });
  if (!task) throw linkNotFound();

  const inProject = (edge: { projectId: string | null }) =>
    task.projectId != null && edge.projectId === task.projectId;
  const edge = (t: { id: string; title: string; status: string }): PublicTaskEdge => ({
    id: t.id,
    title: t.title,
    status: t.status,
  });
  const prerequisites = task.dependsOn.map((d) => d.dependsOnTask);
  const dependents = task.dependedOnBy.map((d) => d.task);

  const projected: PublicTask = {
    id: task.id,
    title: task.title,
    status: task.status,
    outcome: taskOutcome(task),
    supersededBy: task.supersededBy
      ? inScope(task.supersededBy.id)
        ? { id: task.supersededBy.id, title: task.supersededBy.title }
        : { title: task.supersededBy.title }
      : null,
    completionCriterion: task.completionCriterion,
    createdAt: task.createdAt,
    project: task.project ? { title: task.project.title } : null,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    acceptanceCommand: task.acceptanceCommand,
    acceptanceExpectedExitCode: task.acceptanceExpectedExitCode,
    dependencies: {
      prerequisites: prerequisites.filter(inProject).map(edge),
      dependents: dependents.filter(inProject).map(edge),
      prerequisitesInOtherProjects: prerequisites.filter((t) => !inProject(t)).length,
      dependentsInOtherProjects: dependents.filter((t) => !inProject(t)).length,
    },
    runs: task.sessions.map((session) => publicRun(session, include.conversations)),
  };
  if (!include.commentsAndFiles) return projected;

  const [comments, inputs] = await Promise.all([
    prisma.taskComment.findMany({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { authorType: true, authorId: true, body: true, createdAt: true },
    }),
    prisma.attachment.findMany({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
    }),
  ]);
  const agentIds = [...new Set(comments.filter((c) => c.authorType === CreatorType.AGENT).map((c) => c.authorId))];
  const workspaces = agentIds.length
    ? await prisma.workspace.findMany({
        where: { id: { in: agentIds }, ownerId: task.ownerId },
        select: { id: true, name: true },
      })
    : [];
  const workspaceName = new Map(workspaces.map((w) => [w.id, w.name]));
  return {
    ...projected,
    comments: comments.map((c) => ({
      author: c.authorType === CreatorType.AGENT ? workspaceName.get(c.authorId) ?? UNNAMED_AGENT : PUBLIC_OWNER_NAME,
      body: c.body,
      createdAt: c.createdAt,
    })),
    inputs: inputs.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      createdAt: a.createdAt,
    })),
  };
}

function publicRun(session: Prisma.SessionGetPayload<{ select: typeof RUN_SELECT }>, conversations: boolean): PublicTaskRun {
  const { runState } = withSessionState(session);
  const startedAt = session.startedAt ?? session.createdAt;
  const endedAt = LIVE_RUN_STATES.has(runState) ? null : session.finishedAt ?? session.lastTurnAt ?? null;
  return {
    state: runState,
    startedAt,
    endedAt,
    durationMs: endedAt ? Math.max(0, endedAt.getTime() - startedAt.getTime()) : null,
    ...(conversations ? { sessionId: session.id } : {}),
  };
}

/**
 * The run of task `taskId` a link with Conversations opens as `sessionId`, with what its page needs
 * around the transcript: the task it is a run of, and the task's other runs a visitor may open. A
 * session that is not one of its runs, or is in the Trash, is the one 404.
 */
export async function readPublicTaskRun(
  prisma: PrismaService,
  taskId: string,
  sessionId: string,
): Promise<{ id: string; title: string; runs: { sessionId: string }[] }> {
  const run = await prisma.session.findFirst({
    where: { id: sessionId, taskId, deletedAt: null },
    select: {
      task: {
        select: {
          id: true,
          title: true,
          sessions: { where: { deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } },
        },
      },
    },
  });
  if (!run?.task) throw linkNotFound();
  return {
    id: run.task.id,
    title: run.task.title,
    runs: run.task.sessions.map((session) => ({ sessionId: session.id })),
  };
}

/**
 * An attachment's bytes for a task link: one of the task's input files when the link includes
 * Comments & files, or one belonging to one of its runs when it includes Conversations. Anything
 * else — another task's file, a run in the Trash, a layer that is off — is the one 404.
 */
export async function readPublicTaskAttachment(
  prisma: PrismaService,
  taskId: string,
  include: Required<ShareInclude>,
  id: string,
): Promise<{ data: Buffer; mimeType: string }> {
  const within: Prisma.AttachmentWhereInput[] = [];
  if (include.commentsAndFiles) within.push({ taskId });
  if (include.conversations) within.push({ session: { taskId, deletedAt: null } });
  if (within.length === 0) throw linkNotFound();
  const row = await prisma.attachment.findFirst({ where: { id, OR: within }, select: { data: true, mimeType: true } });
  if (!row) throw linkNotFound();
  return { data: Buffer.from(row.data), mimeType: row.mimeType };
}

/** How much a task link's layers hold: its comments and input files, and its runs' transcripts. */
export async function taskShareCounts(prisma: PrismaService, taskId: string): Promise<TaskShareCounts> {
  const [comments, files, transcripts] = await Promise.all([
    prisma.taskComment.count({ where: { taskId } }),
    prisma.attachment.count({ where: { taskId } }),
    prisma.session.count({ where: { taskId, deletedAt: null } }),
  ]);
  return { comments, files, transcripts };
}

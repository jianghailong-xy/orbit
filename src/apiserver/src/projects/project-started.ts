import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProjectStatus, TaskStatus } from '@prisma/client';
import {
  type ProjectStartRecord,
  type ProjectStartSettingKey,
  type ProjectStartSettings,
  type ProjectStartedCard,
  uuidToBase62,
} from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import type { SessionsService } from '../sessions/sessions.service';
import { branchName } from './project-criterion-landing';
import { SESSION_ENDING_SELECT, sessionHasEnded } from './project-open-item';

/**
 * "The owner started this project", told to the conversation the project is coordinated from.
 *
 * §0 — WHY THE PLATFORM SAYS IT
 * =============================
 * A start (`ProjectAcceptanceService.startProject`, and "Start the project" on the older card,
 * which starts it with the default settings) writes the project's `started_at` and the settings it
 * runs with, and an older client's Automatic switch (`ProjectsService.update`) turning
 * `coordinator_enabled` back on lifts the pause its off wrote (`project-pause.ts`). Either press
 * lets Orbit start this project's tasks — the ones opted into auto-run, and no others — and the
 * switch is told only when the project then moves by itself (started, and not paused by its owner).
 * A coordinator that filed its tasks to be started by hand and then waited for the owner's go-ahead
 * was never told the go-ahead came: the press spoke to the dispatcher, and the one party holding
 * the work was a conversation it never reached. On 2026-09-23 a project was started with all eight
 * of its tasks held that way, its coordinator parked on a question, and nothing moved.
 *
 * §1 — WHAT IT SAYS, AND WHAT IT DOES NOT
 * =======================================
 * The fact, and the open tasks nothing will start except the coordinator. It is not a stand-in for
 * any other answer: the press authorized work on the project and answered no question the
 * coordinator put to the owner, and the message says so — a coordinator still waiting on the owner
 * puts its question back in front of them instead of waiting in silence.
 *
 * §2 — ONCE PER START, AND NEVER A REVIVAL
 * ========================================
 * Keyed by what the press wrote, so a replay collapses onto the turn already written. A
 * conversation that has ended is not revived to be told (`sessionHasEnded`), and a project with no
 * conversation has nobody to tell. A turn is a notification, not an interrupt: a coordinator in the
 * middle of a turn reads this when that turn ends.
 *
 * §3 — AND A CARD, NOT THE READER'S BUBBLE
 * ========================================
 * The words are for the agent. A client draws the turn from `ProjectStartedCard` instead, recorded
 * beside the runner's echo and on the queued turn the way an exception item's delivery is
 * (`readProjectStartedCard`). The key is what makes a turn one of these: `project-started:v1:` and
 * what the press wrote, read back by `projectStartOfTurn` — nothing is minted and nothing looked up
 * to recognise one.
 */

/** How many held tasks the message names before it counts the rest. */
export const PROJECT_STARTED_LISTED_TASKS = 20;

/** An open task nothing will start but the coordinator, as the message names it. */
export interface HeldTask {
  id: string;
  title: string;
}

/**
 * Which press turned the project on: the owner starting it, which confirms its criteria, or the
 * owner moving its Automatic switch — each keyed by what that press wrote, so one start is told once.
 *
 * A start that recorded the settings it left the project with carries them as `record` (the
 * confirmation's `started_with`), and `lineLocked` when its integration line had already started and
 * so stayed where it was.
 */
export type ProjectStart =
  | {
    by: 'CONFIRMATION';
    confirmationId: string;
    criteriaCount: number;
    at: Date;
    record?: ProjectStartRecord;
    lineLocked?: boolean;
  }
  | { by: 'SWITCH'; configRevision: string; at: Date };

/** Every project-start turn's client id starts here, which is how a reader recognises one. */
export const PROJECT_STARTED_TURN_PREFIX = 'project-started:v1:';

/** The `clientTurnId` of the one turn that tells a coordinator about one start. §3. */
export function projectStartedTurnId(projectId: string, start: ProjectStart): string {
  return start.by === 'CONFIRMATION'
    ? `${PROJECT_STARTED_TURN_PREFIX}confirmation:${start.confirmationId}`
    : `${PROJECT_STARTED_TURN_PREFIX}switch:${projectId}:${start.configRevision}`;
}

/** The start a turn tells of, as its key names it. */
export type ProjectStartKey =
  | { by: 'CONFIRMATION'; confirmationId: string }
  | { by: 'SWITCH'; projectId: string; configRevision: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The start a turn tells of, read back off the turn's own key — or null for any other turn.
 *
 * Every reader that is not one of these answers null, and a key that only looks like one does too:
 * this runs on the event-ingest path, where a throw costs a batch of somebody's transcript, and an
 * id that is not a uuid would be one — the database refuses to compare it.
 */
export function projectStartOfTurn(clientTurnId: string | null | undefined): ProjectStartKey | null {
  if (typeof clientTurnId !== 'string' || !clientTurnId.startsWith(PROJECT_STARTED_TURN_PREFIX)) {
    return null;
  }
  const [by, id, revision, ...rest] = clientTurnId
    .slice(PROJECT_STARTED_TURN_PREFIX.length)
    .split(':');
  if (rest.length > 0 || !id || !UUID.test(id)) return null;
  if (by === 'confirmation' && revision === undefined) {
    return { by: 'CONFIRMATION', confirmationId: id };
  }
  if (by === 'switch' && revision !== undefined && /^\d+$/.test(revision)) {
    return { by: 'SWITCH', projectId: id, configRevision: revision };
  }
  return null;
}

type StartReader = Pick<PrismaService, 'project' | 'task' | 'projectStandardSetConfirmation'>;

/** The open tasks nothing starts but the coordinator: the message's list and the card's. */
async function readHeldTasks(
  prisma: Pick<PrismaService, 'task'>,
  projectId: string,
): Promise<{ held: HeldTask[]; heldCount: number }> {
  const where = { projectId, status: TaskStatus.OPEN, autoRunWhenReady: false };
  const held = await prisma.task.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PROJECT_STARTED_LISTED_TASKS,
    select: { id: true, title: true },
  });
  return { held, heldCount: await prisma.task.count({ where }) };
}

/**
 * The card a project-start turn is drawn as (§3), or null when its key names nothing of this
 * owner's — a confirmation or a project that is gone, or somebody else's.
 */
export async function readProjectStartedCard(
  prisma: StartReader,
  ownerId: string | null | undefined,
  key: ProjectStartKey,
): Promise<ProjectStartedCard | null> {
  if (!ownerId) return null;
  let projectId: string;
  let criteriaCount: number | null = null;
  // What the start recorded beside its confirmation (`project-start.ts`): only a start's
  // confirmation has one, and a card carries it only then.
  let record: ProjectStartRecord | null = null;
  if (key.by === 'CONFIRMATION') {
    const confirmation = await prisma.projectStandardSetConfirmation.findFirst({
      where: { id: key.confirmationId, ownerId },
      select: { projectId: true, criteriaMaterial: true, startedWith: true },
    });
    if (!confirmation) return null;
    projectId = confirmation.projectId;
    criteriaCount = Array.isArray(confirmation.criteriaMaterial)
      ? confirmation.criteriaMaterial.length
      : null;
    record = confirmation.startedWith as unknown as ProjectStartRecord | null;
  } else {
    projectId = key.projectId;
  }
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId },
    select: { title: true },
  });
  if (!project) return null;
  return {
    by: key.by,
    projectId,
    projectTitle: project.title,
    criteriaCount,
    ...(await readHeldTasks(prisma, projectId)),
    ...(record ? { settings: record.settings, differsFromRequest: record.differsFromRequest } : {}),
  };
}

/** The words a setting goes by when the message names it as different. */
const SETTING_NAMES: Record<ProjectStartSettingKey, string> = {
  line: 'the integration line',
  automatic: 'Automatic',
  maxConcurrentTasks: 'the concurrency limit',
  mergeCheckCommand: 'the merge check',
};

/** The settings a start left the project with, in one line, as the message says them. */
function projectStartSettingsLine(settings: ProjectStartSettings): string {
  const line = settings.line === 'PROJECT_BRANCH'
    ? `tasks land on the project branch ${
      settings.projectBranchName ? branchName(settings.projectBranchName) : 'of its own'} first`
    : 'tasks land directly into main';
  const tasks = settings.maxConcurrentTasks === 1 ? 'task' : 'tasks';
  return [
    line,
    `Automatic ${settings.automatic ? 'on' : 'off'}`,
    `at most ${settings.maxConcurrentTasks} ${tasks} at a time`,
    settings.mergeCheckCommand ? `merge check \`${settings.mergeCheckCommand}\`` : 'no merge check',
  ].join(' · ');
}

/** The message's words. `held` is at most `PROJECT_STARTED_LISTED_TASKS` of `heldCount`. */
export function projectStartedMessage(input: {
  projectId: string;
  projectTitle: string;
  start: ProjectStart;
  held: readonly HeldTask[];
  heldCount: number;
}): string {
  const { start } = input;
  const project = `project “${input.projectTitle}” (${uuidToBase62(input.projectId)})`;
  const at = start.at.toISOString();
  const what = start.by === 'CONFIRMATION'
    ? `The account owner confirmed the ${start.criteriaCount} acceptance `
      + `${start.criteriaCount === 1 ? 'criterion' : 'criteria'} of ${project} and started it at ${at}.`
    : `The account owner switched ${project} on (Automatic) at ${at}.`;
  const paragraphs = [
    start.by === 'CONFIRMATION' ? 'From Orbit · project started' : 'From Orbit · project switched on',
    `${what} From now on Orbit starts this project’s tasks that are set to run on their own `
      + '(autoRunWhenReady), within its concurrency limit.',
  ];
  // What the start set, and what of it is not what the start was asked for — the part a
  // coordinator that suggested settings needs in order to know what the owner changed.
  if (start.by === 'CONFIRMATION' && start.record) {
    const { settings, differsFromRequest } = start.record;
    let told = `It runs with: ${projectStartSettingsLine(settings)}.`;
    if (differsFromRequest.length > 0) {
      told += ` Different from what the start asked for: ${
        differsFromRequest.map((key) => SETTING_NAMES[key]).join(', ')}.`;
      if (start.lineLocked && differsFromRequest.includes('line')) {
        told += ' Its integration line had already started, so it stays where it was.';
      }
    }
    paragraphs.push(told);
  }
  if (input.heldCount === 0) {
    paragraphs.push(
      'None of its open tasks is set to be started by hand, so none of them is waiting on you.',
    );
  } else {
    const one = input.heldCount === 1;
    const lines = input.held.map((task) => `- ${task.title} (${uuidToBase62(task.id)})`);
    const rest = input.heldCount - input.held.length;
    if (rest > 0) {
      lines.push(`- …and ${rest} more (task_list with projectId: ${uuidToBase62(input.projectId)})`);
    }
    paragraphs.push(
      `${input.heldCount} of its open tasks ${one ? 'is' : 'are'} set to be started by hand `
        + `(autoRunWhenReady=false), so nothing starts ${one ? 'it' : 'them'} unless you do:\n`
        + lines.join('\n'),
      'If you were holding them for this go-ahead, start them with task_start, or set '
        + 'autoRunWhenReady with task_update on the ones that may start by themselves.',
    );
  }
  paragraphs.push(
    `${start.by === 'CONFIRMATION' ? 'Starting the project' : 'Switching it on'} answered nothing `
      + 'else: if you are still waiting on the owner for something, ask it again.',
  );
  return paragraphs.join('\n\n');
}

/**
 * Tell the project's coordinator conversation that `start` turned the project on. §2.
 *
 * Null when nobody was told: the project has no conversation, it has ended, or `createTurn`
 * refused for a state of the world rather than a fault. A fault is thrown.
 */
export async function tellCoordinatorProjectStarted(
  prisma: PrismaService,
  sessions: SessionsService,
  input: { ownerId: string; projectId: string; start: ProjectStart },
): Promise<{ sessionId: string; clientTurnId: string } | null> {
  const project = await prisma.project.findFirst({
    where: { id: input.projectId, ownerId: input.ownerId },
    select: {
      title: true,
      coordinatorSessionId: true,
      coordinatorSession: { select: SESSION_ENDING_SELECT },
    },
  });
  const sessionId = project?.coordinatorSessionId;
  if (!project || !sessionId || !project.coordinatorSession) return null;
  if (sessionHasEnded(project.coordinatorSession)) return null;

  const { held, heldCount } = await readHeldTasks(prisma, input.projectId);

  const clientTurnId = projectStartedTurnId(input.projectId, input.start);
  try {
    await sessions.createTurn(input.ownerId, sessionId, {
      clientTurnId,
      content: projectStartedMessage({
        projectId: input.projectId,
        projectTitle: project.title,
        start: input.start,
        held,
        heldCount,
      }),
      intent: 'NEXT_TURN',
    });
  } catch (e) {
    // The refusals `createTurn` gives for an ordinary state of the world: the conversation is
    // gone, it ended or is being written right now, its workspace will not run it, or the key is
    // already spent. Anything else is a fault and is left to the caller.
    if (
      e instanceof NotFoundException
      || e instanceof ConflictException
      || e instanceof ForbiddenException
      || e instanceof BadRequestException
    ) {
      return null;
    }
    throw e;
  }
  return { sessionId, clientTurnId };
}

/**
 * A project its owner has not started yet, as `task_start` is refused over it.
 *
 * "Start the project" is the owner's go-ahead, and until it is pressed an agent does not start the
 * project's tasks by hand either. On 2026-09-25 a coordinator filed nine tasks and started two of
 * them itself sixteen seconds later, while the owner was still being asked whether to start — the
 * card said the project had not begun, and the project page showed two runs.
 *
 * Not started is `started_at` still null on an OPEN project that states criteria: nothing has
 * started it — neither the start card nor the older confirmation card, and none of the ways a
 * project could start before the column existed, which migration 0331 backfilled. The Automatic
 * switch is not one of them any more: it says how the project runs, not whether it has started. A
 * project without criteria has no card to press, so it is not held here.
 */
export interface ProjectAwaitingStart {
  projectId: string;
  title: string;
}

export async function projectAwaitingStart(
  prisma: Pick<PrismaService, 'project' | 'projectAcceptanceCriterionDefinition'>,
  ownerId: string,
  projectId: string,
): Promise<ProjectAwaitingStart | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId, status: ProjectStatus.OPEN, startedAt: null },
    select: { title: true },
  });
  if (!project) return null;
  const criterion = await prisma.projectAcceptanceCriterionDefinition.findFirst({
    where: { projectId },
    select: { id: true },
  });
  return criterion ? { projectId, title: project.title } : null;
}

/** The 409 an agent's `task_start` gets for a task in a project nobody has started. */
export function projectNotStartedRefusal(
  taskId: string,
  project: ProjectAwaitingStart,
): { code: 'PROJECT_NOT_STARTED'; message: string } {
  return {
    code: 'PROJECT_NOT_STARTED',
    message:
      `task ${uuidToBase62(taskId)}: its project “${project.title}” `
      + `(${uuidToBase62(project.projectId)}) has not been started, and until its owner starts it, `
      + 'task_start starts none of its tasks. Do not work around this: the project’s coordinator '
      + 'asks for the start with project_request_start once the plan is written and every '
      + 'acceptance criterion has a task serving it — Orbit checks the plan, says what is missing if '
      + 'anything is, and puts the start in front of the owner. The coordinator is told when it '
      + 'starts (“From Orbit · project started”); from then on its auto-run tasks start by '
      + 'themselves, and task_start starts the rest.',
  };
}

import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import type { Prisma as PrismaTypes } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { completionEvidenceWakeKey } from '../projects/completion-input';
import { deliveryRecordOf } from '../projects/coordinator-evidence-queue';
import { derivedUuid } from '../projects/project-dispatch-identity';
import { SESSION_ENDING_SELECT, sessionHasEnded } from '../projects/project-open-item';
import type { SessionsService } from '../sessions/sessions.service';
import { CRITERION_MOVED_CODE, criterionStandingRefusal, quotedCriterion } from './task-evidence-decision';
import {
  type CriterionStandingTask,
  definitionIdFromKey,
  heldToProjectCriterion,
  taskStandard,
} from './task-evidence-envelope';

/**
 * ONE PATH FOR "THIS UNANSWERED LATEST REVISION BECAME UNDECIDABLE"
 * (docs/evidence-always-has-an-addressee-design.md §3).
 *
 * The decision door refuses every answer to a revision whose bound standard is no longer the one
 * the task is held to (`criterionStandingRefusal`, EVIDENCE_JUDGMENT_CRITERION_MOVED). Only three
 * things can do that to a revision after it was submitted, and each calls `tellEvidenceUndecidable`
 * after its own commit:
 *
 *   * the task moved to another project (`TasksService.handOverMovedEvidence`);
 *   * a criterion of its project was reworded, or
 *   * the criterion it declared was deleted (both after `replaceAcceptanceDefinitions` commits,
 *     `ProjectsService.tellUndecidableEvidenceOfProject`).
 *
 * The only move that clears such a revision is a new one, and the only one who can file it is a run
 * of the task. So:
 *
 *   * each live run of the task is steered (`steerIfLive`) with why the revision cannot be decided
 *     and the standard it is held to now, word for word (`runMessage`);
 *   * the project's coordinator, when the project is Automatic and its conversation has not ended,
 *     is told (`coordinatorMessage`), and told whether a run was: with none, it is the coordinator's
 *     to act on — `task_start`, or change the standard. Nothing restarts the task by itself (D2 = A);
 *   * with neither, the owner's pending read offers Restart the task on the row
 *     (`undecidableAddressees`, `ownerAction`), and nobody is messaged.
 *
 * A revision is often undecidable only after it was handed to the coordinator to decide (a reword
 * after submission). Then the notice says the earlier request is withdrawn rather than that it was
 * never handed over, and a review turn still queued unread is taken off the queue
 * (`withdrawReviewTurns`): the door would refuse whatever it answered. The delivery's wake stays
 * DELIVERED, so should the standard come back to the one the revision quotes, the evidence queue
 * reads the unread delivery as owed and sends it again.
 *
 * Each message is one turn keyed by (reader, evidence id, standard digest), so a trigger that fires
 * again with the same standard writes nothing new, and a standard that changes again is said again.
 * Neither revives a conversation that has ended. No timer is involved: this is delivery, not a clock.
 */

/** The standard a task is held to now, as the run's next revision will be bound to it. */
export type HeldStandard =
  | { kind: 'PROJECT_CRITERION'; key: string; text: string }
  | { kind: 'TASK_ACCEPTANCE_CRITERIA'; key: string; text: string }
  /** It declared a project criterion that has since been deleted: there is no standard until the
   *  declaration changes (`heldToProjectCriterion`). `own` is what taking the declaration back
   *  would hold it to: its own acceptance criteria, keyed by its public id, or null when blank. */
  | { kind: 'DECLARED_CRITERION_DELETED'; own: { key: string; text: string } | null }
  | { kind: 'NONE' };

/** What made the revision undecidable, as far as the words need it. */
export type UndecidableCause =
  | {
    kind: 'MOVED';
    from: { id: string; title: string };
    /** The source's criterion the move took back from the task, if it declared one. */
    withdrawnCriterionDefinitionId: string | null;
  }
  /** A criterion of the task's project was reworded, or the one it declared was deleted. */
  | { kind: 'CRITERIA_CHANGED' };

/** Who can move an undecidable revision now, in the order §3.2 asks. */
export type UndecidableAddressee = 'RUN' | 'COORDINATOR' | 'OWNER';

/** The one action the owner's pending row can offer for an undecidable revision. */
export const RESTART_TASK_ACTION = 'RESTART_TASK';
export type OwnerEvidenceAction = typeof RESTART_TASK_ACTION;

/** What both messages say about the revision. */
export interface UndecidableEvidence {
  taskId: string;
  title: string;
  revision: string;
  /** The project the task is in now. */
  project: { id: string; title: string } | null;
  cause: UndecidableCause;
  /** The standard the revision is bound to (the server's snapshot, or an old client's quote). */
  quoted: { key: string; text: string } | null;
  /** The decision door's own reason it would refuse the revision (`criterionStandingRefusal`). */
  doorReason: string;
  standard: HeldStandard;
}

export interface UndecidableEvidenceOutcome {
  evidenceId: string;
  standardDigest: string;
  /** The live runs that have the steer on their conversation (written now or before). */
  runsTold: string[];
  /** Whether the Automatic coordinator has the notice on its conversation. */
  coordinatorTold: boolean;
}

const logger = new Logger('UndecidableEvidence');

function comparable(text: string): string {
  return text.replace(/\r\n?/g, '\n').normalize('NFC').trim();
}

/**
 * The standard the task is held to right now: `taskStandard`, the very function a submission binds
 * with, so the words a run is told are the words its next revision will be bound to.
 */
export async function heldStandard(
  tx: PrismaTypes.TransactionClient,
  task: CriterionStandingTask & { id: string },
): Promise<HeldStandard> {
  const bound = await taskStandard(tx, task, task.id);
  if (bound) {
    return heldToProjectCriterion(task)
      ? { kind: 'PROJECT_CRITERION', key: bound.key, text: bound.text }
      : { kind: 'TASK_ACCEPTANCE_CRITERIA', key: bound.key, text: bound.text };
  }
  if (heldToProjectCriterion(task) && task.criterionDefinitionId === null) {
    const own = task.acceptanceCriteria !== null && comparable(task.acceptanceCriteria) !== ''
      ? { key: uuidToBase62(task.id), text: task.acceptanceCriteria }
      : null;
    return { kind: 'DECLARED_CRITERION_DELETED', own };
  }
  return { kind: 'NONE' };
}

/** The digest the "exactly once" key is taken over: the standard's kind, key and wording. */
export function standardDigest(standard: HeldStandard): string {
  const parts = standard.kind === 'PROJECT_CRITERION' || standard.kind === 'TASK_ACCEPTANCE_CRITERIA'
    ? [standard.kind, standard.key, comparable(standard.text)]
    : standard.kind === 'DECLARED_CRITERION_DELETED' && standard.own
      ? [standard.kind, standard.own.key, comparable(standard.own.text)]
      : [standard.kind];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** The turn one of these messages is written as: one per reader, revision and standard. */
export function undecidableEvidenceTurnId(
  reader: 'run' | 'coordinator',
  evidenceId: string,
  digest: string,
): string {
  return derivedUuid(`undecidable-evidence:v1:${reader}:${evidenceId}:${digest}`);
}

function projectName(project: { id: string; title: string }): string {
  return `“${project.title}” (${uuidToBase62(project.id)})`;
}

function inProject(e: UndecidableEvidence): string {
  return e.project ? ` in project ${projectName(e.project)}` : '';
}

/** Why the revision cannot be decided, in one clause. */
function whyUndecidable(e: UndecidableEvidence): string {
  if (e.cause.kind !== 'MOVED') return e.doorReason;
  if (!e.quoted) return 'it quotes no criterion';
  const quotedId = definitionIdFromKey(e.quoted.key);
  const withdrawn = e.cause.withdrawnCriterionDefinitionId;
  if (quotedId !== null && withdrawn !== null && quotedId.toLowerCase() === withdrawn.toLowerCase()) {
    return `the criterion it quotes (key ${e.quoted.key}) belongs to project ${projectName(e.cause.from)}, `
      + `and the task's declaration of it was taken back by the move`;
  }
  return `the criterion it quotes (key ${e.quoted.key}) is not the standard this task has to meet`
    + (e.project ? ` in project “${e.project.title}”` : '');
}

/** The standard the next revision is held to, as lines a run can read its work against. */
function standardLines(e: UndecidableEvidence): string {
  const standard = e.standard;
  if (standard.kind === 'PROJECT_CRITERION') {
    return `The standard this task is held to now is the criterion it declares${inProject(e)}:\n`
      + `key: ${standard.key}\ntext: “${standard.text}”`;
  }
  if (standard.kind === 'TASK_ACCEPTANCE_CRITERIA') {
    return (e.project
      ? `This task declares no criterion${inProject(e)}, so it is held to its own acceptance criteria:\n`
      : 'This task is held to its own acceptance criteria:\n')
      + `key: ${standard.key}\ntext: “${standard.text}”`;
  }
  if (standard.kind === 'DECLARED_CRITERION_DELETED') {
    return 'The criterion this task declared no longer exists, so it has no standard until its declaration changes: '
      + 'first declare the criterion it serves now with task_update (criterionKey), or take the declaration back '
      + '(criterionKey: null) so it is held to its own acceptanceCriteria'
      + (standard.own ? `, which read:\nkey: ${standard.own.key}\ntext: “${standard.own.text}”\n` : ' (it has none yet, so write them down first)')
      + (standard.own ? 'Then submit again against the standard you chose.' : ', then submit again against that.');
  }
  return `This task neither declares a criterion${inProject(e)} nor has acceptance criteria of its own, so there is no standard to meet yet: `
    + 'first declare the criterion it serves with task_update (criterionKey), or write down its acceptanceCriteria, then submit again against that.';
}

/** To each live run of the task: the revision it submitted cannot be decided, why, and against what to file again. */
export function runMessage(e: UndecidableEvidence): string {
  const taskKey = uuidToBase62(e.taskId);
  const lead = e.cause.kind === 'MOVED' && e.project
    ? `[Task “${e.title}” moved to project “${e.project.title}”: evidence revision ${e.revision} has to be submitted again against the standard there]\n\n`
      + `The account owner confirmed moving task ${taskKey} from project ${projectName(e.cause.from)} to project ${projectName(e.project)}; `
      + 'this session moved with the task and can go on writing as usual.\n\n'
      + `Revision ${e.revision} of the task's completion evidence has not been decided yet, and it cannot be decided in `
      + `project “${e.project.title}”: ${whyUndecidable(e)}.`
    : `[Task “${e.title}”: evidence revision ${e.revision} can no longer be decided and has to be submitted again]\n\n`
      + `Revision ${e.revision} of the completion evidence of task ${taskKey} has not been decided yet, and the standard it was `
      + `bound to changed after it was submitted: ${whyUndecidable(e)}.`;
  return (
    `${lead} The decision door would refuse every answer to it (${CRITERION_MOVED_CODE}), `
    + 'so it was not handed to anyone to decide.\n\n'
    + `${standardLines(e)}\n\n`
    + `Then submit a new revision with task_evidence_submit (taskId ${taskKey}); the server binds it to the standard the task is held to then, `
    + 'so your evidence has to show that standard is met. '
    + (e.project ? `Project “${e.project.title}” decides it. ` : '')
    + 'The checks in the evidence cite the rows already under this task as usual.'
  );
}

/**
 * To an Automatic project's coordinator: the revision cannot be decided, and whether a run was told.
 * `handedToYou`: a request to decide this revision was written to this conversation before the
 * standard moved, so the notice withdraws it instead of saying it was never handed over.
 */
export function coordinatorMessage(
  e: UndecidableEvidence,
  runSessionIds: readonly string[],
  handedToYou = false,
): string {
  const taskKey = uuidToBase62(e.taskId);
  const standard = e.standard;
  const standardLine = standard.kind === 'NONE'
    ? 'This task neither declares a criterion here nor has acceptance criteria of its own, so there is no standard to meet yet: '
      + `first declare a criterion for it (task_update's criterionKey, taskId ${taskKey}) or write down its acceptanceCriteria.`
    : standard.kind === 'DECLARED_CRITERION_DELETED'
      ? 'The criterion it declared no longer exists, so it has no standard until its declaration changes: declare the criterion '
        + `it serves now (task_update's criterionKey, taskId ${taskKey}), or take the declaration back (criterionKey: null) so it is `
        + 'held to its own acceptanceCriteria'
        + (standard.own ? `: key ${standard.own.key}, text “${standard.own.text}”.` : ' (it has none yet).')
      : `It has to be submitted again against this standard: key ${standard.key}, text “${standard.text}”.`;
  const runs = runSessionIds.length > 0
    ? `The task's running sessions (${runSessionIds.map((id) => uuidToBase62(id)).join(', ')}) have been told the same and asked to submit it again.`
    : 'This task has no running session now, so nobody will submit it again on their own. It is yours to act on: '
      + `start the task again (task_start, taskId ${taskKey}) so a new run submits a revision against that standard, `
      + 'or change the standard itself. Nothing restarts it by itself.';
  const notYours = handedToYou
    ? `Earlier you were asked to decide revision ${e.revision}; that request is withdrawn (taken off your queue if you had not `
      + `read it yet): the standard it is bound to moved, so the decision door will refuse any answer to it `
      + `(${CRITERION_MOVED_CODE}). Do not decide it: ${whyUndecidable(e)}.`
    : `so it was not handed to you to decide: ${whyUndecidable(e)}.`;
  const lead = e.cause.kind === 'MOVED'
    ? `[Task “${e.title}” moved into this project with an evidence revision to be submitted again]\n\n`
      + `The account owner confirmed moving task ${taskKey} from project ${projectName(e.cause.from)} into this project. `
      + `Revision ${e.revision} of its completion evidence has not been decided yet, and it cannot be decided here`
      + (handedToYou ? `. ${notYours}` : `, ${notYours}`)
    : `[Task “${e.title}”: evidence revision ${e.revision} can no longer be decided and has to be submitted again]\n\n`
      + `This project's acceptance criteria changed after revision ${e.revision} of the completion evidence of task ${taskKey} `
      + `was submitted, and it cannot be decided now`
      + (handedToYou ? `. ${notYours}` : `, ${notYours}`);
  return (
    `${lead}\n\n${standardLine}\n${runs}\nOnce a new revision is submitted, it is handed to you to decide as usual.\n\n`
    + 'This is a notice, not an interruption: the turn you are running is not interrupted by it, and you are reading it after that turn ended, '
    + 'so go by the state you have just read from the database — the new revision may already have been submitted.'
  );
}

/** Where one task's undecidable revision stands. */
export interface UndecidablePlace {
  addressee: UndecidableAddressee;
  /** The task's runs whose conversations have not ended. */
  liveRunIds: Set<string>;
  /** The project's coordinator conversation, Automatic or not, if it has one. */
  coordinatorSessionId: string | null;
}

/**
 * Who can move each of these tasks' undecidable revisions now — a live run, else an Automatic
 * project's live coordinator, else the owner — with the live runs by task. The pending read places
 * rows by it and the Restart press is allowed by it, so the two cannot disagree; it is the same
 * order `tellEvidenceUndecidable` delivers in.
 */
export async function undecidableAddressees(
  tx: PrismaTypes.TransactionClient,
  ownerId: string,
  tasks: ReadonlyArray<{ id: string; projectId: string | null }>,
): Promise<Map<string, UndecidablePlace>> {
  const result = new Map<string, UndecidablePlace>();
  if (tasks.length === 0) return result;
  const runs = await tx.session.findMany({
    where: { ownerId, taskId: { in: tasks.map((task) => task.id) } },
    select: { id: true, taskId: true, ...SESSION_ENDING_SELECT },
  });
  const projectIds = [...new Set(tasks.flatMap((task) => (task.projectId ? [task.projectId] : [])))];
  const projects = projectIds.length === 0 ? [] : await tx.project.findMany({
    where: { ownerId, id: { in: projectIds } },
    select: {
      id: true,
      coordinatorEnabled: true,
      coordinatorSessionId: true,
      coordinatorSession: { select: SESSION_ENDING_SELECT },
    },
  });
  const automatic = new Set(projects.flatMap((project) => (
    project.coordinatorEnabled && project.coordinatorSession && !sessionHasEnded(project.coordinatorSession)
      ? [project.id]
      : []
  )));
  for (const task of tasks) {
    const liveRunIds = new Set(runs.flatMap((run) => (
      run.taskId === task.id && !sessionHasEnded(run) ? [run.id] : []
    )));
    const addressee: UndecidableAddressee = liveRunIds.size > 0
      ? 'RUN'
      : task.projectId && automatic.has(task.projectId) ? 'COORDINATOR' : 'OWNER';
    const coordinatorSessionId = task.projectId
      ? projects.find((project) => project.id === task.projectId)?.coordinatorSessionId ?? null
      : null;
    result.set(task.id, { addressee, liveRunIds, coordinatorSessionId });
  }
  return result;
}

/** The task and latest revision the entry reads, and the pending read and Restart press share. */
export async function unansweredUndecidableRevision(
  tx: PrismaTypes.TransactionClient,
  ownerId: string,
  taskId: string,
) {
  const task = await tx.task.findFirst({
    where: {
      id: taskId,
      ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
    },
    select: {
      id: true,
      title: true,
      projectId: true,
      criterionDefinitionId: true,
      criterionRevision: true,
      acceptanceCriteria: true,
      project: { select: { id: true, title: true } },
      completionEvidence: {
        orderBy: { revision: 'desc' },
        take: 1,
        select: {
          id: true,
          revision: true,
          criterionRevision: true,
          evidenceDigest: true,
          evidence: true,
          decisions: { select: { id: true }, take: 1 },
        },
      },
    },
  });
  const [latest] = task?.completionEvidence ?? [];
  if (!task || !latest || latest.decisions.length > 0) return null;
  const standing = await criterionStandingRefusal(tx, task, latest.evidence);
  if (standing === null) return null;
  return { task, latest, standing };
}

/**
 * The shared entry: called after a trigger's commit, for one task. Says nothing when the task is not
 * EVIDENCE_JUDGMENT, has settled, has no evidence, its latest revision is answered, or that revision
 * is decidable after all. A failure to write one message is logged and never raised: the trigger
 * committed, and what a lost message leaves is the owner's read and the orphan sweep.
 */
export async function tellEvidenceUndecidable(
  prisma: PrismaTypes.TransactionClient,
  sessions: Pick<SessionsService, 'createTurn' | 'cancelQueuedTurn'>,
  input: { ownerId: string; taskId: string; cause: UndecidableCause },
): Promise<UndecidableEvidenceOutcome | null> {
  const found = await unansweredUndecidableRevision(prisma, input.ownerId, input.taskId);
  if (!found) return null;
  const { task, latest, standing } = found;
  const standard = await heldStandard(prisma, task);
  const digest = standardDigest(standard);
  const evidence: UndecidableEvidence = {
    taskId: task.id,
    title: task.title,
    revision: latest.revision.toString(),
    project: task.project ? { id: task.project.id, title: task.project.title } : null,
    cause: input.cause,
    quoted: quotedCriterion(latest.evidence),
    doorReason: standing.reason,
    standard,
  };

  const [placed] = (await undecidableAddressees(prisma, input.ownerId, [task])).values();
  const runsTold: string[] = [];
  for (const runId of [...placed!.liveRunIds].sort()) {
    if (await tell(sessions, input.ownerId, runId, {
      clientTurnId: undecidableEvidenceTurnId('run', latest.id, digest),
      content: runMessage(evidence),
      steerIfLive: true,
    })) runsTold.push(runId);
  }

  // The coordinator of an Automatic project, as the evidence door itself would reach it: a project
  // whose switch is off is told no evidence fact, and an ended conversation is not revived.
  let coordinatorTold = false;
  if (task.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: task.projectId, ownerId: input.ownerId },
      select: { coordinatorEnabled: true, coordinatorSessionId: true, coordinatorSession: { select: SESSION_ENDING_SELECT } },
    });
    if (project?.coordinatorEnabled && project.coordinatorSessionId && project.coordinatorSession
      && !sessionHasEnded(project.coordinatorSession)) {
      const handed = await withdrawReviewTurns(prisma, sessions, input.ownerId, {
        taskId: task.id,
        projectId: task.projectId,
        coordinatorSessionId: project.coordinatorSessionId,
        revision: {
          revision: latest.revision.toString(),
          criterionRevision: latest.criterionRevision,
          evidenceDigest: latest.evidenceDigest,
        },
      });
      coordinatorTold = await tell(sessions, input.ownerId, project.coordinatorSessionId, {
        clientTurnId: undecidableEvidenceTurnId('coordinator', latest.id, digest),
        content: coordinatorMessage(evidence, runsTold, handed),
        steerIfLive: false,
      });
    }
  }
  return { evidenceId: latest.id, standardDigest: digest, runsTold, coordinatorTold };
}

/**
 * Whether this revision was delivered to this coordinator conversation to decide
 * (`CompletionEvidenceProducer`: a DELIVERED wake under the revision's own key, or the key a
 * confirmed move handed it over under), and, if so, take each of its review turns still queued
 * unread off the queue — the door would refuse whatever the coordinator answered. A turn already
 * taken up is left: the notice that follows it withdraws the request in words. Read off the wake
 * rather than the turn, so a repeat of the trigger, after the turn is gone, says the same thing.
 */
async function withdrawReviewTurns(
  prisma: PrismaTypes.TransactionClient,
  sessions: Pick<SessionsService, 'cancelQueuedTurn'>,
  ownerId: string,
  input: {
    taskId: string;
    projectId: string;
    coordinatorSessionId: string;
    revision: { revision: string; criterionRevision: string; evidenceDigest: string };
  },
): Promise<boolean> {
  const wakes = await prisma.projectCoordinatorWake.findMany({
    where: {
      idempotencyKey: {
        in: [
          completionEvidenceWakeKey(input.taskId, input.revision),
          completionEvidenceWakeKey(input.taskId, input.revision, input.projectId),
        ],
      },
      projectId: input.projectId,
      sessionId: input.coordinatorSessionId,
      status: 'DELIVERED',
    },
    select: { delivery: true },
  });
  if (wakes.length === 0) return false;
  const clientTurnIds = wakes.flatMap((wake) => {
    const record = deliveryRecordOf(wake.delivery);
    return record ? [record.clientTurnId] : [];
  });
  const queued = clientTurnIds.length === 0 ? [] : await prisma.conversationTurn.findMany({
    where: { sessionId: input.coordinatorSessionId, clientTurnId: { in: clientTurnIds }, status: 'PENDING' },
    select: { id: true },
  });
  for (const turn of queued) {
    try {
      await sessions.cancelQueuedTurn(ownerId, input.coordinatorSessionId, turn.id);
    } catch (error) {
      // Taken up in the meantime, or the conversation ended: the notice still withdraws it in words.
      logger.log(`review turn ${turn.id} on session ${input.coordinatorSessionId} was not withdrawn: `
        + `${error instanceof Error ? error.message : error}`);
    }
  }
  return true;
}

/**
 * One message, as a platform turn under its key. True when it is on the conversation (a replay of
 * the same key included); false when the conversation refused it for a state of the world (gone,
 * ended, busy being written, unable to run). A fault is logged and read as not written.
 */
async function tell(
  sessions: Pick<SessionsService, 'createTurn'>,
  ownerId: string,
  sessionId: string,
  turn: { clientTurnId: string; content: string; steerIfLive: boolean },
): Promise<boolean> {
  try {
    await sessions.createTurn(ownerId, sessionId, {
      clientTurnId: turn.clientTurnId,
      content: turn.content,
      intent: 'NEXT_TURN',
    }, turn.steerIfLive ? { steerIfLive: true } : undefined);
    return true;
  } catch (error) {
    if (
      error instanceof NotFoundException
      || error instanceof ConflictException
      || error instanceof ForbiddenException
      || error instanceof BadRequestException
    ) {
      logger.log(`undecidable-evidence message to session ${sessionId} was not written: ${error.message}`);
      return false;
    }
    logger.warn(`undecidable-evidence message to session ${sessionId} failed: `
      + `${error instanceof Error ? error.message : error}`);
    return false;
  }
}

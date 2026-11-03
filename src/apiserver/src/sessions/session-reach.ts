import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PermissionMode, uuidToBase62 } from '@orbit/shared';
import { isWiderThanStarter, resolvePermissionMode, widerSessionRefusal } from '../common/permission-mode';

/**
 * What a session may do to another session that already exists: give it a turn, or end, complete,
 * delete or merge it (docs/session-request-reply-contract.md §2.5).
 *
 * A session runs a turn in its own mode, whoever asked for the turn. So a session that may do less than
 * another reaches it only as far as this says, by the comparison that holds a session to what it may
 * start (`isWiderThanStarter`), over the stored mode of both, a null one read as the account's default:
 *
 *   | The caller's stored mode         | Target no wider | Target wider, directly related | Target wider, unrelated |
 *   |----------------------------------|-----------------|--------------------------------|-------------------------|
 *   | Auto, Bypass                     | allowed         | allowed                        | allowed                 |
 *   | Default, Accept Edits, Don't Ask | allowed         | allowed, the message says so   | refused                 |
 *   | Plan                             | allowed         | refused                        | refused                 |
 *
 * The check is here and not in a tool, so an MCP call, the CLI and a bare HTTP request meet the same one.
 * `session_reply` is not held to it: the wider session asked first. A session acting on itself is not
 * either, and neither is anything with no session behind it: the owner's own doors and the platform's
 * deliveries never come through here, and a credential with no session in it has no mode to compare.
 *
 * Direct relations are read from the server's own records when the call is made, and nothing a caller
 * sends says what they are (`directlyRelated`).
 *
 * The run of a verification task is held to one rule more, whatever the sender's mode: only its project's
 * coordinator and the judgment sessions opened for that project may write to it, because what it finds is
 * worth only as much as nobody having told it what to find.
 */

/** What a caller is doing to the target. `words` finishes "may not ...". */
const ACTS = {
  message: { words: 'send it a message', carriesMessage: true },
  interruptWithMessage: { words: 'interrupt it with a message', carriesMessage: true },
  interrupt: { words: 'interrupt it', carriesMessage: false },
  end: { words: 'end it', carriesMessage: false },
  complete: { words: 'complete it', carriesMessage: false },
  delete: { words: 'delete it', carriesMessage: false },
  merge: { words: 'merge it', carriesMessage: false },
  resumeRun: { words: 'hand it this task', carriesMessage: false },
} as const;

export type SessionAct = keyof typeof ACTS;

export const VERIFIER_MESSAGE_REFUSED_CODE = 'VERIFIER_MESSAGE_REFUSED';

type ReachDb = Pick<
  Prisma.TransactionClient,
  'session' | 'project' | 'projectCoordinatorWake' | 'sessionRequest' | 'conversationTurn'
>;

const REACH_SELECT = {
  id: true,
  permissionMode: true,
  engine: true,
  parentSessionId: true,
  owner: { select: { preferences: true } },
  task: { select: { projectId: true, verifiesTaskId: true, creatorSessionId: true } },
} as const;

interface ReachRow {
  id: string;
  permissionMode: string | null;
  engine: string | null;
  parentSessionId: string | null;
  owner: { preferences: unknown };
  task: { projectId: string | null; verifiesTaskId: string | null; creatorSessionId: string | null } | null;
}

/** Whether this session coordinates that project: its coordinator, or a judgment session a wake opened for it. */
async function coordinatesProject(
  db: ReachDb,
  ownerId: string,
  sessionId: string,
  projectId: string,
): Promise<boolean> {
  const standing = await db.project.findFirst({
    where: { id: projectId, ownerId, coordinatorSessionId: sessionId },
    select: { id: true },
  });
  if (standing) return true;
  const opened = await db.projectCoordinatorWake.findFirst({
    where: { projectId, sessionId, status: 'SESSION_OPENED' },
    select: { id: true },
  });
  return opened != null;
}

/**
 * Direct, and read from nothing a caller wrote: a run and its project's coordinator or a judgment session
 * opened for that project; a parent and its child; the session that filed a task and that task's run; and
 * a target with an open request waiting on the caller. The first three go both ways. The last goes one
 * way, because only the session waiting is waiting.
 */
async function directlyRelated(db: ReachDb, ownerId: string, caller: ReachRow, target: ReachRow): Promise<boolean> {
  if (caller.parentSessionId === target.id || target.parentSessionId === caller.id) return true;
  if (caller.task?.creatorSessionId === target.id || target.task?.creatorSessionId === caller.id) return true;
  if (caller.task?.projectId && await coordinatesProject(db, ownerId, target.id, caller.task.projectId)) return true;
  if (target.task?.projectId && await coordinatesProject(db, ownerId, caller.id, target.task.projectId)) return true;
  const waiting = await db.sessionRequest.findFirst({
    where: { ownerId, fromSessionId: target.id, toSessionId: caller.id, state: 'OPEN' },
    select: { id: true },
  });
  return waiting != null;
}

function verifierMessageRefusal(target: ReachRow): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: VERIFIER_MESSAGE_REFUSED_CODE,
    message:
      `Session ${uuidToBase62(target.id)} is the run of a verification task, which takes messages only from its `
      + "project's coordinator and the judgment sessions opened for that project. Nothing was sent. Tell the coordinator "
      + 'what it should know with project_send, or ask the account owner.',
  });
}

/** What a caller of this mode can do instead, for the refusal. */
function nextStep(callerMode: string): string {
  return callerMode === PermissionMode.PLAN
    ? 'Write what you want done into your plan, or ask the account owner to switch this session\'s mode. If that '
      + 'session is waiting on your answer, session_reply still reaches it.'
    : 'The two are not directly related. Ask your own coordinator to do this, with project_send if this session runs '
      + 'a task in a project, or ask the account owner to switch this session\'s mode.';
}

/**
 * Refuse what the rule above refuses. Answers whether the caller is the narrower of the two, which is what
 * makes a message it goes on to send say so (session-message.ts) when that message has no block of its own.
 *
 * `clientTurnId` is the key of a message sent by `createTurn` or `resume`. A retry of one already filed from this
 * session is answered with the turn it filed, whatever has changed since: a committed operation owns its key, so
 * only a new one is held to this, and both of those verbs write nothing for a key they already hold. Read only when
 * about to refuse, so it costs an ordinary send nothing. An interrupt passes none: its verb acts on any key it has
 * no interrupt under, so a message filed under that key says nothing about whether this call is a retry.
 *
 * A caller or a target this account does not have is left to the door, whose own answer that is.
 */
export async function assertSessionMayReach(
  db: ReachDb,
  ownerId: string,
  callerSessionId: string,
  targetSessionId: string,
  act: SessionAct,
  clientTurnId?: string,
): Promise<{ narrower: boolean }> {
  if (callerSessionId === targetSessionId) return { narrower: false };
  const rows: ReachRow[] = await db.session.findMany({
    where: { id: { in: [callerSessionId, targetSessionId] }, ownerId },
    select: REACH_SELECT,
  });
  const caller = rows.find((row) => row.id === callerSessionId);
  const target = rows.find((row) => row.id === targetSessionId);
  if (!caller || !target) return { narrower: false };

  const refuse = async (refusal: ForbiddenException): Promise<{ narrower: boolean }> => {
    if (clientTurnId) {
      const filed = await db.conversationTurn.findFirst({
        where: { sessionId: target.id, clientTurnId, senderSessionId: caller.id },
        select: { id: true },
      });
      if (filed) return { narrower: false };
    }
    throw refusal;
  };

  if (
    ACTS[act].carriesMessage
    && target.task?.verifiesTaskId
    && !(target.task.projectId && await coordinatesProject(db, ownerId, caller.id, target.task.projectId))
  ) {
    return refuse(verifierMessageRefusal(target));
  }

  const callerMode = resolvePermissionMode(caller.permissionMode, caller.owner);
  const targetMode = resolvePermissionMode(target.permissionMode, target.owner);
  if (!isWiderThanStarter({ mode: callerMode, engine: caller.engine }, targetMode, target.engine)) {
    return { narrower: false };
  }
  if (callerMode !== PermissionMode.PLAN && await directlyRelated(db, ownerId, caller, target)) {
    return { narrower: true };
  }
  return refuse(widerSessionRefusal(
    callerMode,
    uuidToBase62(target.id),
    targetMode,
    target.engine,
    ACTS[act].words,
    nextStep(callerMode),
  ));
}

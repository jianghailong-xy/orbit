import { PermissionMode } from '@orbit/shared';
import { isWiderThanStarter, runningPermissionMode } from '../common/permission-mode';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The owner's rule since 2026-11-19: a session that files only a few tasks is not stopped on a card
 * for each of them. While the tasks a session has created, counted with the ones this card would
 * add, stay within the account's allowance, the create card is written already answered — the same
 * shape as the coordinator's rules beside it (`unstarted-project-create.ts`). The card that would go
 * past the allowance, and every card after it, is asked as before.
 *
 * The allowance is the account's `cardFreeTaskCreates` preference (since 2026-11-20): how many tasks
 * a session may create without a card, DEFAULT_CARD_FREE_TASK_CREATES when unset, 0 to ask for every
 * one. A stored value that is not a whole number from 0 to MAX_CARD_FREE_TASK_CREATES reads as unset.
 *
 * Counted from `task.creator_session_id`, so every task the session created counts, however its card
 * was answered: a session that already filed five on the owner's say-so has three left, not eight.
 * Except, since 2026-11-26 (the owner's rule), the tasks a coordinator filed into its own project
 * before that project started: the start card reviews those (`unstarted-project-create.ts`), so they
 * take nothing from the allowance, and a coordinator that filed a plan of twelve still has its eight.
 *
 * The allowance answers for a session that may start work in Auto. When Auto is wider than the
 * session's running mode, the card goes to a person, as in `coordinatorCreateAllowedBy`.
 *
 * Only task creates — `orbit_task_create` and `orbit_task_batch`. Anything this cannot read answers
 * null and the card is raised.
 */
export const DEFAULT_CARD_FREE_TASK_CREATES = 8;
export const MAX_CARD_FREE_TASK_CREATES = 50;

/** What an approval answered by the allowance is recorded with; `decided_by_id` stays null beside it. */
export const SESSION_CREATE_ALLOWANCE_MESSAGE = "within the account's card-free task creates for a session: no card needed";

/** How many tasks a session of this account may create without a card. */
export function cardFreeTaskCreates(preferences: unknown): number {
  const value = (preferences as { cardFreeTaskCreates?: unknown } | null)?.cardFreeTaskCreates;
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_CARD_FREE_TASK_CREATES
    ? (value as number)
    : DEFAULT_CARD_FREE_TASK_CREATES;
}

const TASK_CREATE_CARD = 'orbit_task_create';
const TASK_BATCH_CARD = 'orbit_task_batch';

export async function sessionCreateAllowedBy(
  prisma: Pick<PrismaService, 'session' | 'task' | 'project'>,
  session: { id: string; ownerId: string },
  toolName: string,
  input: unknown,
): Promise<string | null> {
  try {
    const adding = itemCount(toolName, input);
    if (adding === 0) return null;
    const row = await prisma.session.findFirst({
      where: { id: session.id, ownerId: session.ownerId },
      select: { permissionMode: true, actualPermissionMode: true, engine: true, owner: { select: { preferences: true } } },
    });
    if (!row) return null;
    // R3: the mode the session is actually running in.
    const starter = { mode: runningPermissionMode(row, row.owner), engine: row.engine ?? null };
    if (isWiderThanStarter(starter, PermissionMode.AUTO, null)) return null;
    const coordinated = await prisma.project.findMany({
      where: { coordinatorSessionId: session.id, ownerId: session.ownerId },
      select: { id: true, startedAt: true },
    });
    const filedBeforeStart = coordinated.map((p) =>
      p.startedAt === null ? { projectId: p.id } : { projectId: p.id, createdAt: { lt: p.startedAt } },
    );
    // `projectId: null` is spelled out: NOT (project_id = …) is NULL, not true, for a task in no project.
    const created = await prisma.task.count({
      where: {
        creatorSessionId: session.id,
        ...(filedBeforeStart.length > 0 ? { OR: [{ projectId: null }, { NOT: { OR: filedBeforeStart } }] } : {}),
      },
    });
    return created + adding <= cardFreeTaskCreates(row.owner?.preferences) ? SESSION_CREATE_ALLOWANCE_MESSAGE : null;
  } catch {
    return null;
  }
}

/** How many tasks a create card would add; 0 when it is not a create card or cannot be read. */
function itemCount(toolName: string, input: unknown): number {
  if (toolName === TASK_CREATE_CARD) return 1;
  if (toolName !== TASK_BATCH_CARD) return 0;
  const tasks = typeof input === 'object' && input !== null ? (input as { tasks?: unknown }).tasks : undefined;
  return Array.isArray(tasks) ? tasks.length : 0;
}

import { isWiderThanStarter, resolvePermissionMode } from '../common/permission-mode';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The owner's rule since 2026-11-19: a session that files only a few tasks is not stopped on a card
 * for each of them. While the tasks a session has created, counted with the ones this card would
 * add, stay under SESSION_CREATE_ALLOWANCE, the create card is written already answered — the same
 * shape as the coordinator's rules beside it (`unstarted-project-create.ts`). The card past the
 * allowance, and every card after it, is asked as before.
 *
 * Counted from `task.creator_session_id`, so every task the session created counts, however its card
 * was answered: a session that already filed five on the owner's say-so has two left, not seven.
 *
 * The allowance answers for a session that may start what the account's default starts: what it files
 * runs in that default, so a session whose stored mode is narrower (Plan, Ask before edits under an
 * Auto default) is asked, and a person decides — the rule `coordinatorCreateAllowedBy` applies.
 *
 * Only task creates — `orbit_task_create` and `orbit_task_batch`. Anything this cannot read answers
 * null and the card is raised.
 */
export const SESSION_CREATE_ALLOWANCE = 8;

/** What an approval answered by the allowance is recorded with; `decided_by_id` stays null beside it. */
export const SESSION_CREATE_ALLOWANCE_MESSAGE = `fewer than ${SESSION_CREATE_ALLOWANCE} tasks created in this session: no card needed`;

const TASK_CREATE_CARD = 'orbit_task_create';
const TASK_BATCH_CARD = 'orbit_task_batch';

export async function sessionCreateAllowedBy(
  prisma: Pick<PrismaService, 'session' | 'task'>,
  session: { id: string; ownerId: string },
  toolName: string,
  input: unknown,
): Promise<string | null> {
  try {
    const adding = itemCount(toolName, input);
    if (adding === 0) return null;
    const row = await prisma.session.findFirst({
      where: { id: session.id, ownerId: session.ownerId },
      select: { permissionMode: true, engine: true, owner: { select: { preferences: true } } },
    });
    if (!row) return null;
    const starter = { mode: resolvePermissionMode(row.permissionMode, row.owner), engine: row.engine ?? null };
    if (isWiderThanStarter(starter, resolvePermissionMode(null, row.owner), null)) return null;
    const created = await prisma.task.count({ where: { creatorSessionId: session.id } });
    return created + adding < SESSION_CREATE_ALLOWANCE ? SESSION_CREATE_ALLOWANCE_MESSAGE : null;
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

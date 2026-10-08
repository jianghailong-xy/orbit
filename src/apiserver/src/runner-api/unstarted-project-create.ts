import { ProjectStatus } from '@prisma/client';
import { toUuid } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * The owner's rule since 2026-09-29: in a project nobody has started yet, the tasks its coordinator
 * files are not put in front of the owner one card at a time. The start card shows them all — the
 * plan it asks the owner to start — and nothing in a project runs before its owner starts it, so a
 * card per create would ask the same question twice, the first time without the plan around it.
 *
 * And since 2026-10-08, in a project whose Automatic is on: Automatic is the owner's standing answer
 * that the coordinator decides for them, and what work the project needs next is one of those
 * decisions. A card per create stopped the coordinator's turn on a question the owner had already
 * answered. A pause does not change it: a pause holds what starts, not what is filed.
 *
 * Decided here, at the one door every create card is filed through (`askBeforeCreate` /
 * `askBeforeBatch` in runner-go, from the MCP tools and the CLI alike), so the runner's requests stay
 * exactly what they were and runners already installed get the rule too: the card is written already
 * answered, and the poll that follows reads the answer on its first call.
 *
 * All three facts, or it is asked as before:
 *   - the card is a task create — `orbit_task_create` or `orbit_task_batch`;
 *   - every item NAMES the same project, and that project is OPEN and either not started or
 *     Automatic. An item that names no project is asked even from a coordinator: which project an
 *     unnamed create lands in is the write's own derivation (`project-scope-admission.ts`), and this
 *     door does not re-run it;
 *   - the session asking is that project's coordinator.
 *
 * Returns the message the approval is recorded with, naming which rule answered; null when the card
 * is asked. Best-effort in the one direction that is safe: anything this cannot read — an input of
 * another shape, an id that does not decode, a failed query — answers null, and the card is raised.
 */
export async function coordinatorCreateAllowedBy(
  prisma: Pick<PrismaService, 'project'>,
  session: { id: string; ownerId: string },
  toolName: string,
  input: unknown,
): Promise<string | null> {
  try {
    const projectId = soleNamedProject(toolName, input);
    if (!projectId) return null;
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        ownerId: session.ownerId,
        coordinatorSessionId: session.id,
        status: ProjectStatus.OPEN,
      },
      select: { startedAt: true, coordinatorEnabled: true },
    });
    if (!project) return null;
    if (project.startedAt === null) return START_CARD_REVIEWS_MESSAGE;
    return project.coordinatorEnabled ? AUTOMATIC_COORDINATOR_DECIDES_MESSAGE : null;
  } catch {
    return null;
  }
}

/**
 * What an approval allowed by the start card's rule is recorded with. `decided_by_id` stays null
 * beside it: that column is the person who answered, and only the owner's own decision writes it —
 * nobody answered this one, a platform rule did, and the message is where the row says which.
 */
export const START_CARD_REVIEWS_MESSAGE = 'project not started: the start card reviews these';

/** The same record for a create the project's Automatic answers: its coordinator decides it. */
export const AUTOMATIC_COORDINATOR_DECIDES_MESSAGE = 'project is Automatic: its coordinator decides these';

/** The create cards' tool names, as runner-go's `askBeforeCreate` / `askBeforeBatch` file them. */
const TASK_CREATE_CARD = 'orbit_task_create';
const TASK_BATCH_CARD = 'orbit_task_batch';

/** The one project every item of a create card names, as a uuid; null when there is not exactly one. */
function soleNamedProject(toolName: string, input: unknown): string | null {
  const items =
    toolName === TASK_CREATE_CARD
      ? [input]
      : toolName === TASK_BATCH_CARD && isRecord(input) && Array.isArray(input.tasks)
        ? input.tasks
        : [];
  if (items.length === 0) return null;
  const named = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.projectId !== 'string') return null;
    named.add(toUuid(item.projectId));
  }
  return named.size === 1 ? [...named][0] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { SOURCE_FIX_ACTIONS, toUuid } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * A task forked from the session that creates it (docs/task-fork-from-session-design.md §2,
 * docs/project-source-contract.md SR55): what the create doors check about the fork payload, and the
 * five task columns it becomes.
 *
 * The payload is the runner's: `orbit mcp` snapshots its own session's checkout (design §2.2) and
 * posts `{ sessionId, sha, baseHead, includesUncommitted }`. The server cannot see that checkout, so
 * it does not judge the snapshot. It judges who is asking and where the task may run:
 *
 *  - the session named is the CALLING session — the one the request is made from, on the runner
 *    credential it is made with (D6: no session forks another's private edits);
 *  - the task may run only where the snapshot is: the forking session's machine
 *    (FORK_SOURCE_NOT_REACHABLE for an assignee whose workspace is on another one);
 *  - and not in a project with a code binding (FORK_IN_BOUND_PROJECT), whose tasks start from the
 *    project's own line (SR1).
 */

/** The fork as the runner posts it. */
export interface TaskForkInput {
  sessionId: string;
  sha: string;
  baseHead: string;
  includesUncommitted: boolean;
}

/** The five columns migration 0540 adds, as the task's INSERT writes them. */
export interface TaskForkColumns {
  forkSessionId: string;
  forkRunnerId: string;
  forkSha: string;
  forkBaseHead: string;
  forkIncludesUncommitted: boolean;
}

/** SR55's two codes. Both are §10.1 rows; neither is ever written on a session. */
export type TaskForkRefusalCode = 'FORK_SOURCE_NOT_REACHABLE' | 'FORK_IN_BOUND_PROJECT';

/**
 * A fork refusal in the shape the create doors' other refusals take (`{ code, kind, requiredAction,
 * message }`, plus `itemIndex` on the batch door), with §10.1's fixAction as the required action and
 * the facts it was decided on.
 */
export function forkRefusalBody(
  code: TaskForkRefusalCode,
  message: string,
  detail: Record<string, unknown>,
  itemIndex?: number | null,
) {
  return {
    code,
    kind: 'REFUSAL' as const,
    requiredAction: SOURCE_FIX_ACTIONS[code],
    message,
    detail,
    ...(itemIndex !== undefined ? { itemIndex } : {}),
  };
}

const FULL_SHA = /^[0-9a-f]{40}$/;

function uuidOf(id: string): string {
  try {
    return toUuid(id);
  } catch {
    return id;
  }
}

/**
 * The runner door's half of "the calling session": the session the request names in its header must
 * be one this runner credential is running. Without it a runner could name any session of the owner,
 * which is D6's option B. Asked only when the request carries a fork.
 */
export async function assertForkCallerOnRunner(
  prisma: PrismaService,
  ownerId: string,
  runnerId: string,
  sessionId: string | undefined,
): Promise<void> {
  const session = sessionId
    ? await prisma.session.findFirst({
        where: { id: uuidOf(sessionId), ownerId },
        select: { assignedRunnerId: true },
      })
    : null;
  if (!session || session.assignedRunnerId !== runnerId) {
    throw new ForbiddenException(
      'forkFromSession forks the session making this call, and this request does not come from a session '
        + 'this runner is running',
    );
  }
}

/**
 * Check one fork payload against the session making the call and the place the task would land, and
 * return the columns it becomes; null when the item carries no fork.
 *
 * `projectId` is the project the write was ADMITTED into, not the one the caller named: a
 * coordinator that names none still files under the project it coordinates.
 */
export async function resolveTaskFork(
  prisma: PrismaService,
  ownerId: string,
  creatorSessionId: string | undefined,
  item: { fork?: TaskForkInput; assigneeId?: string | null; projectId?: string | null },
  itemIndex: number | null,
): Promise<TaskForkColumns | null> {
  const fork = item.fork;
  if (!fork) return null;
  const where = itemIndex === null ? '' : `tasks[${itemIndex}]: `;
  // D6: only the session making this call. The browser door has no calling session at all, so a fork
  // is refused there too.
  if (!creatorSessionId || uuidOf(fork.sessionId) !== uuidOf(creatorSessionId)) {
    throw new ForbiddenException(
      `${where}fork.sessionId must be the session making this call; a task can only be forked from the session that creates it`,
    );
  }
  const sha = fork.sha.trim().toLowerCase();
  const baseHead = fork.baseHead.trim().toLowerCase();
  if (!FULL_SHA.test(sha) || !FULL_SHA.test(baseHead)) {
    throw new BadRequestException(`${where}fork.sha and fork.baseHead must be full 40-character commit SHAs`);
  }
  // Design §2.2 step 2: the snapshot is HEAD exactly when nothing was uncommitted.
  if (fork.includesUncommitted !== (sha !== baseHead)) {
    throw new BadRequestException(
      `${where}fork.includesUncommitted must be true exactly when fork.sha differs from fork.baseHead`,
    );
  }
  const session = await prisma.session.findFirst({
    where: { id: uuidOf(creatorSessionId), ownerId },
    select: { id: true, assignedRunnerId: true },
  });
  if (!session?.assignedRunnerId) {
    throw new ForbiddenException(`${where}the session making this call runs on no runner, so there is no snapshot to fork`);
  }
  const forkRunnerId = session.assignedRunnerId;
  if (item.projectId) {
    const binding = await prisma.projectCodebase.findFirst({
      where: { projectId: item.projectId, slot: 'primary' },
      select: { id: true },
    });
    if (binding) {
      throw new ConflictException(forkRefusalBody(
        'FORK_IN_BOUND_PROJECT',
        `${where}this task would land in a project with a code binding, and a task there starts from the project's own `
          + "line, not from a session's snapshot. File the fork outside the project, or land the session's work first "
          + 'and file the task without forkFromSession.',
        { projectId: item.projectId, codebaseId: binding.id, forkSessionId: session.id },
        itemIndex,
      ));
    }
  }
  if (item.assigneeId) {
    const workspace = await prisma.workspace.findFirst({
      where: { id: item.assigneeId, ownerId },
      select: { id: true, name: true, runnerId: true },
    });
    if (workspace && workspace.runnerId !== forkRunnerId) {
      throw new ConflictException(forkRefusalBody(
        'FORK_SOURCE_NOT_REACHABLE',
        `${where}the snapshot this task starts from exists only on the machine the forking session runs on, and `
          + `workspace ${workspace.name} is ${workspace.runnerId ? 'on another machine' : 'bound to no machine'}. `
          + 'Assign it to a workspace on the same machine as this session.',
        { assigneeId: workspace.id, runnerId: workspace.runnerId, forkRunnerId, forkSessionId: session.id },
        itemIndex,
      ));
    }
  }
  return {
    forkSessionId: session.id,
    forkRunnerId,
    forkSha: sha,
    forkBaseHead: baseHead,
    forkIncludesUncommitted: fork.includesUncommitted,
  };
}

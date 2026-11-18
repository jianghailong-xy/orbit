import { NotFoundException } from '@nestjs/common';
import {
  WIKI_REPO_PROBE,
  wikiRepoFailureReason,
  wikiRepoProbeAnswer,
  type WikiRepoProbeAnswer,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import {
  readWikiRepoReadiness,
  waitForWikiRepoOp,
  WikiRepoOps,
  WikiRepoOpWaitTimedOut,
} from '../wiki-worker/wiki-repo-ops';

/**
 * The maintenance settings' probe (docs/wiki-repo-tiers-design.md §7.3, contract `maintenance.probe`): which tier the
 * folder of the workspace the owner is about to choose would be read on — asked of its runner with the `probe` kind, which
 * only looks (no fetch, no snapshot) — in the words the form draws under the picker.
 *
 * THE RUNNER IS ASKED ONLY WHEN IT CAN ANSWER. A workspace with no runner, a runner that is not beating, or one that has
 * not declared `wiki-repo-op-probe/v1` is answered at once, from the server's own readiness, as could not check — and Turn
 * on is allowed, since none of those is a fact about the folder. A runner that does not answer within `waitSeconds` is
 * the same. The operation names no job (migration 0530); the sweep closes it if nobody is left to read it.
 */
export async function probeWikiMaintenanceWorkspace(
  prisma: PrismaService,
  input: { ownerId: string; spaceId: string; workspaceId: string; now?: Date; waitMs?: number; pollMs?: number },
): Promise<WikiRepoProbeAnswer> {
  const { ownerId, spaceId, workspaceId } = input;
  const space = await prisma.wikiSpace.findFirst({ where: { id: spaceId, ownerId, deletedAt: null }, select: { id: true } });
  if (!space) throw new NotFoundException('no such wiki space');
  const workspace = await prisma.workspace.findFirst({ where: { id: workspaceId, ownerId, deletedAt: null }, select: { id: true } });
  if (!workspace) throw new NotFoundException('no such workspace');

  const readiness = await readWikiRepoReadiness(prisma, { ownerId, spaceId, workspaceId, now: input.now });
  const where = { dir: readiness.workspace?.workDir ?? null, runner: readiness.runner?.name ?? null };
  const answer = (found: Parameters<typeof wikiRepoProbeAnswer>[1]) => wikiRepoProbeAnswer(workspaceId, found, where, new Date());
  switch (readiness.look) {
    case 'no_workspace': return answer({ reason: 'no_work_dir' });
    case 'runner_missing': return answer({ reason: 'runner_missing' });
    default: break;
  }
  const runner = readiness.runner!;
  if (!runner.online) return answer({ reason: 'runner_offline' });
  if (!runner.probe) return answer({ reason: 'runner_upgrade' });

  const { id } = await new WikiRepoOps(prisma).enqueueWikiRepoOp({
    jobId: null,
    kind: 'probe',
    workspaceId,
    space: { id: spaceId, ownerId },
  });
  try {
    const settled = await waitForWikiRepoOp(prisma, {
      id,
      ownerId,
      timeoutMs: input.waitMs ?? WIKI_REPO_PROBE.waitSeconds * 1000,
      pollMs: input.pollMs ?? 500,
    });
    const tier = settled.result?.tier;
    if (settled.state === 'succeeded' && (tier === 'git' || tier === 'folder')) {
      return answer({ tier, origin: typeof settled.result?.origin === 'string' ? settled.result.origin : null });
    }
    return answer({ reason: wikiRepoFailureReason(settled.result?.reason, settled.error), said: settled.error });
  } catch (error) {
    if (error instanceof WikiRepoOpWaitTimedOut) return answer({ reason: 'op_timeout' });
    throw error;
  }
}

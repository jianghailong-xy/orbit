import { Prisma } from '@prisma/client';
import {
  INTEGRATION_CLAIM_STALE_MS,
  type IntegrationJobKind,
  type IntegrationJobPhase,
  type IntegrationQueueView,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { integrationSerialKey } from './project-integration-job';

/**
 * The landing queue a project's integrations wait in, as `GET /projects/:id/integration/queue`
 * serves it (§2.2 J1, §3.4).
 *
 * THE QUEUE IS THE SERIAL KEY'S, NOT THE PROJECT'S. A landing claim is serialised per repository
 * and target ref — `integrationSerialKey` — because two landings onto one branch, from two projects
 * or two accounts, would race each other's pushes. So the row in front of a project's merge can be
 * another project's landing entirely, and the owner staring at "queued 70m" has no way to see that:
 * this read answers it by returning the whole line in claim order, with each entry's state.
 *
 * WHERE THE ROW'S OWN FACTS COME FROM. The queue a project asks about is its upstream's — the ref
 * its merges into main serialise on (`upstreamRef`), which is also where a `MAIN` line's task
 * landings land, so both kinds appear in one list. `CHECK_PROMOTION` never does: a check serialises
 * on its own project (`#check:<projectId>`) and never holds a landing slot, so it is not here by
 * construction rather than by a filter.
 *
 * WHAT IS NOT NAMED. J1's key is a repository and a ref, which another account's projects share.
 * A task's or project's title is served only to the owner whose account the job belongs to, and
 * `mine` states that boundary once — a client renders another account's row anonymously rather
 * than deriving the same answer from a missing title.
 *
 * WHAT `stale` MEANS. The head is claimed and its runner has not reported since before the claim's
 * own lease window (`INTEGRATION_CLAIM_STALE_MS`) — the very condition that lets another process
 * take the job over (`claimOne`). A client may say "it may be stuck" of exactly the head this
 * platform would take away, and of nothing else.
 */

interface QueueRow {
  jobId: string;
  kind: string;
  state: string;
  phase: string | null;
  ownerId: string;
  projectId: string | null;
  taskId: string | null;
  automatic: boolean;
  taskTitle: string | null;
  projectTitle: string | null;
  enqueuedAt: Date;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
}

/** One binding's queue, or an empty one for a project that has no binding to queue on. */
export async function readIntegrationQueue(
  prisma: Pick<PrismaService, '$queryRaw' | 'projectCodebase'>,
  ownerId: string,
  projectId: string,
): Promise<IntegrationQueueView<Date>> {
  const binding = await prisma.projectCodebase.findFirst({
    where: { projectId, slot: 'primary' },
    select: { canonicalRepoUrl: true, upstreamRef: true },
  });
  if (!binding) return { targetRef: null, running: 0, waiting: 0, jobs: [] };
  const key = integrationSerialKey({
    // Only `CHECK_PROMOTION` has a key of its own; every landing kind's key is the repo and the ref.
    kind: 'LAND_PROMOTION',
    canonicalRepoUrl: binding.canonicalRepoUrl,
    targetRef: binding.upstreamRef,
    projectId,
  });
  // Claim order, which is the order the platform takes them (`claimOne`'s ORDER BY): a reader's
  // position is its index and its "who is ahead" is everything before it. Titles join one owner
  // deep: the job's own, so an id from another account cannot borrow a title through a collision.
  const rows = await prisma.$queryRaw<QueueRow[]>(Prisma.sql`
    SELECT j."id" AS "jobId", j."kind", j."state", j."phase", j."owner_id" AS "ownerId",
           j."project_id" AS "projectId", j."task_id" AS "taskId",
           j."confirmed_automatically" AS "automatic",
           t."title" AS "taskTitle", p."title" AS "projectTitle",
           j."created_at" AS "enqueuedAt", j."claimed_at" AS "claimedAt",
           j."heartbeat_at" AS "heartbeatAt"
      FROM "project_integration_job" j
      LEFT JOIN "task" t ON t."id" = j."task_id" AND t."owner_id" = j."owner_id"
      LEFT JOIN "project" p ON p."id" = j."project_id" AND p."owner_id" = j."owner_id"
     WHERE j."serial_key" = ${key}
       AND j."state" IN ('QUEUED', 'RUNNING')
     ORDER BY j."created_at", j."id"`);
  const staleBefore = Date.now() - INTEGRATION_CLAIM_STALE_MS;
  const jobs = rows.map((row) => {
    const mine = row.ownerId === ownerId;
    const title = !mine ? null : row.kind === 'LAND_TASK' ? row.taskTitle : row.projectTitle;
    return {
      jobId: row.jobId,
      kind: row.kind as IntegrationJobKind,
      state: row.state as 'QUEUED' | 'RUNNING',
      phase: row.phase as IntegrationJobPhase | null,
      title,
      mine,
      automatic: row.automatic,
      projectId: mine ? row.projectId : null,
      taskId: mine && row.kind === 'LAND_TASK' ? row.taskId : null,
      enqueuedAt: row.enqueuedAt,
      startedAt: row.claimedAt,
      lastReportAt: row.heartbeatAt,
      // The claim's own takeover condition, so the two cannot describe one silence differently.
      stale: row.state === 'RUNNING' && (row.heartbeatAt === null || row.heartbeatAt.getTime() < staleBefore),
    };
  });
  return {
    targetRef: binding.upstreamRef,
    running: jobs.filter((job) => job.state === 'RUNNING').length,
    waiting: jobs.filter((job) => job.state === 'QUEUED').length,
    jobs,
  };
}

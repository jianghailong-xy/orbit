import { Prisma } from '@prisma/client';
import type { BackgroundJobStopCommand } from '@orbit/shared';
import { sessionHeldSql } from '../common/session-release';

/**
 * What a runner's heartbeat says of the bg_run jobs its sessions' owners asked to stop from the app
 * (SessionsService.stopBackgroundJob): every stop of an open session assigned to this runner whose job is still in
 * the session's running set. Level-triggered, as stopSubagentRunIds is: the job's terminal report takes it out of
 * running_bg_jobs, and with that out of this list, so a lost answer costs one beat and nothing else. Reads only.
 */
export async function backgroundJobStopsFor(db: Prisma.TransactionClient, runnerId: string): Promise<BackgroundJobStopCommand[]> {
  return db.$queryRaw<BackgroundJobStopCommand[]>`
    SELECT s."id"::text AS "sessionId", job AS "jobId"
      FROM "session" s, unnest(s."bg_job_stop_requests") AS job
     WHERE s."assigned_runner_id" = ${runnerId}::uuid
       AND ${sessionHeldSql('s')}
       AND cardinality(s."bg_job_stop_requests") > 0
       AND job = ANY(s."running_bg_jobs")
     ORDER BY s."id", job
  `;
}

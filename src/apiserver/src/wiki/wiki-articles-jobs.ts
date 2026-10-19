import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { WIKI_ARTICLES_JOB } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * When a space's articles become a server job (contracts/wiki.contract.json `articles.regeneration`,
 * `jobs.kindRuns.articles`; the owner's decision of 2026-10-08).
 *
 * THE RULE. Since criterion 3's revision 3 a maintenance run no longer rewrites the topic articles itself: a
 * maintenance run of a space that SUCCEEDED, RECORDED OPS and was NOT MADE WHILE THE SPACE WAS BEHIND (its
 * catch-up neither active nor paused, as the documents' step reads it) is the fact that makes one `articles`
 * job for the space. The job rewrites only the topics whose fingerprint changed, so a run whose ops changed no
 * topic's entries costs a plan and no model call.
 *
 * ONE ENTRY. `enqueueWikiArticlesJob` is the one way an articles job is made: the server's maintenance job's
 * end calls it through `queueWikiArticlesAfterRun` with its own run's facts (`finishWikiMaintenanceJob`).
 *
 * ONE QUEUED JOB PER SPACE. A queued job has not read the plan yet, and a job parked on its snapshot
 * (`waiting`) reads it again when it is replayed — either one covers every run that ends before it does, so a
 * second is not made beside it. A job that is already running may have read the plan, so the next run's end
 * queues one behind it (one job per space runs at a time). The check is a read of the same table, not a lock:
 * two run ends at once can make two jobs, and the second then finds every fingerprint written and writes
 * nothing.
 *
 * AFTER THE RUN'S END IS RECORDED, never inside it, and never as its failure: a job row is a fact about a run
 * that has ended, and a database hiccup here is logged and swallowed — the run's end stands, and the next run
 * asks again.
 */

const log = new Logger('WikiArticlesJobs');

/** What a maintenance run's end says that the articles' rule reads. */
export interface WikiRunEndFacts {
  /** How the run ended (`succeeded` | `failed` | `truncated`). */
  outcome: string | null;
  /** How the run was made: `active` | `paused` while the space was behind, null when it was not. */
  catchUp: string | null;
  /** Whether the run recorded any op in the space. */
  recordedOps: boolean;
}

/** The owner's rule of 2026-10-08: a run that succeeded, recorded ops, and was not made while the space was behind. */
export function wikiArticlesDueAfterRun(run: WikiRunEndFacts): boolean {
  return run.outcome === 'succeeded' && run.catchUp === null && run.recordedOps;
}

/**
 * Queue one `articles` job for the space, at background priority, unless one is queued or parked there
 * already. Answers whether a row was made.
 */
export async function enqueueWikiArticlesJob(prisma: PrismaService, input: { ownerId: string; spaceId: string }): Promise<boolean> {
  const inserted = await prisma.$executeRaw`
    INSERT INTO "wiki_job" ("id", "owner_id", "space_id", "kind", "input", "priority", "state")
    SELECT ${randomUUID()}::uuid, ${input.ownerId}::uuid, ${input.spaceId}::uuid, 'articles', '{}'::jsonb,
           ${WIKI_ARTICLES_JOB.priority}, 'queued'
    WHERE NOT EXISTS (
      SELECT 1 FROM "wiki_job" j
      WHERE j."space_id" = ${input.spaceId}::uuid
        AND j."kind" = 'articles'
        AND j."state" IN ('queued', 'waiting')
    )`;
  return inserted > 0;
}

/**
 * The articles job a maintenance run's end owes, when the run is one the rule names. Never throws: what it
 * could not queue it logs.
 */
export async function queueWikiArticlesAfterRun(
  prisma: PrismaService,
  input: { ownerId: string; spaceId: string } & WikiRunEndFacts,
): Promise<boolean> {
  if (!wikiArticlesDueAfterRun(input)) return false;
  try {
    return await enqueueWikiArticlesJob(prisma, input);
  } catch (error) {
    log.warn(`the articles of space ${input.spaceId} could not be queued after its maintenance run: ${(error as Error)?.message ?? String(error)}`);
    return false;
  }
}

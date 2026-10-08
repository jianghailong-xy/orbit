import { Prisma } from '@prisma/client';

/**
 * The circuit breaker over a whole Wiki maintenance run (design §8.2, contract `maintenance.job.breaker`):
 * «单次运行改动超过 active 条目 10% 就熔断».
 *
 * `submitChangeset` counts the breaker per changeset (contract `reviewModes.floors.circuitBreaker`), and a
 * run proposes in several — one per topic, thirty ops at most each — so counted per changeset a run could
 * change ten percent of the space thirty ops at a time. For a maintenance run's changeset the count is
 * the run's instead: every entry the run's earlier changesets changed through the review mode (an op the
 * mode applied, or one that waits for its verification and so will apply on a verdict) is already
 * spent, and the space's active entries are counted as they stood when the run began — the active entries
 * now, less the ones the run's own adds made active since.
 *
 * The run is its session: a maintenance task's run is one session, and every changeset it records names
 * it. A run the server's worker executes has no session: it names the wiki job that runs it
 * (`wiki_changeset.job_id`, migration 0407), and the count is the same over that. No clock and no run row
 * is read, so the count is the same whoever asks and whenever.
 *
 * A dry run answers with this count (`breakerReading`, contract `refusalRules.dryRun`): the entries the run
 * began with, what it has spent — a retry of `orbit wiki maintain` in the same session included — and what
 * remains. The runner holds its batches to that answer rather than counting anything of its own.
 */
export interface WikiMaintenanceRunChanges {
  /** The distinct entries the run's earlier changesets changed through the review mode. */
  changed: string[];
  /** Of them, the ones the run's own adds made that are active now. */
  addedActive: number;
}

export async function wikiMaintenanceRunChanges(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  ownerId: string,
  spaceId: string,
  run: { sessionId: string | null; jobId: string | null },
): Promise<WikiMaintenanceRunChanges> {
  const scope = run.sessionId !== null
    ? Prisma.sql`c."session_id" = ${run.sessionId}::uuid`
    : Prisma.sql`c."session_id" IS NULL AND c."job_id" = ${run.jobId}::uuid`;
  const rows = await db.$queryRaw<Array<{ entryId: string; addedActive: boolean }>>`
    SELECT COALESCE(o."result_entry_id", o."entry_id")::text AS "entryId",
           bool_or(o."op" = 'add' AND e."status" = 'active') AS "addedActive"
      FROM "wiki_changeset_op" o
      JOIN "wiki_changeset" c ON c."id" = o."changeset_id"
      LEFT JOIN "wiki_entry" e ON e."id" = COALESCE(o."result_entry_id", o."entry_id")
     WHERE c."owner_id" = ${ownerId}::uuid AND c."space_id" = ${spaceId}::uuid
       AND ${scope} AND c."origin" = 'maintenance'
       AND o."op" IN ('add', 'amend')
       AND (o."applied_by_mode" IS NOT NULL OR o."decision" = 'verifying')
       AND COALESCE(o."result_entry_id", o."entry_id") IS NOT NULL
     GROUP BY 1`;
  return {
    changed: rows.map((row) => row.entryId),
    addedActive: rows.filter((row) => row.addedActive).length,
  };
}

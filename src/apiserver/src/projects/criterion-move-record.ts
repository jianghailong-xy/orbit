import { Prisma } from '@prisma/client';
import { CRITERION_MOVED_ACTIVITY } from './criterion-move';

/**
 * The move record the done card draws (board 02 G and I): on the project a criterion left, one
 * line per criterion moved out — "Criterion 4 moved to <project> by you · <when>" — and on the
 * project it went to, the criterion's own "Moved from <project> by you · <when>".
 *
 * Read off the activity row every move writes (`CRITERION_MOVED_ACTIVITY`), not a table of its own:
 * that row is the record, and 0555's two partial indexes find a project's moves by the payload's
 * `fromProjectId` / `toProjectId` without scanning activity. One statement, joined to the
 * criterion (its words, where it stands now) and to both projects (their titles).
 *
 * Only the account owner moves a criterion (the read is filtered to rows they are the actor of), so
 * every record is "by you" and no actor is served.
 */

/** A criterion this project moved out to a follow-up. */
export interface CriterionMovedOut {
  criterionKey: string;
  definitionId: string;
  /** The criterion's number on this project's cards when it moved; null on a record written
   *  before the number was kept. */
  ordinal: number | null;
  text: string;
  toProjectId: string;
  toProjectTitle: string;
  movedAt: Date;
}

/** Where one criterion of this project came from. */
export interface CriterionMovedFrom {
  fromProjectId: string;
  fromProjectTitle: string;
  movedAt: Date;
}

export interface CriterionMoveRecord {
  movedOut: CriterionMovedOut[];
  /** Keyed by definition id: the newest move into this project of a criterion still here. */
  movedFrom: Map<string, CriterionMovedFrom>;
}

/** One row of the read, as the database answers it. */
export interface CriterionMoveRow {
  id: string;
  created_at: Date;
  definition_id: string;
  from_project_id: string;
  to_project_id: string;
  from_ordinal: number | null;
  /** Where the criterion is now, and its words; null when the definition is gone. */
  definition_project_id: string | null;
  text: string | null;
  from_title: string | null;
  to_title: string | null;
}

/**
 * The fold, over rows newest first. A criterion counts once on each side — its newest move — and
 * only while that is still true: a criterion moved out and later moved back is not "moved out",
 * and one moved in and then away again is not "moved from" here. A record whose other project is
 * gone has nothing to link to and is left out.
 */
export function criterionMoveRecord(
  projectId: string,
  rows: readonly CriterionMoveRow[],
  keyOf: (definitionId: string) => string,
): CriterionMoveRecord {
  const movedOut: CriterionMovedOut[] = [];
  const movedFrom = new Map<string, CriterionMovedFrom>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.definition_id)) continue;
    seen.add(row.definition_id);
    if (row.text === null || row.definition_project_id === null) continue;
    if (row.from_project_id === projectId && row.definition_project_id !== projectId) {
      if (row.to_title === null) continue;
      movedOut.push({
        criterionKey: keyOf(row.definition_id),
        definitionId: row.definition_id,
        ordinal: row.from_ordinal,
        text: row.text,
        toProjectId: row.to_project_id,
        toProjectTitle: row.to_title,
        movedAt: row.created_at,
      });
    } else if (row.to_project_id === projectId && row.definition_project_id === projectId) {
      if (row.from_title === null) continue;
      movedFrom.set(row.definition_id, {
        fromProjectId: row.from_project_id,
        fromProjectTitle: row.from_title,
        movedAt: row.created_at,
      });
    }
  }
  movedOut.sort((a, b) => (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER));
  return { movedOut, movedFrom };
}

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

// A literal, not a bind parameter: the two partial indexes are `WHERE type = 'project.criterion_moved'`,
// and a generic plan cannot prove a parameter matches that predicate.
const MOVED_TYPE_LITERAL = Prisma.raw(`'${CRITERION_MOVED_ACTIVITY}'`);

/** The statement: this owner's moves out of or into `projectId`, newest first. */
export async function readCriterionMoveRecord(
  db: Db,
  ownerId: string,
  projectId: string,
  keyOf: (definitionId: string) => string,
): Promise<CriterionMoveRecord> {
  const rows = await db.$queryRaw<CriterionMoveRow[]>(Prisma.sql`
    SELECT a."id", a."created_at",
           a.payload->>'criterionDefinitionId' AS definition_id,
           a.payload->>'fromProjectId' AS from_project_id,
           a.payload->>'toProjectId' AS to_project_id,
           CASE WHEN jsonb_typeof(a.payload->'fromOrdinal') = 'number'
                THEN (a.payload->>'fromOrdinal')::int END AS from_ordinal,
           d."project_id"::text AS definition_project_id,
           d."text",
           fp."title" AS from_title,
           tp."title" AS to_title
      FROM "activity" a
      LEFT JOIN "project_acceptance_criterion_definition" d
        ON d."id" = (a.payload->>'criterionDefinitionId')::uuid
      LEFT JOIN "project" fp
        ON fp."id" = (a.payload->>'fromProjectId')::uuid AND fp."owner_id" = ${ownerId}::uuid
      LEFT JOIN "project" tp
        ON tp."id" = (a.payload->>'toProjectId')::uuid AND tp."owner_id" = ${ownerId}::uuid
     WHERE a."type" = ${MOVED_TYPE_LITERAL}
       AND a."actor_id" = ${ownerId}::uuid
       AND (a.payload->>'fromProjectId' = ${projectId} OR a.payload->>'toProjectId' = ${projectId})
     ORDER BY a."created_at" DESC, a."id" DESC`);
  return criterionMoveRecord(projectId, rows, keyOf);
}

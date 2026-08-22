/**
 * "Why is nothing running when there is work ready to run?"
 *
 * Both halves of the answer are already in the audit and neither is readable from it without a
 * GROUP BY: `project_action` records every dispatch the control loop attempted and, when it
 * refused one, the PAC §12 code it refused under; `project_blocker` records what is open against
 * the project right now (§11). This is the read that puts the two side by side over one window.
 *
 * It decides nothing and writes nothing. A refusal here is history — the fact that a pass declined
 * to dispatch — not a live gate, which is what `/coordinator/status` and `/blockers` report.
 */

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** A day: long enough that an idle night still shows why, short enough to be about now. */
export const DEFAULT_DISPATCH_HEALTH_WINDOW_HOURS = 24;

/**
 * Where a refusal whose `refusal_code` is NULL is counted.
 *
 * The column is nullable and rows in the wild do arrive without one, so the alternative to naming
 * the group is losing it: `GROUP BY refusal_code` gives NULL its own bucket, and every client that
 * keys a list by the code then drops the bucket it cannot label — silently, and precisely when the
 * refusals are the ones nobody has classified yet. PAC §12's closed set is carried verbatim by
 * `PROJECT_BLOCKER_KINDS` and `UNSPECIFIED` is not one of its values, so the name cannot collide
 * with a code a refusal could actually have been written under.
 */
export const UNSPECIFIED_REFUSAL_CODE = 'UNSPECIFIED';

/** Ten years. Past this a "window" answers nothing about now, and `new Date` starts running out. */
const MAX_WINDOW_HOURS = 24 * 365 * 10;

export interface DispatchHealth {
  windowHours: number;
  dispatch: { applied: number; refused: number };
  refusals: Array<{ refusalCode: string; count: number; lastSeenAt: Date }>;
  openBlockers: Array<{ kind: string; severity: string; occurrences: number; firstSeenAt: Date }>;
}

interface DispatchGroupRow {
  status: string;
  refusalCode: string;
  count: number;
  lastSeenAt: Date;
}

/**
 * `?windowHours=` as a number of hours, defaulting to a day.
 *
 * A typo is a 400 that names the range rather than a silent fall back to the default: a window
 * that quietly became 24 hours reads as "there were no refusals last week" to whoever asked about
 * last week.
 */
export function parseWindowHours(raw?: string): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DISPATCH_HEALTH_WINDOW_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_WINDOW_HOURS) {
    throw new BadRequestException(`windowHours must be a number of hours in (0, ${MAX_WINDOW_HOURS}]`);
  }
  return hours;
}

/**
 * The dispatch ledger and the open blockers of one project, over `[now - windowHours, now)`.
 *
 * Half-open, and the bounds are computed ONCE here rather than from `now()` inside each statement:
 * the counts and the per-code breakdown come out of a single GROUP BY over the same window, so
 * `dispatch.refused` is the sum of `refusals[].count` by construction rather than by coincidence.
 * Two statements each reading their own `now()` could straddle a row and report a total its own
 * breakdown does not add up to.
 *
 * The bounds cross into SQL as instants (`::timestamptz AT TIME ZONE 'UTC'`) because `created_at`
 * is `timestamp(3)` without one: comparing it against a bare parameter would resolve the offset
 * against whatever the session's TimeZone happens to be.
 */
export async function readDispatchHealth(
  prisma: PrismaService,
  projectId: string,
  windowHours: number,
): Promise<DispatchHealth> {
  const to = new Date();
  const from = new Date(to.getTime() - windowHours * 3_600_000);
  const window = Prisma.sql`
        a."created_at" >= ${from.toISOString()}::timestamptz AT TIME ZONE 'UTC'
    AND a."created_at" <  ${to.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;

  const groups = await prisma.$queryRaw<DispatchGroupRow[]>(Prisma.sql`
    SELECT a."status"::text AS "status",
           COALESCE(a."refusal_code", ${UNSPECIFIED_REFUSAL_CODE}) AS "refusalCode",
           COUNT(*)::int AS "count",
           MAX(a."created_at") AS "lastSeenAt"
      FROM "project_action" a
     WHERE a."project_id" = ${projectId}::uuid
       AND a."type"::text = 'DISPATCH_TASK'
       -- CLAIMED is an action still in flight and SUPERSEDED one that never landed; neither is an
       -- outcome, and counting either as one would answer "did it dispatch" with "it tried to".
       AND a."status"::text IN ('APPLIED', 'REFUSED')
       AND ${window}
     GROUP BY 1, 2
     ORDER BY "count" DESC, "refusalCode" ASC
  `);

  const total = (status: string) => groups
    .filter((group) => group.status === status)
    .reduce((sum, group) => sum + group.count, 0);

  const openBlockers = await prisma.$queryRaw<DispatchHealth['openBlockers']>(Prisma.sql`
    SELECT b."kind", b."severity"::text AS "severity", b."occurrences",
           b."first_seen_at" AS "firstSeenAt"
      FROM "project_blocker" b
     WHERE b."project_id" = ${projectId}::uuid AND b."resolved_at" IS NULL
     ORDER BY b."first_seen_at", b."id"
  `);

  return {
    windowHours,
    dispatch: { applied: total('APPLIED'), refused: total('REFUSED') },
    refusals: groups
      .filter((group) => group.status === 'REFUSED')
      .map(({ refusalCode, count, lastSeenAt }) => ({ refusalCode, count, lastSeenAt })),
    openBlockers,
  };
}

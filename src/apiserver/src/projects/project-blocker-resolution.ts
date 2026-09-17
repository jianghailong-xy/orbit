import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * A project blocker as the person who has to act on it reads it, and the owner's door that ends one.
 *
 * WHY THIS EXISTS
 * ===============
 * Until 2026-09-14 nothing in production wrote `project_blocker.resolved_at`: the one producer that
 * would have was registered nowhere, and no API, MCP tool, CLI command or screen could end an
 * episode. The projects list showed how many blockers were open and nothing about any of them.
 *
 * The read serves each blocker's kind, what it asks for (`required_action`) and its `detail`
 * (display only, as 0125 declares it, and where the paths a delivery is blocked on live), beside the
 * title of the task it is about. The door lets the account owner end ANY open blocker, and only with
 * a written reason: the row records who ended it, the reason and — for the owner — who gave it, and
 * 0125's `project_blocker_resolution_final` trigger — widened to both by 0269 — keeps all of it from
 * being rewritten afterwards.
 *
 * Blockers whose condition goes away end without anybody: the unit that raises a delivery's
 * blocker resolves it once that work lands (`WakeDispositionService.resolveLandedBlockers`).
 */

/** One blocker as the project read and the resolve door serve it. */
export interface ProjectBlockerView {
  id: string;
  kind: string;
  owner: string;
  severity: string;
  requiredAction: string;
  subjectType: string;
  subjectId: string;
  /** The task's title, when the blocker is about one of this owner's tasks. */
  subjectTitle: string | null;
  /** The criterion that task is filed against, as it stands today. */
  criterionOrdinal: number | null;
  criterionRevision: number | null;
  /** Display and diagnosis, never an input to a decision (0125, BL7). */
  detail: Prisma.JsonValue;
  firstSeenAt: Date;
  lastSeenAt: Date;
  escalatedAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedByUserId: string | null;
}

export interface ProjectBlockersRead {
  /** Every open blocker, oldest first. */
  open: ProjectBlockerView[];
  /** The most recently resolved, newest first, at most `RESOLVED_BLOCKERS_SHOWN` of them. */
  resolved: ProjectBlockerView[];
  resolvedCount: number;
}

/** Resolved blockers are history: the read lists this many and counts the rest. */
export const RESOLVED_BLOCKERS_SHOWN = 20;

export const MAX_BLOCKER_RESOLUTION_REASON_CHARS = 2_000;

const VIEW_COLUMNS = Prisma.sql`
  blocker."id", blocker."kind", blocker."owner"::text AS "owner",
  blocker."severity"::text AS "severity", blocker."required_action" AS "requiredAction",
  blocker."subject_type" AS "subjectType", blocker."subject_id" AS "subjectId",
  work."title" AS "subjectTitle",
  criterion."ordinal" AS "criterionOrdinal", criterion."revision" AS "criterionRevision",
  blocker."detail", blocker."first_seen_at" AS "firstSeenAt", blocker."last_seen_at" AS "lastSeenAt",
  blocker."escalated_at" AS "escalatedAt", blocker."resolved_at" AS "resolvedAt",
  blocker."resolved_by"::text AS "resolvedBy", blocker."resolution_note" AS "resolutionNote",
  blocker."resolved_by_user_id" AS "resolvedByUserId"`;

/**
 * The blocker, scoped to the owner's project, with the task it names. `subject_id` is TEXT (a
 * provider subject is a slug), so it is cast only on a TASK row, and only when it is shaped like one.
 */
function viewFrom(ownerId: string): Prisma.Sql {
  return Prisma.sql`
    FROM "project_blocker" blocker
    JOIN "project" owned
      ON owned."id" = blocker."project_id" AND owned."owner_id" = ${ownerId}::uuid
    LEFT JOIN "task" work
      ON work."id" = CASE
           WHEN blocker."subject_type" = 'TASK'
            AND blocker."subject_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN blocker."subject_id"::uuid
         END
     AND work."owner_id" = ${ownerId}::uuid
    LEFT JOIN "project_acceptance_criterion_definition" criterion
      ON criterion."id" = work."criterion_definition_id"`;
}

/**
 * Every open blocker on one project and the latest resolved ones, in ONE statement: the project
 * detail read spends it (`project-get-query-count.pg.spec.ts` counts it).
 */
export async function readProjectBlockers(
  prisma: Pick<PrismaService, '$queryRaw'>,
  ownerId: string,
  projectId: string,
): Promise<ProjectBlockersRead> {
  const rows = await prisma.$queryRaw<Array<ProjectBlockerView & { resolvedCount: number }>>(
    Prisma.sql`
      SELECT "id", "kind", "owner", "severity", "requiredAction", "subjectType", "subjectId",
             "subjectTitle", "criterionOrdinal", "criterionRevision", "detail", "firstSeenAt",
             "lastSeenAt", "escalatedAt", "resolvedAt", "resolvedBy", "resolutionNote",
             "resolvedByUserId", "resolvedCount"
        FROM (
          SELECT ${VIEW_COLUMNS},
                 (count(*) FILTER (WHERE blocker."resolved_at" IS NOT NULL) OVER ())::int
                   AS "resolvedCount",
                 row_number() OVER (
                   PARTITION BY blocker."resolved_at" IS NULL
                   ORDER BY blocker."resolved_at" DESC, blocker."id"
                 ) AS "position"
          ${viewFrom(ownerId)}
           WHERE blocker."project_id" = ${projectId}::uuid
        ) listed
       WHERE "resolvedAt" IS NULL OR "position" <= ${RESOLVED_BLOCKERS_SHOWN}
       ORDER BY "resolvedAt" DESC NULLS FIRST, "firstSeenAt", "id"`,
  );
  const views = rows.map(({ resolvedCount: _count, ...view }) => view);
  return {
    open: views.filter((view) => view.resolvedAt === null),
    resolved: views.filter((view) => view.resolvedAt !== null),
    resolvedCount: rows[0]?.resolvedCount ?? 0,
  };
}

/**
 * WHO is ending the episode, which is not the same question as who authorized it.
 *
 * `USER` is a person at their own door, in their own words. `COORDINATOR` is an agent at the runner
 * door (`POST /runner/projects/:id/blockers/:blockerId/resolve`), which it may only reach after the
 * account owner has answered its confirmation card — but the owner answered yes/no to a sentence the
 * AGENT wrote, and recording that as `USER` would put the agent's reasoning in the owner's mouth.
 * The two stay apart so "who decided this was no longer blocking" survives in the audit, and so
 * `resolved_by_user_id` keeps meaning what 0269 says it means: the owner who wrote the reason.
 */
export type BlockerResolver = 'USER' | 'COORDINATOR';

/**
 * Ending one open blocker on a project, with the reason it no longer blocks.
 *
 * One conditional UPDATE decides it: the row must be this project's, the project this owner's, and
 * the blocker still open. Nothing that matches none of that is written, and what the caller is told
 * is read back afterwards — a blocker it cannot see is a 404 whoever's it is, and one already
 * resolved is a 409 that says how it ended, because a resolution is final and is never restated.
 */
export async function resolveProjectBlocker(
  prisma: Pick<PrismaService, '$queryRaw'>,
  input: {
    ownerId: string;
    projectId: string;
    blockerId: string;
    reason: unknown;
    /** Omitted is the owner's own door; see `BlockerResolver`. */
    resolvedBy?: BlockerResolver;
  },
): Promise<ProjectBlockerView> {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason === '') {
    throw new BadRequestException('reason is required: say why this blocker is no longer blocking');
  }
  if (reason.length > MAX_BLOCKER_RESOLUTION_REASON_CHARS) {
    throw new BadRequestException(
      `reason must be at most ${MAX_BLOCKER_RESOLUTION_REASON_CHARS} characters`,
    );
  }

  const resolvedBy: BlockerResolver = input.resolvedBy ?? 'USER';
  const now = new Date();
  const written = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "project_blocker" blocker
       SET "resolved_at" = ${now},
           "resolved_by" = ${resolvedBy}::"project_blocker_resolved_by",
           "resolution_note" = ${reason},
           "resolved_by_user_id" = ${resolvedBy === 'USER' ? input.ownerId : null}::uuid,
           "updated_at" = ${now}
     WHERE blocker."id" = ${input.blockerId}::uuid
       AND blocker."project_id" = ${input.projectId}::uuid
       AND blocker."resolved_at" IS NULL
       AND EXISTS (
         SELECT 1 FROM "project" owned
          WHERE owned."id" = blocker."project_id" AND owned."owner_id" = ${input.ownerId}::uuid
       )
    RETURNING blocker."id"
  `);

  const [view] = await prisma.$queryRaw<ProjectBlockerView[]>(Prisma.sql`
    SELECT ${VIEW_COLUMNS}
    ${viewFrom(input.ownerId)}
     WHERE blocker."id" = ${input.blockerId}::uuid
       AND blocker."project_id" = ${input.projectId}::uuid
  `);
  if (!view) throw new NotFoundException('blocker not found');
  if (written.length === 0) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'BLOCKER_ALREADY_RESOLVED',
      message: 'this blocker is already resolved, and a resolution is final',
      resolvedAt: view.resolvedAt,
      resolvedBy: view.resolvedBy,
    });
  }
  return view;
}

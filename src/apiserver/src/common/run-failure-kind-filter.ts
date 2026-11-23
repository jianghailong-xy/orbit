import { Prisma } from '@prisma/client';
import { MODEL_AT_CAPACITY_ERROR_MARKER, RunFailureKind, USAGE_LIMIT_ERROR_MARKERS } from '@orbit/shared';

/**
 * runFailureKind (@orbit/shared) as a database filter, for the readers that count runs in SQL: a run whose runner sent
 * a kind is that kind; a run with none (an older runner, or history from before the column) is read through the
 * legacy markers of its `error`, as these readers read every run before the kinds (routing-account-health-design
 * §5.4). Only the kinds that have a legacy marker a SQL `contains` can express are offered here: the markers are
 * plain lowercase substrings for exactly this use (USAGE_LIMIT_ERROR_MARKERS). No marker is added.
 */
export type SqlFailureKind = RunFailureKind.USAGE_LIMIT | RunFailureKind.CAPACITY;

function legacyMarkers(kinds: readonly SqlFailureKind[]): string[] {
  return kinds.flatMap((kind) =>
    kind === RunFailureKind.USAGE_LIMIT ? USAGE_LIMIT_ERROR_MARKERS : [MODEL_AT_CAPACITY_ERROR_MARKER]);
}

/** A Prisma session filter: the run failed with one of `kinds`. */
export function failureKindIs(kinds: readonly SqlFailureKind[]): Prisma.SessionWhereInput {
  return {
    OR: [
      { failureKind: { in: [...kinds] } },
      {
        failureKind: null,
        OR: legacyMarkers(kinds).map((marker) => ({ error: { contains: marker, mode: Prisma.QueryMode.insensitive } })),
      },
    ],
  };
}

/**
 * A Prisma session filter: the run did not fail with one of `kinds`. Written out rather than as NOT of failureKindIs,
 * because a negated match is not true of a NULL: a run with no kind and no error text matches no marker, so it is
 * not of these kinds and must be kept.
 */
export function failureKindIsNot(kinds: readonly SqlFailureKind[]): Prisma.SessionWhereInput {
  return {
    OR: [
      { AND: [{ NOT: { failureKind: null } }, { failureKind: { notIn: [...kinds] } }] },
      {
        failureKind: null,
        OR: [
          { error: null },
          {
            NOT: {
              OR: legacyMarkers(kinds).map((marker) => ({ error: { contains: marker, mode: Prisma.QueryMode.insensitive } })),
            },
          },
        ],
      },
    ],
  };
}

/** Raw SQL over the session row aliased `alias`: the run failed with one of `kinds` (failureKindIs). */
export function failureKindIsSql(alias: string, kinds: readonly SqlFailureKind[]): Prisma.Sql {
  const s = Prisma.raw(alias);
  const markers = Prisma.join(
    legacyMarkers(kinds).map((marker) => Prisma.sql`lower(coalesce(${s}.error, '')) LIKE ${`%${marker}%`}`),
    ' OR ',
  );
  // Never NULL: `failure_kind IN (...)` is NULL for a run with no kind, and a reader that negates this (the routing
  // report's NOT (failed AND ...)) would then drop every ordinary failure with no kind instead of counting it.
  return Prisma.sql`((${s}.failure_kind IS NOT NULL AND ${s}.failure_kind IN (${Prisma.join([...kinds])})) OR (${s}.failure_kind IS NULL AND (${markers})))`;
}

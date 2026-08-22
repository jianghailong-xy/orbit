/**
 * What the control loop has actually been doing, as one stream.
 *
 * Three tables record it and no page has ever shown a row of any of them. `project_event` is what
 * the project was told (§7's outbox), `project_decision` is what a pass concluded from it (§8's
 * audit) and `project_action` is what it then did about it (§9's ledger). Read separately they are
 * three logs of one loop; read in time order they are the loop — which is the layer a project of
 * autonomous work has and a ticket tracker does not, because its tickets do not decide anything.
 *
 * It decides nothing and writes nothing: every row here is history. What is true NOW is
 * `/coordinator/status` (where the loop stands) and `/blockers` (what is stopping it).
 *
 * ONE VOCABULARY, not three. The three tables key by three different columns — a
 * `project_action_type` enum, an open-ended event `kind` string, and a decision that has no type
 * column at all — and serving those raw would make every client re-derive the mapping, one client
 * at a time, from values that are not even drawn from the same kind of set. `kind` below is the
 * closed set they all map INTO; `outcome` is the four-value one the colour of a row is chosen
 * from. The raw values remain readable in `title`/`detail`, where they are prose rather than
 * protocol.
 *
 * TOTAL, not filtered: every row of the three tables is exactly one item. The alternative —
 * dropping the timer wakes and the passes that concluded nothing, which really are most of the
 * volume — would make a page's contents depend on a judgment this endpoint is not the place to
 * make, and "the loop woke 40 times and did nothing" is itself the answer to the question people
 * bring to an activity feed. A client that wants the interesting half filters on `kind`.
 */

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ProjectActionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decodeTaskPageCursor, encodeTaskPageCursor } from '../tasks/tasks.service';

/**
 * The closed set of things that can appear in this stream.
 *
 * The eight action types keep their own names — they are already the vocabulary the contract
 * writes and reads them under, and renaming them here would buy nothing but a second glossary.
 * `DECIDE`, `WAKE` and `SIGNAL` are the three the other two tables map into.
 */
export const PROJECT_ACTIVITY_KINDS = [
  'DISPATCH_TASK',
  'OPEN_COORDINATOR_TURN',
  'ROTATE_COORDINATOR_SESSION',
  'RAISE_BLOCKER',
  'CLEAR_BLOCKER',
  'APPLY_VERIFICATION_VERDICT',
  'REQUEST_APPROVAL',
  'RUN_PROJECT_ACCEPTANCE',
  'DECIDE',
  'WAKE',
  'SIGNAL',
] as const;

export type ProjectActivityKind = (typeof PROJECT_ACTIVITY_KINDS)[number];

/**
 * How a row reads, in four values — which is what a colour can be chosen from and what
 * `project_action_status` × 8 action types × 19-and-counting event kinds cannot be.
 *
 * `RESOLVED` is deliberately not a synonym for `APPLIED`: an action that CLEARED something is the
 * one kind of applied action a reader is looking for when scanning for the end of a wait.
 * Everything the loop merely observed is `INFO` — a signal it received and a pass it concluded
 * have no outcome of their own, and inventing one for them would make three quarters of the
 * stream claim a result nothing measured.
 */
export const PROJECT_ACTIVITY_OUTCOMES = ['APPLIED', 'REFUSED', 'RESOLVED', 'INFO'] as const;

export type ProjectActivityOutcome = (typeof PROJECT_ACTIVITY_OUTCOMES)[number];

export interface ProjectActivityItem {
  /** The row's own id, Base62 by the time it leaves the API. A stable key, and what the cursor
   *  that stops after it is built from. */
  id: string;
  at: Date;
  kind: ProjectActivityKind;
  title: string;
  detail: string | null;
  outcome: ProjectActivityOutcome;
  /** The task this row is ABOUT, when it is about one — an address the reader opens. */
  subjectTaskId: string | null;
}

export interface ProjectActivityPage {
  items: ProjectActivityItem[];
  nextCursor: string | null;
}

export interface ProjectActivityQuery {
  limit?: string;
  cursor?: string;
}

/** A screenful. The page is a card on the project view, not an export. */
export const DEFAULT_ACTIVITY_PAGE_SIZE = 20;
/** Enough for a client that wants a day in one request; past this the answer is a report. */
export const MAX_ACTIVITY_PAGE_SIZE = 100;

/** The event kind the scheduler's own clock produces. It is three quarters of the outbox by
 *  volume, and the one kind a reader wants to be able to tell apart from a signal the world sent. */
const TIMER_EVENT_KIND = 'timer.due';

/**
 * Every `project_action_type`, in the vocabulary and in English.
 *
 * A `Record` rather than a lookup with a fallback, so adding a ninth action type is a compile
 * error here — the alternative is a new kind of action appearing in the stream under a name no
 * client was told about, which is the failure this endpoint's whole point is to avoid.
 */
const ACTION_ACTIVITY: Record<ProjectActionType, { kind: ProjectActivityKind; title: string }> = {
  DISPATCH_TASK: { kind: 'DISPATCH_TASK', title: 'Dispatch task' },
  OPEN_COORDINATOR_TURN: { kind: 'OPEN_COORDINATOR_TURN', title: 'Open coordinator turn' },
  ROTATE_COORDINATOR_SESSION: { kind: 'ROTATE_COORDINATOR_SESSION', title: 'Rotate coordinator session' },
  RAISE_BLOCKER: { kind: 'RAISE_BLOCKER', title: 'Raise blocker' },
  CLEAR_BLOCKER: { kind: 'CLEAR_BLOCKER', title: 'Clear blocker' },
  APPLY_VERIFICATION_VERDICT: { kind: 'APPLY_VERIFICATION_VERDICT', title: 'Apply verification verdict' },
  REQUEST_APPROVAL: { kind: 'REQUEST_APPROVAL', title: 'Request approval' },
  RUN_PROJECT_ACCEPTANCE: { kind: 'RUN_PROJECT_ACCEPTANCE', title: 'Run project acceptance' },
};

/** One merged row, before it is put into words. Nine columns, the same nine from all three
 *  tables: what each of them means per source is documented on the query that fills them. */
interface ActivityRow {
  source: 'ACTION' | 'DECISION' | 'EVENT';
  id: string;
  at: Date;
  code: string | null;
  status: string | null;
  subjectTaskId: string | null;
  label: string | null;
  fromState: string | null;
  toState: string | null;
}

/**
 * `?limit=`, defaulting to a screenful.
 *
 * Refused rather than clamped, for the reason `taskPage` refuses one: a client that asked for 500
 * and silently got 20 reads the short page as the end of the project's history.
 */
function parseLimit(raw?: string): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ACTIVITY_PAGE_SIZE;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_PAGE_SIZE) {
    throw new BadRequestException(`limit must be an integer from 1 to ${MAX_ACTIVITY_PAGE_SIZE}`);
  }
  return limit;
}

/**
 * One page of the merged stream, newest first.
 *
 * `(at DESC, id DESC)` and never `at` alone. A pass writes its decision and the actions it
 * produced inside one transaction, so a boundary landing inside such a group is not the rare case
 * here — it is the normal one, and `at` alone would repeat some of those rows on the next page and
 * skip others. The cursor carries both halves and the branches compare both as a row value, which
 * is the same total order the outer sort applies.
 *
 * Each branch takes `limit + 1` of its own table before the merge: the newest `n` of a union
 * cannot contain more than `n` rows from any one of its parts, so this is the whole answer and not
 * a sample of it — and it is what keeps the cost of a page proportional to the page rather than to
 * the 6,000 rows behind it.
 *
 * Instants cross the boundary in both directions explicitly (`AT TIME ZONE 'UTC'`), because all
 * three columns are `timestamp(3)` WITHOUT one: read bare they are whatever the driver decides a
 * naked wall clock means, and a cursor built from a value the session's TimeZone shifted skips an
 * hour of history without saying so. The columns are millisecond-precision and so is `Date`, so
 * the round trip through the cursor is exact rather than approximately exact.
 */
export async function readProjectActivity(
  prisma: PrismaService,
  projectId: string,
  query: ProjectActivityQuery = {},
): Promise<ProjectActivityPage> {
  const limit = parseLimit(query.limit);
  const cursor = query.cursor ? decodeTaskPageCursor(query.cursor) : undefined;
  const take = limit + 1;

  const olderThanCursor = (at: string, id: string): Prisma.Sql => (cursor
    ? Prisma.sql`AND (${Prisma.raw(at)}, ${Prisma.raw(id)})
                   < (${cursor.createdAt.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${cursor.id}::uuid)`
    : Prisma.empty);

  const rows = await prisma.$queryRaw<ActivityRow[]>(Prisma.sql`
    SELECT * FROM (
      (
        -- What the loop DID. The label column is the one short code the row is qualified by:
        -- why it was refused, or which blocker it raised or cleared. The ledger's own detail
        -- column is the whole dispatch resolution, kilobytes of it, and stays in the ledger.
        SELECT 'ACTION'::text AS "source",
               a."id" AS "id",
               a."created_at" AT TIME ZONE 'UTC' AS "at",
               a."type"::text AS "code",
               a."status"::text AS "status",
               CASE WHEN a."subject_type" = 'TASK' THEN a."subject_id" END AS "subjectTaskId",
               CASE WHEN a."status" = 'REFUSED' THEN COALESCE(a."refusal_code", a."reason_code")
                    WHEN a."type" IN ('RAISE_BLOCKER', 'CLEAR_BLOCKER') THEN a."detail"->>'kind'
               END AS "label",
               NULL::text AS "fromState",
               NULL::text AS "toState"
          FROM "project_action" a
         WHERE a."project_id" = ${projectId}::uuid
           ${olderThanCursor('a."created_at"', 'a."id"')}
         ORDER BY a."created_at" DESC, a."id" DESC
         LIMIT ${take}
      )
      UNION ALL
      (
        -- What the loop CONCLUDED. The reason column is already the sentence a person would
        -- write; the run state either side of the pass is the one thing it changed that a
        -- reader cares about.
        SELECT 'DECISION'::text,
               d."id",
               d."created_at" AT TIME ZONE 'UTC',
               NULL::text,
               NULL::text,
               NULL::uuid,
               d."reason",
               d."outcome"->>'runStateBefore',
               d."outcome"->>'runStateAfter'
          FROM "project_decision" d
         WHERE d."project_id" = ${projectId}::uuid
           ${olderThanCursor('d."created_at"', 'd."id"')}
         ORDER BY d."created_at" DESC, d."id" DESC
         LIMIT ${take}
      )
      UNION ALL
      (
        -- What the loop was TOLD. A TASK-sourced event names its task in source_id; a session's
        -- or a merge's names it in the payload, and that is the difference between "a session
        -- ended" and "the session working on THAT task ended". The payload is open JSON, so the
        -- value is shape-checked before it is cast: an unparseable one is no subject, not a 500.
        SELECT 'EVENT'::text,
               e."id",
               e."occurred_at" AT TIME ZONE 'UTC',
               e."kind",
               NULL::text,
               CASE WHEN e."source_type" = 'TASK' THEN e."source_id"
                    WHEN e."payload"->>'taskId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                    THEN (e."payload"->>'taskId')::uuid
               END,
               e."payload"->>'kind',
               e."payload"->>'from',
               e."payload"->>'to'
          FROM "project_event" e
         WHERE e."project_id" = ${projectId}::uuid
           ${olderThanCursor('e."occurred_at"', 'e."id"')}
         ORDER BY e."occurred_at" DESC, e."id" DESC
         LIMIT ${take}
      )
    ) merged
    ORDER BY "at" DESC, "id" DESC
    LIMIT ${take}
  `);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(toActivityItem),
    // Built from the last row SERVED, never from the one row over it that proved there are more:
    // the extra row has not been shown to anybody yet, and starting the next page after it would
    // drop it.
    nextCursor: hasMore && page.length
      ? encodeTaskPageCursor({ createdAt: page[page.length - 1].at, id: page[page.length - 1].id })
      : null,
  };
}

/** `FROM → TO`, when a row records a transition and it went somewhere. */
function transition(from: string | null, to: string | null): string | null {
  return from && to && from !== to ? `${from} → ${to}` : null;
}

function toActivityItem(row: ActivityRow): ProjectActivityItem {
  const common = { id: row.id, at: row.at, subjectTaskId: row.subjectTaskId };
  if (row.source === 'ACTION') {
    const action = row.code ? ACTION_ACTIVITY[row.code as ProjectActionType] : undefined;
    return {
      ...common,
      // An action type this binary does not know is still an action that happened. It reads as a
      // signal rather than as nothing, and keeps its raw type as its title.
      kind: action?.kind ?? 'SIGNAL',
      title: action?.title ?? row.code ?? 'Action',
      detail: row.label,
      outcome: actionOutcome(row.code, row.status),
    };
  }
  if (row.source === 'DECISION') {
    return {
      ...common,
      kind: 'DECIDE',
      // `reason` is NOT NULL but may be empty; a blank line in a feed says less than the generic.
      title: row.label || 'Coordinator pass',
      detail: transition(row.fromState, row.toState),
      outcome: 'INFO',
    };
  }
  return {
    ...common,
    kind: row.code === TIMER_EVENT_KIND ? 'WAKE' : 'SIGNAL',
    // The kind verbatim, and deliberately not run through a table of English phrases: the column
    // is open by design (a producer on a newer binary may write a kind this one has never heard
    // of), and a humanising map renders exactly those as nothing at all.
    title: row.code ?? 'Signal',
    detail: transition(row.fromState, row.toState) ?? row.label,
    outcome: 'INFO',
  };
}

/**
 * What an action came to, in the four-value vocabulary.
 *
 * CLAIMED is an action still in flight and SUPERSEDED one that never landed; neither is a result,
 * and reporting either as one would tell a reader something started that did not.
 */
function actionOutcome(type: string | null, status: string | null): ProjectActivityOutcome {
  if (status === 'REFUSED') return 'REFUSED';
  if (status !== 'APPLIED') return 'INFO';
  return type === 'CLEAR_BLOCKER' ? 'RESOLVED' : 'APPLIED';
}

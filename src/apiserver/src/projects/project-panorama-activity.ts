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
 * COLLAPSED, not filtered: every row of the three tables remains in exactly one item's
 * `occurrences`, but consecutive rows with the same `(kind, outcome, title, detail,
 * subjectTaskId)` become one summary. "The loop woke 40 times and did nothing" is itself an
 * answer, so dropping timer wakes would destroy evidence; `WAKE ×40` states that evidence more
 * clearly than forty indistinguishable lines. Runs advance within a kind's subsequence because
 * the real heartbeat is an interleaved `WAKE, DECIDE, WAKE, DECIDE` pair; another kind does not
 * cut a run, while different content in the same kind does.
 *
 * Folding happens before the requested source-row page boundary. A boundary inside a run moves
 * to its end, so an ordinary run is never returned as `×10`, `×10`, `×5`. One hard scan cap is
 * the exception that keeps a pathological ten-thousand-row run from making one request
 * unbounded; those transport chunks carry every occurrence and clients coalesce adjacent pages.
 */

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ProjectActionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decodeTaskPageCursor, encodeTaskPageCursor } from '../tasks/tasks.service';

/**
 * The closed set of things that can appear in this stream.
 *
 * The nine action types keep their own names — they are already the vocabulary the contract
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
  // Migration 0133's ninth type. §13.2 V8's one machine-closable gap: a task that only a passing
  // check can complete, with no check pointed at it, is filed BY the loop — so it is an act of the
  // control loop and belongs in the stream that reports them, not a silent side effect.
  'FILE_VERIFICATION_TASK',
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
  /** The newest occurrence's id, Base62 by the time it leaves the API. A stable display key. */
  id: string;
  /** The newest occurrence's instant. */
  at: Date;
  kind: ProjectActivityKind;
  title: string;
  detail: string | null;
  outcome: ProjectActivityOutcome;
  /** The task this row is ABOUT, when it is about one — an address the reader opens. */
  subjectTaskId: string | null;
  /** Every source row represented by this summary, newest first. Nothing is filtered out. */
  occurrences: ProjectActivityOccurrence[];
}

export interface ProjectActivityOccurrence {
  id: string;
  at: Date;
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
/**
 * A request may inspect this many source rows, plus one lookahead row. Two maximum-sized pages
 * leave room to close ordinary runs while making the ceiling obvious. `limit` remains the target
 * number of SOURCE rows consumed, not the number of collapsed summaries returned: the page may
 * grow past it to finish every run crossing that boundary, but never past this cap. A longer run
 * is transported in bounded chunks and coalesced by the client, preserving exact pagination
 * without letting one pathological history dictate a request's work or response size.
 */
export const MAX_ACTIVITY_SCAN_ROWS = MAX_ACTIVITY_PAGE_SIZE * 2;

/** The event kind the scheduler's own clock produces. It is three quarters of the outbox by
 *  volume, and the one kind a reader wants to be able to tell apart from a signal the world sent. */
const TIMER_EVENT_KIND = 'timer.due';

/**
 * Every `project_action_type`, in the vocabulary and in English.
 *
 * A `Record` rather than a lookup with a fallback, so adding a tenth action type is a compile
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
  FILE_VERIFICATION_TASK: { kind: 'FILE_VERIFICATION_TASK', title: 'File verification task' },
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
 * Each branch takes the hard scan cap plus one lookahead row before the merge: the newest `n` of a
 * union cannot contain more than `n` rows from any one of its parts, so this is the whole bounded
 * prefix rather than a sample. Folding that prefix before choosing the source-row page boundary
 * lets a normal run cross one or many `limit` boundaries without being split; the fixed cap keeps
 * the cost independent of the 6,000 (or 10,000 identical) rows behind it.
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
  const take = MAX_ACTIVITY_SCAN_ROWS + 1;

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

  const sourceItems = rows.map(toActivityItem);
  const pageEnd = activityPageEnd(sourceItems, limit);
  const page = sourceItems.slice(0, pageEnd);
  const hasMore = rows.length > pageEnd;
  const cursorItem = page[page.length - 1];
  return {
    items: collapseActivityItems(page).map((run) => run.item),
    // Built from the last SOURCE row represented on this page — the folded group's last row, not
    // its first and not the lookahead row that proved there are more. Either alternative repeats
    // or drops occurrences when the next request applies its strict composite comparison.
    nextCursor: hasMore && cursorItem
      ? encodeTaskPageCursor({ createdAt: cursorItem.at, id: cursorItem.id })
      : null,
  };
}

interface ActivityRun {
  item: ProjectActivityItem;
  firstIndex: number;
  lastIndex: number;
}

function sameActivityRun(left: ProjectActivityItem, right: ProjectActivityItem): boolean {
  return left.kind === right.kind
    && left.outcome === right.outcome
    && left.title === right.title
    && left.detail === right.detail
    && left.subjectTaskId === right.subjectTaskId;
}

/**
 * Fold the merged stream in each kind's subsequence. The first appearance fixes display order;
 * another kind may interleave without cutting the run, while a changed row of this kind starts a
 * new one. Keeping the source positions is what lets pagination close every run it has entered.
 */
function collapseActivityItems(items: ProjectActivityItem[]): ActivityRun[] {
  const runs: ActivityRun[] = [];
  const currentByKind = new Map<ProjectActivityKind, ActivityRun>();

  items.forEach((item, index) => {
    const current = currentByKind.get(item.kind);
    if (current && sameActivityRun(current.item, item)) {
      current.item.occurrences.push(...item.occurrences);
      current.lastIndex = index;
      return;
    }

    const run: ActivityRun = {
      item: { ...item, occurrences: [...item.occurrences] },
      firstIndex: index,
      lastIndex: index,
    };
    runs.push(run);
    currentByKind.set(item.kind, run);
  });

  return runs;
}

/**
 * `limit` targets source rows. Close every run entered by that prefix, including interleaved runs
 * pulled in while the boundary moves, but stop at the hard scan cap. This fixed-point is the
 * ordering that matters: slicing first and folding afterwards would make the boundary invisible
 * and return one logical run as several summaries.
 */
function activityPageEnd(items: ProjectActivityItem[], limit: number): number {
  if (items.length <= limit) return items.length;

  const serveCap = Math.min(items.length, MAX_ACTIVITY_SCAN_ROWS);
  const runs = collapseActivityItems(items);
  let end = Math.min(limit, serveCap);

  for (;;) {
    let extended = end;
    for (const run of runs) {
      if (run.firstIndex < end) {
        extended = Math.max(extended, Math.min(run.lastIndex + 1, serveCap));
      }
    }
    if (extended === end) return end;
    end = extended;
  }
}

/** `FROM → TO`, when a row records a transition and it went somewhere. */
function transition(from: string | null, to: string | null): string | null {
  return from && to && from !== to ? `${from} → ${to}` : null;
}

function toActivityItem(row: ActivityRow): ProjectActivityItem {
  const common = {
    id: row.id,
    at: row.at,
    subjectTaskId: row.subjectTaskId,
    occurrences: [{ id: row.id, at: row.at }],
  };
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

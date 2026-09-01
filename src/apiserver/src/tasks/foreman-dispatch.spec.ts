import assert from 'node:assert/strict';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import {
  FOREMAN_RETRY_BACKOFF_MS,
  MAX_CONSECUTIVE_FOREMEN,
  TasksService,
} from './tasks.service';
import { TASK_OCCUPYING } from './reclaim-stalled-task';

/** Real uuids throughout: the note now encodes the task id, and the codec rejects anything else. */
const TASK_IDS = ['550e8400-e29b-41d4-a716-446655440000', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'];
/** What those tasks are called everywhere their reader can see them, `task_get` included. */
const TASK_PUBLIC_IDS = TASK_IDS.map((id) => uuidToBase62(id));

const LIST = {
  id: '9f4d7c62-2f4a-4a1e-9a3f-0a5f1c2d3e4b',
  ownerId: 'owner-1',
  title: 'FineWeb CC-MAIN-2025-26',
  workspaceId: 'workspace-1',
  minutes: 30,
};

interface ListEventWrite {
  listId: string;
  kind: string;
  detail: string;
}

/**
 * Runs the foreman sweep against a stub that returns `stalled` from the candidate scan, and
 * records the task it files, the run it dispatches, and the note it leaves on the list. The
 * scan's own SQL is asserted separately — a stub cannot evaluate it, so the predicate is
 * pinned as text.
 */
function makeService(
  stalled: (typeof LIST)[] = [LIST],
  options: { failExecuteFor?: string[]; priorForemen?: { count: number; agoMs: number } } = {},
) {
  const created: any[] = [];
  const executed: string[] = [];
  const events: ListEventWrite[] = [];
  const published: unknown[][] = [];
  let sql = '';
  let historySql = '';
  const prisma = {
    // Three raw queries reach this stub: the candidate scan, the foreman history, and the dispatch
    // epoch of each filed task. Told apart by what they ask for, so a test can say "this list has N
    // prior foremen" in one place without the scan's own SQL assertions changing.
    $queryRaw: async (...args: unknown[]) => {
      const text = renderRawQuery(args).text;
      // A row this sweep has just created is at the epoch its seed trigger gave it.
      if (text.includes('task_dispatch_epoch')) return [{ epoch: 0n }];
      if (text.includes('is_foreman = true') && text.includes('GROUP BY')) {
        historySql = text;
        const prior = options.priorForemen;
        if (!prior) return [];
        return stalled.map((l) => ({
          listId: l.id,
          count: BigInt(prior.count),
          lastAt: new Date(Date.now() - prior.agoMs),
        }));
      }
      sql = text;
      return stalled;
    },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: TASK_IDS[created.length - 1] };
      },
    },
    taskListEvent: {
      upsert: async ({ create }: { create: ListEventWrite }) => {
        events.push(create);
        return create;
      },
    },
  } as never;
  const service = new TasksService(prisma, {} as never, {
    publishForUser: (...args: unknown[]) => void published.push(args),
  } as never);
  const tokens: string[] = [];
  (service as unknown as { execute: unknown }).execute = async (
    _o: string, id: string, _auto: unknown, token: string,
  ) => {
    if (options.failExecuteFor?.includes(id)) throw new Error(`cannot start ${id}`);
    executed.push(id);
    tokens.push(token);
  };
  return {
    created,
    executed,
    tokens,
    events,
    published,
    sweep: () =>
      (
        service as unknown as { dispatchStalledListForemen(): Promise<void> }
      ).dispatchStalledListForemen(),
    sqlText: () => sql,
    historySql: () => historySql,
  };
}

test('a stalled list gets a foreman task, filed and dispatched', async () => {
  const f = makeService();

  await f.sweep();

  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].isForeman, true);
  assert.equal(f.created[0].listId, LIST.id);
  assert.equal(f.created[0].assigneeId, LIST.workspaceId);
  assert.equal(f.created[0].completionCriterion, 'HUMAN_SIGNOFF');
  assert.match(f.created[0].completionCriterionOverrideReason, /owner to review/);
  assert.deepEqual(f.executed, [TASK_IDS[0]]);
  assert.deepEqual(f.published, [[
    LIST.ownerId,
    'task_changed',
    { taskIds: [TASK_IDS[0]], resync: false },
  ]]);
  // Named `<kind>:<task>:<epoch>` like every other automatic request (§7.7 D5-b4): task-scoped, so
  // two foremen filed for two stalled lists are two requests rather than one answered with the
  // other's Session, and stamped with the moment the row was filed at.
  assert.deepEqual(f.tokens, [`first-run:${TASK_IDS[0]}:0`]);
});

test('the foreman brief names the stall and stays a one-shot', async () => {
  const f = makeService();

  await f.sweep();

  const description: string = f.created[0].description;
  assert.match(description, /停滞约 30 分钟/);
  // The instruction that keeps this episodic. A coordinator that decided to sit and poll would
  // be the resident supervisor this design exists to avoid, and it would hold a slot doing it.
  assert.match(description, /一次性的协调任务，不要保持长时间运行或轮询/);
});

test('the foreman does not auto-run — the stall dispatched it, not a prerequisite', async () => {
  const f = makeService();

  await f.sweep();

  // autoRunWhenReady only applies to tasks with prerequisites; leaving it true would be a claim
  // about this task that is not true of it.
  assert.equal(f.created[0].autoRunWhenReady, false);
});

test('nothing is filed when no list is stalled', async () => {
  const f = makeService([]);

  await f.sweep();

  assert.deepEqual(f.created, []);
  assert.deepEqual(f.executed, []);
});

test('a failed dispatch does not stop the remaining lists', async () => {
  // One bad list must not cost every other list its coordinator — the sweep is the only thing
  // that will notice those stalls, and it runs once a minute.
  const second = { ...LIST, id: 'c9b1f0de-4a77-4d6c-bf3a-1e2d3c4b5a69', title: 'Second' };
  const f = makeService([LIST, second], {
    failExecuteFor: [TASK_IDS[0]],
  });

  await f.sweep();

  assert.equal(f.created.length, 2);
  assert.deepEqual(f.executed, [TASK_IDS[1]]);
  assert.deepEqual(
    f.published.map((event) => (event[2] as { taskIds: string[] }).taskIds),
    [[TASK_IDS[0]], [TASK_IDS[1]]],
    'both durable rows are announced even though the first dispatch failed',
  );
});

test('the note that stall leaves on the list names the foreman by its public id', async () => {
  // The detail is persisted and later replayed into agent-visible prose — `describeList` prints
  // it verbatim, right beside the list's own base62 id — which is the boundary
  // PublicIdInterceptor does not cover: it rewrites response *fields*, and a stored event detail
  // is not one. Left as a uuid, the id naming *which* coordinator was dispatched is the one part
  // of the note its reader cannot hand back to `task_get`.
  const f = makeService();

  await f.sweep();

  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].kind, 'foreman_filed');
  const detail = f.events[0].detail;
  assert.ok(detail.includes(TASK_PUBLIC_IDS[0]), detail);
  assert.equal(detail.includes(TASK_IDS[0]), false, 'the raw uuid reached the stored event');
  // The rest of the note is unchanged — the encoding is the id's alone.
  assert.match(detail, /停滞约 30 分钟，已自动派出协调任务 .+ 去诊断/);
});

test('the ids the dispatch itself uses stay uuids', async () => {
  // Only the rendering boundary is encoded. execute() takes the id the database holds, and so
  // does the list this is filed under — a base62 id in either matches no row. This is the
  // control that says the fix moved the codec to the text and not into the plumbing.
  const f = makeService();

  await f.sweep();

  assert.deepEqual(f.executed, [TASK_IDS[0]]);
  assert.equal(f.events[0].listId, LIST.id);
});

// The scan is where every one of this feature's decisions actually lives, and a stub cannot
// evaluate SQL. Each clause is pinned as text so removing one fails here rather than in
// production, where the symptom would be either silence or a foreman filed every minute.
test('the candidate scan requires opt-in, work remaining, quiet, and no live foreman', async () => {
  const f = makeService([]);
  await f.sweep();
  const sql = f.sqlText();

  // Opt-in, and never on a paused list — pausing is the stop, and a coordinator that fired
  // anyway would be a run the user explicitly asked not to happen.
  assert.match(sql, /tl\.foreman_workspace_id IS NOT NULL/);
  assert.match(sql, /tl\.foreman_stall_minutes IS NOT NULL/);
  assert.match(sql, /tl\.paused = false/);
  // A brand-new list whose tasks are all still blocked is starting up, not stuck.
  assert.match(sql, /tl\.created_at < now\(\) - make_interval\(mins => tl\.foreman_stall_minutes\)/);
  // Work remains.
  assert.match(sql, /t\.status NOT IN \('DONE'::task_status, 'CANCELLED'::task_status\)/);
  // Nothing running and nothing started recently — the two halves of "quiet".
  assert.match(sql, /s\.created_at > now\(\) - make_interval\(mins => tl\.foreman_stall_minutes\)/);
  // One coordinator at a time.
  assert.match(sql, /t\.is_foreman = true/);
});

test('an idle-but-live session counts as occupied, not as a stall', async () => {
  // TASK_OCCUPYING, not just RUNNING: a session parked at AWAITING_INPUT is waiting for a human,
  // and filing a foreman over it would be reporting a person as a fault.
  const f = makeService([]);
  await f.sweep();

  assert.equal((f.sqlText().match(/::run_status/g) ?? []).length, TASK_OCCUPYING.length);
});

// Suppressing while one foreman is unfinished only stops concurrent coordinators. The moment one
// reaches DONE the suppression lifts and the stall — which it evidently did not fix — is still
// there, so without these the sweep files another every stall window, forever.
test('a stall a previous foreman did not clear is held off, not re-coordinated at once', async () => {
  const f = makeService([LIST], { priorForemen: { count: 1, agoMs: 60_000 } });

  await f.sweep();

  assert.deepEqual(f.created, []);
});

test('the hold lifts once the backoff for that many attempts has elapsed', async () => {
  const f = makeService([LIST], {
    priorForemen: { count: 1, agoMs: FOREMAN_RETRY_BACKOFF_MS[0] + 1_000 },
  });

  await f.sweep();

  assert.equal(f.created.length, 1);
});

test('the backoff lengthens with each coordinator that failed to fix it', async () => {
  // Two prior attempts: the first step is no longer enough to release it.
  const f = makeService([LIST], {
    priorForemen: { count: 2, agoMs: FOREMAN_RETRY_BACKOFF_MS[0] + 1_000 },
  });

  await f.sweep();

  assert.deepEqual(f.created, []);
});

test('past the cap the list is left for a human, however long it has been', async () => {
  // A coordinator that has failed this many times is reporting a problem it cannot solve; the
  // next identical run is not what surfaces it.
  const f = makeService([LIST], {
    priorForemen: { count: MAX_CONSECUTIVE_FOREMEN, agoMs: 30 * 24 * 60 * 60_000 },
  });

  await f.sweep();

  assert.deepEqual(f.created, []);
});

test('the history query counts only foremen filed since real work last ran', async () => {
  // This is what makes the escalation measure repeated failure rather than the list's age: a list
  // that stalled, was fixed, worked, and stalled again months later starts from step one.
  // A candidate must exist for the history query to run at all.
  const f = makeService([LIST], { priorForemen: { count: 1, agoMs: 0 } });
  await f.sweep();
  const history = f.historySql();

  assert.match(history, /wt\.is_foreman = false/);
  assert.match(history, /ft\.created_at > COALESCE/);
});

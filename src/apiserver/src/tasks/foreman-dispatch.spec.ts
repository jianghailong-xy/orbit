import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import {
  FOREMAN_RETRY_BACKOFF_MS,
  MAX_CONSECUTIVE_FOREMEN,
  TasksService,
} from './tasks.service';
import { TASK_OCCUPYING } from './reclaim-stalled-task';

const LIST = {
  id: 'list-1',
  ownerId: 'owner-1',
  title: 'FineWeb CC-MAIN-2025-26',
  workspaceId: 'workspace-1',
  minutes: 30,
};

/**
 * Runs the foreman sweep against a stub that returns `stalled` from the candidate scan, and
 * records the task it files plus the run it dispatches. The scan's own SQL is asserted
 * separately — a stub cannot evaluate it, so the predicate is pinned as text.
 */
function makeService(
  stalled: (typeof LIST)[] = [LIST],
  options: { failExecuteFor?: string[]; priorForemen?: { count: number; agoMs: number } } = {},
) {
  const created: any[] = [];
  const executed: string[] = [];
  let sql = '';
  let historySql = '';
  const prisma = {
    // Two raw queries reach this stub: the candidate scan, then the foreman history. Told apart
    // by which one has already run, so a test can say "this list has N prior foremen" in one
    // place without the scan's own SQL assertions changing.
    $queryRaw: async (strings: TemplateStringsArray, ...bound: unknown[]) => {
      const text = Prisma.sql(strings, ...(bound as never[])).text;
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
        return { id: `task-${created.length}` };
      },
    },
  } as never;
  const service = new TasksService(prisma, {} as never, {} as never);
  (service as unknown as { execute: unknown }).execute = async (_o: string, id: string) => {
    if (options.failExecuteFor?.includes(id)) throw new Error(`cannot start ${id}`);
    executed.push(id);
  };
  return {
    created,
    executed,
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
  assert.deepEqual(f.executed, ['task-1']);
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
  const second = { ...LIST, id: 'list-2', title: 'Second' };
  const f = makeService([LIST, second], {
    failExecuteFor: ['task-1'],
  });

  await f.sweep();

  assert.equal(f.created.length, 2);
  assert.deepEqual(f.executed, ['task-2']);
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

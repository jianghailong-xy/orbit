/**
 * The runner dispatch pause (dispatch-pause.ts) without a database: who may switch it, what switching it
 * writes and wakes, and which arm of each statement that hands a runner work reads it. What those
 * statements then do against real rows — no claim, only control turns and steers from the inbox, the
 * running turn finishing, new messages staying PENDING, everything delivered once it is off — is
 * `dispatch-pause.pg.spec.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RunStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PAT_FORBIDDEN } from '../auth/pat-scope.decorator';
import { INTEGRATION_JOB_CLAIM } from '../projects/project-integration-job';
import { dispatchIntegrationJobs } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { DISPATCH_PAUSED, SESSION_CLAIM_LOCK } from './dispatch-pause';
import { DispatchPauseController, SetDispatchPauseDto } from './dispatch-pause.controller';
import { DispatchPauseService } from './dispatch-pause.service';
import { QueueService } from './queue.service';

const SESSION = '11111111-1111-4111-8111-111111111111';
const RUNNER = '22222222-2222-4222-8222-222222222222';
const GENERATION = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';

/** The pause as every statement embeds it, rendered the way the doubles render a statement. */
const PAUSED = renderRawQuery([DISPATCH_PAUSED]).text;

test('only a signed-in administrator reaches it, never an access token', () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, DispatchPauseController), 'admin/dispatch-pause');
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, DispatchPauseController), [JwtAuthGuard, AdminRoleGuard]);
  assert.equal(Reflect.getMetadata(PAT_FORBIDDEN, DispatchPauseController), 'ADMIN');
});

test('the body says on or off with a boolean, and nothing else is read as one', async () => {
  const errors = async (body: unknown) => (await validate(plainToInstance(SetDispatchPauseDto, body))).length;
  assert.equal(await errors({ paused: true }), 0);
  assert.equal(await errors({ paused: false }), 0);
  for (const body of [{}, { paused: 'true' }, { paused: 1 }, { paused: null }]) {
    assert.ok(await errors(body) > 0, `${JSON.stringify(body)} was taken as a switch`);
  }
});

/** The service over doubles: `stored` is the row, null while there is none. */
function switchHarness(stored: boolean | null) {
  let row = stored === null ? null : { id: 1, paused: stored, updatedAt: new Date(0), updatedById: OWNER };
  const statements: string[] = [];
  const woken = { claims: 0, inboxes: [] as string[], runners: [] as string[] };
  const tx = {
    $executeRawUnsafe: async (sql: string) => {
      statements.push(sql);
      return 1;
    },
    $queryRaw: async (...args: unknown[]) => {
      const { text } = renderRawQuery(args);
      statements.push(text);
      return /FROM "dispatch_pause"/.test(text) && row ? [{ paused: row.paused }] : [];
    },
    $executeRaw: async (...args: unknown[]) => {
      const { text, values } = renderRawQuery(args);
      statements.push(text);
      if (/INSERT INTO "dispatch_pause"/.test(text)) {
        row = { id: 1, paused: values[0] as boolean, updatedAt: new Date(), updatedById: values[1] as string };
      }
      return 1;
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    dispatchPause: { findUnique: async () => row },
    $queryRaw: async (...args: unknown[]) => {
      const { text } = renderRawQuery(args);
      if (/t\."status" = 'PENDING'/.test(text) && /'reload'/.test(text)) return [{ id: SESSION }];
      if (/j\."state" = 'QUEUED'/.test(text)) return [{ runnerId: RUNNER }];
      return [];
    },
  };
  const queue = { notifySessionQueued: () => { woken.claims += 1; } };
  const realtime = {
    notifyInbox: (id: string) => woken.inboxes.push(id),
    notifyRunnerWake: (id: string) => woken.runners.push(id),
  };
  const service = new DispatchPauseService(prisma as never, queue as never, realtime as never);
  return { service, statements, woken, row: () => row };
}

test('switching it on writes the row under the claim lock every claim takes, and wakes nothing', async () => {
  const h = switchHarness(null);
  const view = await h.service.set(ADMIN, true);
  assert.equal(h.statements[0], SESSION_CLAIM_LOCK, 'the claim lock comes first');
  assert.ok(h.statements.some((sql) => /INSERT INTO "dispatch_pause"/.test(sql)));
  assert.deepEqual([h.row()?.paused, h.row()?.updatedById], [true, ADMIN]);
  assert.deepEqual([view.paused, view.updatedById], [true, ADMIN]);
  assert.deepEqual(h.woken, { claims: 0, inboxes: [], runners: [] });
});

test('asking for the state it is already in writes nothing and wakes nothing', async () => {
  for (const [stored, asked] of [[true, true], [false, false], [null, false]] as const) {
    const h = switchHarness(stored);
    const before = h.row();
    const view = await h.service.set(ADMIN, asked);
    assert.equal(h.statements.some((sql) => /INSERT INTO "dispatch_pause"/.test(sql)), false, `${stored} → ${asked} wrote`);
    assert.equal(h.row(), before);
    assert.equal(view.paused, asked);
    assert.deepEqual(h.woken, { claims: 0, inboxes: [], runners: [] });
  }
});

test('switching it off wakes the claims, every inbox holding a turn and every runner a queued job waits for', async () => {
  const h = switchHarness(true);
  const view = await h.service.set(ADMIN, false);
  assert.equal(view.paused, false);
  assert.equal(h.row()?.paused, false);
  assert.deepEqual(h.woken, { claims: 1, inboxes: [SESSION], runners: [RUNNER] });
});

test('every claim takes the same lock as the switch, and reads the pause where it picks the session', async () => {
  const executed: string[] = [];
  const claims: unknown[][] = [];
  const tx = {
    $executeRaw: async (...args: unknown[]) => {
      executed.push(renderRawQuery(args).text);
      return 1;
    },
    $queryRaw: async (...args: unknown[]) => {
      claims.push(args);
      return [];
    },
  };
  const prisma = {
    session: { findMany: async () => [] },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const queue = new QueueService(prisma as never, { publishSessionUpdated() {} } as never);
  assert.equal(await queue.claimSessionForRunner({ id: RUNNER }, 0), null);
  assert.equal(executed[0], SESSION_CLAIM_LOCK);
  const claim = renderRawQuery(claims[0]).text;
  const candidate = claim.slice(claim.indexOf('SELECT s.id FROM "session" s'), claim.indexOf('ORDER BY'));
  assert.ok(candidate.includes(`AND NOT ${PAUSED}`), 'the claim does not read the pause');
});

test('a queued integration job waits for the pause; a takeover of a silent claim does not', async () => {
  const statements: string[] = [];
  const prisma = {
    $queryRaw: async (...args: unknown[]) => {
      statements.push(renderRawQuery(args).text);
      return [];
    },
  };
  const handed = await dispatchIntegrationJobs(prisma as never, {
    runnerId: RUNNER, leaseOwner: GENERATION, draining: false, capabilities: [INTEGRATION_JOB_CLAIM],
  });
  assert.deepEqual(handed, []);
  const claim = statements.find((sql) => /UPDATE "project_integration_job" j/.test(sql))!;
  const queued = claim.slice(claim.indexOf(`(c."state" = 'QUEUED'`), claim.indexOf(`OR (c."state" = 'RUNNING'`));
  const takeover = claim.slice(claim.indexOf(`OR (c."state" = 'RUNNING'`), claim.indexOf('ORDER BY'));
  assert.ok(queued.includes(`NOT ${PAUSED}`), 'a queued job is claimed while the pause is on');
  assert.equal(takeover.includes(PAUSED), false, 'the takeover of a running job is held by the pause');
});

/** dequeueTurn over doubles, for a RUNNING claude session whose engine is the column's. */
function inboxHarness({ paused, waiting }: { paused?: boolean; waiting: boolean }) {
  let state = {
    id: SESSION, provider: 'claude', providerBuiltin: true, engine: 'claude', ownerId: OWNER, taskId: null,
    inboxLeaseGeneration: GENERATION as string | null, inboxLeaseOwner: OWNER as string | null,
    status: RunStatus.RUNNING as RunStatus, engineTurnActive: true,
    ...(paused === undefined ? {} : { dispatchPaused: paused }),
  };
  let retired = false;
  let committed = false;
  let heldQueries = 0;
  let lease = '';
  const announcements: boolean[] = [];
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      const sql = renderRawQuery(args).text;
      if (/SELECT id, "inbox_lease_generation"/.test(sql)) return [{ ...state }];
      if (/FROM "inbox_lease_generation"/.test(sql)) return retired ? [] : [{ generation: GENERATION }];
      if (/WHERE s\.id = \?::uuid\s+AND s\."cancel_requested_at" IS NULL/.test(sql)) {
        heldQueries += 1;
        return waiting ? [{ id: SESSION }] : [];
      }
      if (/UPDATE "conversation_turn"/.test(sql)) lease = sql;
      return [];
    },
    $executeRaw: async (...args: unknown[]) => {
      if (/INSERT INTO "inbox_lease_generation"/.test(renderRawQuery(args).text)) retired = true;
      return 1;
    },
    session: { update: async ({ data }: { data: object }) => { state = { ...state, ...data }; return state; } },
    conversationTurn: { updateMany: async () => ({ count: 0 }) },
  };
  const prisma = {
    $transaction: async (body: (client: typeof tx) => Promise<unknown>) => {
      const before = { ...state };
      const wasRetired = retired;
      try {
        const result = await body(tx);
        committed = true;
        return result;
      } catch (error) {
        state = before;
        retired = wasRetired;
        throw error;
      }
    },
  };
  const realtime = { publishSessionUpdated: () => announcements.push(committed) };
  const queue = { notifySessionQueued: () => announcements.push(committed) };
  const controller = new RunnerApiController(prisma as never, queue as never, realtime as never,
    {} as never, {} as never, {} as never);
  return {
    dequeue: () => (controller as unknown as {
      dequeueTurn(id: string, runner: string, generation: string | null): Promise<unknown>;
    }).dequeueTurn(SESSION, RUNNER, GENERATION),
    snapshot: () => ({ state, retired, committed, heldQueries, lease, announcements }),
  };
}

test('while paused, a run with nothing in flight and its next turn queued goes back to the queue', async () => {
  const h = inboxHarness({ paused: true, waiting: true });
  await assert.rejects(h.dequeue(), (error: unknown) =>
    error instanceof ConflictException && /runner dispatch is paused/.test(error.message));
  const result = h.snapshot();
  assert.equal(result.committed, true, 'the 409 must not roll the requeue back');
  assert.equal(result.state.status, RunStatus.PENDING);
  assert.equal(result.state.inboxLeaseOwner, null, 'the supervisor holding it lets go');
  assert.equal(result.state.inboxLeaseGeneration, GENERATION, 'the retired generation stays as the fence');
  assert.equal(result.state.engineTurnActive, false);
  assert.equal(result.retired, true);
  assert.equal(result.lease, '', 'nothing is handed out on the poll that gives the run back');
  assert.deepEqual(result.announcements, [true, true]);
});

test('while paused, a run with a turn in flight keeps it, and the poll goes on to what may still go out', async () => {
  const h = inboxHarness({ paused: true, waiting: false });
  assert.equal(await h.dequeue(), null);
  const result = h.snapshot();
  assert.equal(result.state.status, RunStatus.RUNNING);
  assert.equal(result.retired, false);
  assert.notEqual(result.lease, '', 'control turns and steers are still asked for');
  assert.deepEqual(result.announcements, []);
});

test('with the pause off nothing is asked about it and the poll is the one it always was', async () => {
  for (const paused of [false, undefined]) {
    const h = inboxHarness({ paused, waiting: true });
    assert.equal(await h.dequeue(), null);
    const result = h.snapshot();
    assert.equal(result.heldQueries, 0);
    assert.equal(result.state.status, RunStatus.RUNNING);
    assert.notEqual(result.lease, '');
  }
});

test('the pause holds what starts a turn — message, shell, reload — and no control turn, steer or re-delivery', async () => {
  const h = inboxHarness({ paused: false, waiting: false });
  await h.dequeue();
  const sql = h.snapshot().lease;
  const at = (marker: string) => {
    const index = sql.indexOf(marker);
    assert.ok(index >= 0, `the lease no longer says ${marker}`);
    return index;
  };
  const arms = {
    control: sql.slice(at(`turn."kind" IN ('interrupt', 'end', 'diff', 'setconfig')`), at(`turn."kind" = 'reload'`)),
    reload: sql.slice(at(`turn."kind" = 'reload'`), at(`turn."kind" = 'steer'`)),
    steer: sql.slice(at(`turn."kind" = 'steer'`), at('-- User executable turns')),
    executable: sql.slice(at('-- User executable turns'), at('ORDER BY')),
  };
  assert.equal(arms.control.includes(PAUSED), false, 'interrupt, end and withdraw are held');
  assert.equal(arms.steer.includes(PAUSED), false, 'a steer into the running turn is held');
  assert.ok(arms.reload.includes(`AND NOT ${PAUSED}`), 'a reload goes out while paused');
  const pending = arms.executable.indexOf(`turn."status" = 'PENDING'`);
  const expired = arms.executable.indexOf(`turn."status" = 'IN_FLIGHT' AND turn."lease_deadline_at" < now()`);
  assert.ok(pending > expired && expired >= 0);
  assert.equal(arms.executable.slice(0, pending).includes(PAUSED), false, 'a running turn is not re-delivered to its new process');
  assert.ok(arms.executable.slice(pending).includes(`AND NOT ${PAUSED}`), 'a queued message or shell goes out while paused');
});

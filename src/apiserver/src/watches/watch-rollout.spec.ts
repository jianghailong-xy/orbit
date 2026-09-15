import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { uuidToBase62 } from '@orbit/shared';
import { EMPTY } from 'rxjs';

import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { CreateWatchDto, UpdateWatchDto } from './dto';
import { WatchDeliveryService } from './watch-delivery.service';
import { WatchEvaluatorService } from './watch-evaluator.service';
import { renderWatchMetrics, resetWatchMetrics } from './watch-metrics';
import {
  readWatchRollout,
  WATCHES_DISABLED,
  watchClaimFields,
  watchesAcceptWaits,
  watchesDisabledError,
  watchWorkersRun,
  type WatchRollout,
} from './watch-rollout';
import { WatchesService } from './watches.service';

/**
 * The Watch rollout flag (watch-rollout.ts, docs/watch-rollout.md) without a database: how ORBIT_WATCHES is read, who
 * may add a wait or a wake under each mode, what a refused write answers and touches, which workers a replica runs,
 * and what the metrics say. The same flag over real PostgreSQL is watch-rollout.pg.spec.ts.
 */

const A = randomUUID();
const B = randomUUID();

/** A database no refused write may reach: every property read is recorded and throws. */
function untouchable(): { prisma: PrismaService; touched: string[] } {
  const touched: string[] = [];
  const prisma = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        throw new Error(`the database was reached through prisma.${String(property)}`);
      },
    },
  );
  return { prisma: prisma as unknown as PrismaService, touched };
}

async function refusal(attempt: () => Promise<unknown>): Promise<unknown> {
  return attempt().then(
    () => assert.fail('the write was not refused'),
    (error: unknown) => error,
  );
}

const ONE_TASK = {
  predicateVersion: 1,
  predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
  targets: [{ kind: 'TASK', id: randomUUID() }],
  action: 'NOTIFY_USER',
  ttlSeconds: 3600,
} as unknown as CreateWatchDto;

test('ORBIT_WATCHES is read as on by default, and a value nobody can read as the strictest mode', () => {
  assert.deepEqual(readWatchRollout({}), { mode: 'on', canaryOwners: new Set(), problems: [] });
  assert.equal(readWatchRollout({ ORBIT_WATCHES: ' Drain ' }).mode, 'drain');
  const typo = readWatchRollout({ ORBIT_WATCHES: 'of' });
  assert.equal(typo.mode, 'off');
  assert.match(typo.problems.join('\n'), /is none of on, canary, drain, off: Watch is off/);

  const canary = readWatchRollout({
    ORBIT_WATCHES: 'canary',
    ORBIT_WATCHES_CANARY_OWNERS: ` ${A.toUpperCase()}, ${uuidToBase62(B)} ,not an id`,
  });
  assert.deepEqual([...canary.canaryOwners].sort(), [A, B].sort());
  assert.equal(canary.problems.length, 1, canary.problems.join('\n'));
  assert.match(canary.problems[0], /"not an id", which is no account id/);
  assert.match(readWatchRollout({ ORBIT_WATCHES: 'canary' }).problems.join('\n'), /no account can watch/);

  const ignored = readWatchRollout({ ORBIT_WATCHES: 'drain', ORBIT_WATCHES_CANARY_OWNERS: A });
  assert.equal(ignored.canaryOwners.size, 0);
  assert.match(ignored.problems.join('\n'), /read only under ORBIT_WATCHES=canary/);
});

test('each mode lets exactly its accounts add waits, and only off stops the workers', () => {
  const modes: Array<[string, WatchRollout, boolean, boolean, boolean]> = [
    // mode, rollout, A may, B may, workers run
    ['on', readWatchRollout({ ORBIT_WATCHES: 'on' }), true, true, true],
    ['canary', readWatchRollout({ ORBIT_WATCHES: 'canary', ORBIT_WATCHES_CANARY_OWNERS: A }), true, false, true],
    ['drain', readWatchRollout({ ORBIT_WATCHES: 'drain' }), false, false, true],
    ['off', readWatchRollout({ ORBIT_WATCHES: 'off' }), false, false, false],
  ];
  for (const [mode, rollout, a, b, workers] of modes) {
    assert.equal(watchesAcceptWaits(rollout, A), a, `${mode}: account A`);
    assert.equal(watchesAcceptWaits(rollout, B), b, `${mode}: account B`);
    assert.equal(watchWorkersRun(rollout), workers, `${mode}: workers`);
    // The claim says so only when it is not on: an account Watch is on for gets the payload runners always had.
    assert.deepEqual(watchClaimFields(rollout, A), a ? {} : { watchesDisabled: true }, `${mode}: A's claim`);
    assert.deepEqual(watchClaimFields(rollout, B), b ? {} : { watchesDisabled: true }, `${mode}: B's claim`);
  }
});

test("a refused write is the 404 a server without Watch answers, and no released runner reads it as a missing watch", () => {
  const error = watchesDisabledError(readWatchRollout({ ORBIT_WATCHES: 'drain' }), 'create');
  assert.ok(error instanceof NotFoundException);
  assert.equal(error.getStatus(), 404);
  const body = error.getResponse() as { code: string; message: string };
  assert.equal(body.code, WATCHES_DISABLED);
  assert.match(body.message, /ORBIT_WATCHES=drain/);
  // session_wait.go's watchDoorMissing, in every runner released with watches, reads a 404 on /runner/watches as "this
  // server has no watch door" (and waits inline) unless the body says "watch not found", the door's own 404.
  assert.ok(!JSON.stringify(body).includes('watch not found'), body.message);
});

test('under drain every write that adds a wait or a wake is refused before the database, and the rest are not', async () => {
  resetWatchMetrics();
  const drained = untouchable();
  const watches = new WatchesService(drained.prisma, { rollout: readWatchRollout({ ORBIT_WATCHES: 'drain' }) });
  const id = randomUUID();
  const refusals: Array<[string, () => Promise<unknown>]> = [
    ['create', () => watches.create(A, ONE_TASK)],
    ['update', () => watches.update(A, id, { ttlSeconds: 3600 } as UpdateWatchDto)],
    ['resume', () => watches.resume(A, id)],
    ['redrive', () => watches.retryDelivery(A, id)],
  ];
  for (const [write, attempt] of refusals) {
    const error = await refusal(attempt);
    assert.ok(error instanceof NotFoundException, `${write}: ${String(error)}`);
    assert.equal((error.getResponse() as { code?: string }).code, WATCHES_DISABLED, write);
  }
  assert.deepEqual(drained.touched, [], 'a refused write reached the database');

  // What reads a watch or stops one is not the flag's to refuse: each of these goes on to the database.
  for (const [what, attempt] of [
    ['get', () => watches.get(A, id)],
    ['list', () => watches.list(A)],
    ['pause', () => watches.pause(A, id)],
    ['cancel', () => watches.cancel(A, id)],
    ['listDeliveries', () => watches.listDeliveries(A)],
    ['listNeedingAttention', () => watches.listNeedingAttention(A)],
  ] as Array<[string, () => Promise<unknown>]>) {
    const error = await refusal(attempt);
    assert.match(String(error), /the database was reached/, `${what} was refused by the flag: ${String(error)}`);
  }

  // The paired positive: the same edit for an account Watch is on for passes the gate.
  const open = untouchable();
  const canary = new WatchesService(open.prisma, {
    rollout: readWatchRollout({ ORBIT_WATCHES: 'canary', ORBIT_WATCHES_CANARY_OWNERS: uuidToBase62(A) }),
  });
  assert.match(String(await refusal(() => canary.update(A, id, { ttlSeconds: 3600 } as UpdateWatchDto))), /the database was reached/);
  assert.match(String(await refusal(() => canary.resume(A, id))), /the database was reached/);
  const refusedForB = await refusal(() => canary.update(B, id, { ttlSeconds: 3600 } as UpdateWatchDto));
  assert.equal(((refusedForB as NotFoundException).getResponse() as { code?: string }).code, WATCHES_DISABLED);

  const exposition = await renderWatchMetrics();
  for (const write of ['create', 'resume', 'redrive']) {
    assert.match(exposition, new RegExp(`^orbit_watch_rollout_refusals_total\\{write="${write}"\\} 1$`, 'm'), write);
  }
  assert.match(exposition, /^orbit_watch_rollout_refusals_total\{write="update"\} 2$/m);
});

test('off leaves the evaluator and the delivery worker unstarted; drain starts both', async () => {
  const noHints = { localPublications: () => EMPTY } as unknown as RealtimeService;
  const loopOf = (worker: unknown) => (worker as { loop: string }).loop;

  const off = untouchable();
  const rolloutOff = readWatchRollout({ ORBIT_WATCHES: 'off' });
  const evaluatorOff = new WatchEvaluatorService(off.prisma, noHints, { rollout: rolloutOff, pollIntervalMs: 3_600_000 });
  const deliveryOff = new WatchDeliveryService(off.prisma, {} as never, {} as never, { rollout: rolloutOff, pollIntervalMs: 3_600_000 });
  evaluatorOff.onModuleInit();
  deliveryOff.onModuleInit();
  assert.equal(loopOf(evaluatorOff), 'IDLE');
  assert.equal(loopOf(deliveryOff), 'IDLE');
  await evaluatorOff.onModuleDestroy();
  await deliveryOff.onModuleDestroy();
  assert.deepEqual(off.touched, [], 'a replica with Watch off read the database for a pass');

  // The paired positive: under drain both run, and the first pass goes to the database at once.
  const drain = untouchable();
  const rolloutDrain = readWatchRollout({ ORBIT_WATCHES: 'drain' });
  const evaluator = new WatchEvaluatorService(drain.prisma, noHints, { rollout: rolloutDrain, pollIntervalMs: 3_600_000 });
  const delivery = new WatchDeliveryService(drain.prisma, {} as never, {} as never, { rollout: rolloutDrain, pollIntervalMs: 3_600_000 });
  evaluator.onModuleInit();
  delivery.onModuleInit();
  assert.equal(loopOf(evaluator), 'RUNNING');
  assert.equal(loopOf(delivery), 'RUNNING');
  await evaluator.onModuleDestroy();
  await delivery.onModuleDestroy();
  assert.ok(drain.touched.length > 0, 'the running workers never went to the database');
});

test('the metrics say which mode this replica runs and how many accounts canary lets watch', async () => {
  const saved = { mode: process.env.ORBIT_WATCHES, owners: process.env.ORBIT_WATCHES_CANARY_OWNERS };
  try {
    process.env.ORBIT_WATCHES = 'canary';
    process.env.ORBIT_WATCHES_CANARY_OWNERS = `${A},${uuidToBase62(B)}`;
    const canary = await renderWatchMetrics();
    assert.match(canary, /^orbit_watch_rollout\{mode="canary"\} 1$/m);
    for (const mode of ['on', 'drain', 'off']) assert.match(canary, new RegExp(`^orbit_watch_rollout\\{mode="${mode}"\\} 0$`, 'm'));
    assert.match(canary, /^orbit_watch_rollout_canary_owners 2$/m);

    delete process.env.ORBIT_WATCHES;
    delete process.env.ORBIT_WATCHES_CANARY_OWNERS;
    const on = await renderWatchMetrics();
    assert.match(on, /^orbit_watch_rollout\{mode="on"\} 1$/m);
    assert.match(on, /^orbit_watch_rollout_canary_owners 0$/m);
  } finally {
    if (saved.mode === undefined) delete process.env.ORBIT_WATCHES;
    else process.env.ORBIT_WATCHES = saved.mode;
    if (saved.owners === undefined) delete process.env.ORBIT_WATCHES_CANARY_OWNERS;
    else process.env.ORBIT_WATCHES_CANARY_OWNERS = saved.owners;
  }
});

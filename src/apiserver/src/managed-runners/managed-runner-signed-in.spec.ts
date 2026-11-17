import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ServiceUnavailableException } from '@nestjs/common';

import { testManagedRunnerProfile } from '../test-support/managed-runner-profile.fixture';
import type { ManagedRunnerRuntime } from './managed-runner-runtime';
import { SIGNED_IN_PAGE, SignedInPassTimer } from './managed-runner-signed-in';
import { ManagedRunnerService } from './managed-runner.service';

// The signed-in pass (docs/managed-runner-signed-in-accounts-design.md) without a database: what it
// reads off and on, how it walks the pages, how a failure ends or skips an account, and its timer.
// Which accounts the query finds, over a real PostgreSQL, is managed-runner-signed-in.pg.spec.ts.

const ON = { enabled: true, problem: null } as const;
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const id = (n: number) => `0199a1b2-0000-7000-8000-${String(n).padStart(12, '0')}`;

function runtime(kicks: { n: number }): ManagedRunnerRuntime {
  return { available: true, profile: testManagedRunnerProfile(), manager: {} as never, worker: { kick: () => void (kicks.n += 1) } as never };
}

/** A service over `owners` (already sorted), answering the query page by page, with createMapping recorded. */
function world(owners: string[], options: { eligible?: (ownerId: string) => boolean; create?: (ownerId: string) => void } = {}) {
  const pages: Array<string | null> = [];
  const made: string[] = [];
  const kicks = { n: 0 };
  const prisma = {
    user: {
      findMany: async ({ where, take }: { where: { id?: { gt: string } }; take: number }) => {
        const after = where.id?.gt ?? null;
        pages.push(after);
        return owners.filter((o) => after === null || o > after).slice(0, take).map((o) => ({ id: o }));
      },
      // enabledAccountsOnly: nobody here is disabled.
      findUnique: async () => ({ disabledAt: null }),
    },
  };
  const service = new ManagedRunnerService(prisma as never, ON, runtime(kicks), { eligible: async (o) => options.eligible?.(o) ?? true });
  (service as unknown as { log: typeof quiet }).log = quiet;
  (service as unknown as { createMapping: (ownerId: string) => Promise<unknown> }).createMapping = async (ownerId) => {
    options.create?.(ownerId);
    made.push(ownerId);
    return { id: `mapping-${ownerId}` };
  };
  return { service, pages, made, kicks };
}

test('off, and on without a usable environment, the pass reads nothing and makes nothing', async () => {
  const calls: string[] = [];
  const prisma = new Proxy({}, { get: (_t, model: string) => new Proxy({}, { get: (_i, method: string) => async () => void calls.push(`${model}.${method}`) }) });
  const kicks = { n: 0 };
  assert.equal(await new ManagedRunnerService(prisma as never, { enabled: false, problem: null }, runtime(kicks)).provisionSignedIn(), 0);
  assert.equal(await new ManagedRunnerService(prisma as never, ON, { available: false, problems: ['no profile'] }).provisionSignedIn(), 0);
  assert.equal(await new ManagedRunnerService(prisma as never, ON, null).provisionSignedIn(), 0);
  assert.equal(calls.length, 0, calls.join(', '));
  assert.equal(kicks.n, 0);
});

test('every page is read: a full page the rule refuses does not keep the accounts after it waiting', async () => {
  const owners = Array.from({ length: SIGNED_IN_PAGE + 3 }, (_, i) => id(i + 1));
  const refused = new Set(owners.slice(0, SIGNED_IN_PAGE));
  const w = world(owners, { eligible: (o) => !refused.has(o) });
  assert.equal(await w.service.provisionSignedIn(), 3);
  assert.deepEqual(w.made, owners.slice(SIGNED_IN_PAGE));
  assert.deepEqual(w.pages, [null, owners[SIGNED_IN_PAGE - 1]], 'the first page, then the one after its last id, which is short: done');
  assert.equal(w.kicks.n, 1, 'the manager is woken once for the whole pass');
});

test('nobody to give one: one page read, nothing made, the manager not woken', async () => {
  const w = world([]);
  assert.equal(await w.service.provisionSignedIn(), 0);
  assert.deepEqual(w.pages, [null]);
  assert.equal(w.kicks.n, 0);
});

test('an account whose mapping cannot be written is skipped; with no host to place one on, the pass stops', async () => {
  const owners = [id(1), id(2), id(3), id(4)];
  const skipped = world(owners, { create: (o) => { if (o === id(2)) throw new Error('connection reset'); } });
  assert.equal(await skipped.service.provisionSignedIn(), 3);
  assert.deepEqual(skipped.made, [id(1), id(3), id(4)]);
  assert.equal(skipped.kicks.n, 1);

  const stopped = world(owners, { create: (o) => { if (o === id(3)) throw new ServiceUnavailableException('every host is draining'); } });
  assert.equal(await stopped.service.provisionSignedIn(), 2);
  assert.deepEqual(stopped.made, [id(1), id(2)]);
  assert.equal(stopped.kicks.n, 1, 'what it made before stopping is still provisioned');
});

test('the timer runs a pass at start and on every interval, one at a time, through a failing pass, until stopped', async () => {
  let runs = 0;
  let inFlight = 0;
  let overlapped = false;
  const errors: string[] = [];
  const timer = new SignedInPassTimer(async () => {
    runs += 1;
    inFlight += 1;
    overlapped ||= inFlight > 1;
    await sleep(5);
    inFlight -= 1;
    if (runs === 2) throw new Error('database away');
  }, 10, { error: (m: string) => void errors.push(m) });
  timer.start();
  timer.start();
  await sleep(1);
  assert.ok(runs >= 1, 'the first pass runs at once');
  for (let i = 0; i < 100 && runs < 4; i += 1) await sleep(10);
  assert.ok(runs >= 4, `passes went on after the failing one (${runs})`);
  assert.equal(overlapped, false);
  assert.deepEqual(errors, ['managed runners: the signed-in pass failed: database away']);
  await timer.stop();
  const after = runs;
  await sleep(40);
  assert.equal(runs, after, 'no pass after stop');
});

test('the service starts the pass beside the worker only when on with an environment, and stops it', async () => {
  const kicks = { n: 0 };
  const worker = { started: 0, stopped: 0 };
  const rt = { ...runtime(kicks), worker: { start: () => void (worker.started += 1), stop: async () => void (worker.stopped += 1), kick: () => undefined } } as never;
  const prisma = { user: { findMany: async () => [] } };

  const off = new ManagedRunnerService(prisma as never, { enabled: false, problem: null }, rt);
  let offPasses = 0;
  off.provisionSignedIn = async () => (offPasses += 1);
  off.onModuleInit();
  await sleep(5);
  await off.onModuleDestroy();
  assert.equal(offPasses, 0);
  assert.equal(worker.started, 0);

  const on = new ManagedRunnerService(prisma as never, ON, rt);
  let passes = 0;
  on.provisionSignedIn = async () => (passes += 1);
  on.onModuleInit();
  await sleep(5);
  await on.onModuleDestroy();
  assert.equal(passes, 1, 'one pass at start; the next is minutes away');
  assert.deepEqual(worker, { started: 1, stopped: 2 }, 'started only when on; stopped at every destroy, as before');
});

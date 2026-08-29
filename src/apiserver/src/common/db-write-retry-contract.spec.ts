import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Prisma } from '@prisma/client';

import { TRANSACTION_UNITS } from './db-write-inventory';
import {
  DEFAULT_TRANSACTION_MAX_ATTEMPTS,
  classifyTransactionError,
  withTransactionRetry,
  type TransactionRunner,
} from './transaction-retry';

/**
 * One conflict-then-success and one exhaustion for every unit of work that adopted the retry.
 *
 * WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------
 * Every `TX_RETRIED` entry in `TRANSACTION_UNITS` reaches the database through the same loop, so
 * the thing that varies per unit is not the loop — it is the ATTEMPT BUDGET the unit chose and the
 * fact that its exhausted conflict leaves as something the boundary will answer 503 rather than
 * 500. That is what is checked here, per unit, from the inventory's own declaration: run the
 * unit's budget against a runner that fails on demand, and assert the closure was re-run whole,
 * that the result is the winning attempt's, that exhaustion happens after exactly the declared number of attempts,
 * and that what comes out is the original error with the shared classifier still calling it
 * transient — which is the single fact the global boundary turns into a 503. `TX_BARE` entries
 * are separately pinned to one attempt and deliberately omitted from recovery scenarios.
 *
 * It does NOT re-run each service's own closure. A test that did would need every one of those
 * services stood up with mocks, and what it would then be asserting is the loop again. The
 * per-unit claims that are ABOUT the unit — that its identity sits outside the closure, that a
 * retry writes one row and not two, that its external effect happens once — are made where they
 * can be made honestly: `task-create-retry.spec.ts` and `db-write-retry-effects.spec.ts` drive the
 * real services, and `db-write-inventory.spec.ts` proves statically that no external action is
 * inside any closure at all.
 *
 * The 503 itself is pinned once, over real HTTP and on all four write shapes, in
 * `transient-db-conflict.spec.ts`. Repeating an HTTP server fifty-two times would test that spec,
 * not these units.
 */

/** A 40P01 the way `pg` reports it: the SQLSTATE on `code`. */
function deadlock(): Error {
  return Object.assign(new Error('deadlock detected'), { code: '40P01' });
}

/**
 * A 40001 the way Prisma 7 really delivers one from a raw query: the caller catches `P2010`
 * ("raw query failed") and PostgreSQL's own verdict survives two objects down.
 */
function serializationFailure(): Error {
  return new Prisma.PrismaClientKnownRequestError('\nInvalid `prisma.$queryRaw()` invocation', {
    code: 'P2010',
    clientVersion: '7.9.1',
    meta: {
      driverAdapterError: {
        cause: { kind: 'postgres', originalCode: '40001', originalMessage: 'could not serialize access' },
      },
    },
  });
}

/** A runner whose first `failures` transactions abort, and that hands out a fresh client each time. */
function flaky(failures: number, error: () => Error) {
  const clients: object[] = [];
  let calls = 0;
  const runner: TransactionRunner<object> = {
    async $transaction<T>(work: (tx: object) => Promise<T>): Promise<T> {
      calls += 1;
      const tx = { attempt: calls };
      clients.push(tx);
      const result = await work(tx);
      if (calls <= failures) throw error();
      return result;
    },
  };
  return { runner, clients, calls: () => calls };
}

// The package's `src`, not `build`: the subject is the TypeScript a reviewer reads.
const SRC = path.resolve(__dirname, '../../src');
/** Nothing waits in these tests; the backoff itself is `transaction-retry.spec.ts`'s subject. */
const NO_WAIT = { sleep: async () => undefined };

const RETRIED_TRANSACTION_UNITS = TRANSACTION_UNITS.filter((unit) => unit.shape === 'TX_RETRIED');

for (const unit of RETRIED_TRANSACTION_UNITS) {
  test(`${unit.at} · commits after one 40P01`, async () => {
    const { runner, clients } = flaky(1, deadlock);
    const seen: object[] = [];
    const result = await withTransactionRetry(
      runner,
      async (tx) => {
        seen.push(tx);
        return 'committed';
      },
      { ...NO_WAIT, maxAttempts: unit.attempts, label: unit.at },
    );
    assert.equal(result, 'committed', 'the winning attempt’s result is what the caller gets');
    assert.equal(seen.length, 2, 'the whole closure runs again — not a resumed one');
    assert.deepEqual(seen, clients, 'each attempt got a fresh transaction client');
  });

  test(`${unit.at} · commits after one 40001`, async () => {
    const { runner } = flaky(1, serializationFailure);
    let runs = 0;
    const result = await withTransactionRetry(
      runner,
      async () => {
        runs += 1;
        return runs;
      },
      { ...NO_WAIT, maxAttempts: unit.attempts, label: unit.at },
    );
    assert.equal(runs, 2);
    assert.equal(result, 2, 'the value returned is the one the committed attempt produced');
  });

  test(`${unit.at} · exhausts into something the boundary answers 503`, async () => {
    const { runner, calls } = flaky(Number.MAX_SAFE_INTEGER, deadlock);
    let runs = 0;
    const thrown = await withTransactionRetry(
      runner,
      async () => {
        runs += 1;
      },
      { ...NO_WAIT, maxAttempts: unit.attempts, label: unit.at },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(thrown instanceof Error, 'exhaustion rethrows');
    assert.equal(runs, unit.attempts, `ran ${runs} times; the inventory declares ${unit.attempts}`);
    assert.equal(calls(), unit.attempts, 'one transaction per attempt, no more');
    // Rethrown UNCHANGED is the contract: the boundary classifies what it is given, so a loop
    // that wrapped its last failure would be a loop that turned its own 503 into a 500.
    assert.equal((thrown as { code?: string }).code, '40P01');
    const verdict = classifyTransactionError(thrown);
    assert.equal(verdict.retryable, true, 'the shared classifier is what makes this a 503');
    assert.equal(verdict.reason, 'DEADLOCK');
  });
}

test('the attempt budgets the inventory declares are the ones the code asks for', () => {
  // A unit that caps its attempts says so with `maxAttempts`; every other unit takes the default.
  // Checked at file granularity because that is the honest granularity of a source scan — but it
  // is enough: a file only contains `maxAttempts` when a unit in it is capped, and the inventory
  // has to name that unit for the sets to match.
  const capped = new Set(
    RETRIED_TRANSACTION_UNITS.filter(
      (unit) => unit.attempts !== DEFAULT_TRANSACTION_MAX_ATTEMPTS,
    ).map((unit) => unit.at.split('#')[0]),
  );
  const asks = new Set(
    [...new Set(RETRIED_TRANSACTION_UNITS.map((unit) => unit.at.split('#')[0]))].filter((rel) =>
      /maxAttempts:/.test(readFileSync(path.join(SRC, rel), 'utf8')),
    ),
  );
  assert.deepEqual(
    [...asks].sort(),
    [...capped].sort(),
    'a file caps its retry budget without the inventory saying so, or the other way round',
  );
  for (const unit of RETRIED_TRANSACTION_UNITS) {
    assert.ok(unit.attempts >= 1, `${unit.at} declares a budget of ${unit.attempts}`);
  }
  for (const unit of TRANSACTION_UNITS.filter((candidate) => candidate.shape === 'TX_BARE')) {
    assert.equal(unit.attempts, 1, `${unit.at} is bare but declares a retry budget`);
  }
});

test('a unit that declares a non-default isolation really asks for it', () => {
  for (const unit of TRANSACTION_UNITS) {
    if (!unit.isolation) continue;
    const [rel] = unit.at.split('#');
    const prismaIsolation = unit.isolation === 'REPEATABLE READ'
      ? 'RepeatableRead'
      : unit.isolation === 'SERIALIZABLE'
        ? 'Serializable'
        : null;
    assert.ok(prismaIsolation, `${unit.at} declares unknown isolation ${unit.isolation}`);
    assert.match(
      readFileSync(path.join(SRC, rel), 'utf8'),
      new RegExp(`isolationLevel: Prisma\\.TransactionIsolationLevel\\.${prismaIsolation}`),
      `${unit.at} declares ${unit.isolation} and ${rel} does not ask for it`,
    );
  }
});

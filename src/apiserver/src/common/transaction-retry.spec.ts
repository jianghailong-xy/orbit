import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  DEFAULT_TRANSACTION_MAX_ATTEMPTS,
  TransactionAttemptEvent,
  TransactionOptions,
  TransactionOutcomeEvent,
  TransactionRunner,
  classifyTransactionError,
  isTransientTransactionError,
  transactionRetryDelayMs,
  withTransactionRetry,
} from './transaction-retry';

/** A `PrismaClientKnownRequestError` as the client reports one, without constructing Prisma's. */
function knownRequestError(code: string, message = `Prisma error ${code}`): Error {
  return Object.assign(new Error(message), { code, meta: {}, clientVersion: '7.9.1' });
}

/** The shape Prisma gives a raw-query failure it could not map: the SQLSTATE only in the text. */
function unknownRequestError(message: string, cause?: unknown): Error {
  const error = Object.assign(new Error(message), { clientVersion: '7.9.1' });
  return cause === undefined ? error : Object.assign(error, { meta: { cause } });
}

test('a bare serialization failure and a bare deadlock are both retryable', () => {
  assert.deepEqual(classifyTransactionError(Object.assign(new Error('x'), { code: '40001' })), {
    retryable: true,
    reason: 'SERIALIZATION',
    evidence: '40001',
    depth: 0,
  });
  assert.deepEqual(classifyTransactionError(Object.assign(new Error('x'), { code: '40P01' })), {
    retryable: true,
    reason: 'DEADLOCK',
    evidence: '40P01',
    depth: 0,
  });
});

test("Prisma's own write-conflict code is retryable", () => {
  const verdict = classifyTransactionError(knownRequestError('P2034'));
  assert.deepEqual(verdict, { retryable: true, reason: 'WRITE_CONFLICT', evidence: 'P2034', depth: 0 });
  assert.equal(isTransientTransactionError(knownRequestError('P2034')), true);
});

/**
 * What Prisma 7 actually throws for a raw query PostgreSQL aborted: the top-level code is
 * `P2010` ("raw query failed") and the SQLSTATE is two objects further down, inside `meta`.
 * Captured from a real 40001 in transaction-retry.pg.spec.ts.
 */
function driverAdapterError(originalCode: string, originalMessage: string): Error {
  return Object.assign(
    new Error(
      'Invalid `prisma.$executeRawUnsafe()` invocation:\n\nRaw query failed. ' +
        `Code: \`${originalCode}\`. Message: \`${originalMessage}\``,
    ),
    {
      code: 'P2010',
      clientVersion: '7.9.1',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { originalCode, originalMessage, kind: 'TransactionWriteConflict' },
        },
      },
    },
  );
}

test("Prisma's driver-adapter wrapping is read structurally, not off the message", () => {
  const verdict = classifyTransactionError(
    driverAdapterError('40001', 'could not serialize access due to concurrent update'),
  );
  // The SQLSTATE itself, from `meta.driverAdapterError.cause` — not the `Code:` in the text.
  assert.deepEqual(verdict, { retryable: true, reason: 'SERIALIZATION', evidence: '40001', depth: 2 });
  assert.equal(
    classifyTransactionError(driverAdapterError('40P01', 'deadlock detected')).reason,
    'DEADLOCK',
  );
  // The same wrapping around a permanent failure must not become retryable just because the
  // top-level code is the generic P2010.
  const duplicate = driverAdapterError('23505', 'duplicate key value violates unique constraint');
  assert.deepEqual(classifyTransactionError(duplicate), { retryable: false, evidence: '23505', depth: 2 });
});

test('a SQLSTATE carried on meta rather than on the error is found', () => {
  const verdict = classifyTransactionError(Object.assign(new Error('raw query failed'), {
    meta: { code: '40P01' },
  }));
  assert.deepEqual(verdict, { retryable: true, reason: 'DEADLOCK', evidence: '40P01', depth: 0 });
});

test('a SQLSTATE that survives only in the message is still found', () => {
  // What `PrismaClientUnknownRequestError` looks like for a $executeRaw that lost a deadlock.
  const verdict = classifyTransactionError(unknownRequestError(
    'Invalid `prisma.$executeRaw()` invocation:\n\nRaw query failed. ' +
      'Code: `40P01`. Message: `deadlock detected`',
  ));
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.reason, 'DEADLOCK');
  assert.equal(verdict.evidence, 'message');
});

test('the driver message alone, with no SQLSTATE anywhere, is enough', () => {
  const verdict = classifyTransactionError(new Error(
    'could not serialize access due to read/write dependencies among transactions',
  ));
  assert.deepEqual(verdict, { retryable: true, reason: 'SERIALIZATION', evidence: 'message', depth: 0 });
});

test("Prisma's meta.cause text is read even when the message says nothing", () => {
  const verdict = classifyTransactionError(unknownRequestError(
    'Error occurred during query execution',
    'could not serialize access due to concurrent update',
  ));
  assert.deepEqual(verdict, { retryable: true, reason: 'SERIALIZATION', evidence: 'message', depth: 0 });
});

test('a SQLSTATE three wrappers down is found, and its depth is reported', () => {
  const driver = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  const prisma = unknownRequestError('Raw query failed', driver);
  const service = new Error('applying the decision failed', { cause: prisma });
  const outer = new Error('reconcile pass failed', { cause: service });

  const verdict = classifyTransactionError(outer);
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.reason, 'DEADLOCK');
  assert.equal(verdict.evidence, '40P01');
  assert.equal(verdict.depth, 3);
});

test('a cause chain that points back at itself terminates instead of hanging', () => {
  const a = new Error('outer') as Error & { cause?: unknown };
  const b = new Error('inner') as Error & { cause?: unknown };
  a.cause = b;
  b.cause = a;
  assert.deepEqual(classifyTransactionError(a), { retryable: false, evidence: undefined, depth: undefined });

  // The same cycle, with the transient evidence on the far side of it.
  const deadlock = Object.assign(new Error('victim'), { code: '40P01' });
  b.cause = deadlock;
  assert.equal(classifyTransactionError(a).reason, 'DEADLOCK');
});

test('a chain longer than the traversal cap terminates without a verdict it cannot justify', () => {
  let error = Object.assign(new Error('deep'), { code: '40001' }) as Error;
  for (let i = 0; i < 20; i += 1) error = new Error(`wrapper ${i}`, { cause: error });
  assert.equal(classifyTransactionError(error).retryable, false);
});

test('business exceptions are answered, not retried', () => {
  for (const exception of [new ConflictException('already claimed'), new BadRequestException('bad id')]) {
    const verdict = classifyTransactionError(exception);
    assert.equal(verdict.retryable, false, exception.message);
    assert.equal(verdict.evidence, `http:${exception.getStatus()}`);
  }
  // Even when a genuine deadlock is what the layer below reported: someone already decided the
  // answer this request gets, and re-running the transaction would re-run that decision.
  const wrapped = new ConflictException('already claimed', {
    cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
  });
  assert.equal(classifyTransactionError(wrapped).retryable, false);
});

test('constraint violations and Prisma statement errors are not retried', () => {
  for (const code of ['23503', '23505', 'P2002', 'P2003', 'P2025']) {
    const verdict = classifyTransactionError(knownRequestError(code));
    assert.equal(verdict.retryable, false, code);
    assert.equal(verdict.evidence, code);
  }
  // The unique-violation text mentions nothing transient, but the code is what settles it.
  assert.equal(
    isTransientTransactionError(knownRequestError('23505', 'duplicate key value violates unique constraint')),
    false,
  );
});

test('an ordinary unknown error is not retried', () => {
  assert.deepEqual(classifyTransactionError(new Error('boom')), {
    retryable: false,
    evidence: undefined,
    depth: undefined,
  });
  for (const value of [undefined, null, 'a string', 42, {}]) {
    assert.equal(isTransientTransactionError(value), false, String(value));
  }
});

test('an aborted transaction outranks a statement code nested under it', () => {
  // The server rolled the transaction back, so the unique violation it also reported is about a
  // statement that no longer happened.
  const inner = knownRequestError('P2002', 'Unique constraint failed');
  const outer = Object.assign(new Error('transaction aborted'), { code: '40001', cause: inner });
  assert.equal(classifyTransactionError(outer).reason, 'SERIALIZATION');
});

test('the backoff is exponential, bounded, and jittered only downwards', () => {
  const policy = { baseDelayMs: 10, maxDelayMs: 40, jitterRatio: 0.5 };
  // random() === 0 is the no-jitter case: the bare exponential, clamped at maxDelayMs.
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((n) => transactionRetryDelayMs(n, { ...policy, random: () => 0 })),
    [10, 20, 40, 40, 40],
  );
  // random() === 1 subtracts the whole jitter span, which is what bounds the wait from below.
  assert.deepEqual(
    [1, 2, 3].map((n) => transactionRetryDelayMs(n, { ...policy, random: () => 1 })),
    [5, 10, 20],
  );
  assert.deepEqual(
    [1, 2, 3].map((n) => transactionRetryDelayMs(n, { ...policy, random: () => 0.5 })),
    [8, 15, 30],
  );
  // The default policy never waits longer than its own ceiling, whatever Math.random returns.
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const waited = transactionRetryDelayMs(attempt);
    assert.ok(waited >= 0 && waited <= 400, `attempt ${attempt} waited ${waited}ms`);
  }
});

/** A `$transaction` whose per-attempt outcome the test scripts, recording what it was handed. */
function fakeRunner(script: Array<'ok' | unknown>): {
  runner: TransactionRunner<{ tag: string }>;
  calls: Array<{ options?: TransactionOptions; tx: { tag: string } }>;
} {
  const calls: Array<{ options?: TransactionOptions; tx: { tag: string } }> = [];
  const runner: TransactionRunner<{ tag: string }> = {
    async $transaction<T>(work: (tx: { tag: string }) => Promise<T>, options?: TransactionOptions): Promise<T> {
      // A new client per attempt, exactly as a new BEGIN would give the closure.
      const tx = { tag: `tx-${calls.length + 1}` };
      calls.push({ options, tx });
      const step = script[calls.length - 1];
      const result = await work(tx);
      if (step !== 'ok') throw step;
      return result;
    },
  };
  return { runner, calls };
}

test('a transient failure re-runs the whole closure in a brand-new transaction', async () => {
  const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  const { runner, calls } = fakeRunner([deadlock, deadlock, 'ok']);
  const seen: string[] = [];
  const slept: number[] = [];

  const result = await withTransactionRetry(
    runner,
    async (tx) => {
      seen.push(tx.tag);
      return seen.length;
    },
    { baseDelayMs: 10, jitterRatio: 0, sleep: async (ms) => void slept.push(ms) },
  );

  assert.equal(result, 3);
  // Three complete runs of the closure, each against its own transaction client.
  assert.deepEqual(seen, ['tx-1', 'tx-2', 'tx-3']);
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [10, 20]);
});

test('the caller transaction options are handed to every attempt unchanged', async () => {
  const transaction: TransactionOptions = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 1_234,
    timeout: 5_678,
  };
  const conflict = knownRequestError('P2034');
  const { runner, calls } = fakeRunner([conflict, 'ok']);

  await withTransactionRetry(runner, async () => 'done', { transaction, sleep: async () => undefined });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    // Identity, not a copy: nothing between the caller and Prisma may rewrite the isolation level
    // or the timeouts on a retry.
    assert.equal(call.options, transaction);
  }
});

test('a non-transient failure is rethrown on the first attempt', async () => {
  const conflict = new ConflictException('already claimed');
  const { runner, calls } = fakeRunner([conflict, 'ok']);
  const outcomes: TransactionOutcomeEvent[] = [];

  await assert.rejects(
    withTransactionRetry(runner, async () => 'unused', {
      onOutcome: (event) => void outcomes.push(event),
      sleep: async () => assert.fail('a non-transient failure must not wait'),
    }),
    (thrown: unknown) => thrown === conflict,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(outcomes.map((o) => o.outcome), ['FAILED']);
});

test('attempts are bounded and the last error is rethrown unchanged', async () => {
  const serialization = Object.assign(new Error('could not serialize access'), { code: '40001' });
  const { runner, calls } = fakeRunner(Array(10).fill(serialization));

  await assert.rejects(
    withTransactionRetry(runner, async () => 'unused', { maxAttempts: 3, sleep: async () => undefined }),
    (thrown: unknown) => thrown === serialization,
  );
  assert.equal(calls.length, 3);

  // maxAttempts = 1 is a single attempt, not a single retry.
  const single = fakeRunner([serialization]);
  await assert.rejects(
    withTransactionRetry(single.runner, async () => 'unused', { maxAttempts: 1, sleep: async () => undefined }),
    (thrown: unknown) => thrown === serialization,
  );
  assert.equal(single.calls.length, 1);

  await assert.rejects(
    withTransactionRetry(fakeRunner(['ok']).runner, async () => 'unused', { maxAttempts: 0 }),
    RangeError,
  );
});

test('the default is four attempts', async () => {
  const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  const { runner, calls } = fakeRunner(Array(10).fill(deadlock));
  await assert.rejects(
    withTransactionRetry(runner, async () => 'unused', { sleep: async () => undefined }),
    (thrown: unknown) => thrown === deadlock,
  );
  assert.equal(calls.length, DEFAULT_TRANSACTION_MAX_ATTEMPTS);
});

test('the hooks report every attempt and every outcome structurally', async () => {
  const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  const { runner } = fakeRunner([deadlock, 'ok']);
  const attempts: TransactionAttemptEvent[] = [];
  const outcomes: TransactionOutcomeEvent[] = [];

  await withTransactionRetry(runner, async () => 'done', {
    label: 'project.reconcile',
    baseDelayMs: 30,
    jitterRatio: 0,
    sleep: async () => undefined,
    onAttempt: (event) => void attempts.push(event),
    onOutcome: (event) => void outcomes.push(event),
  });

  assert.deepEqual(attempts, [
    { label: 'project.reconcile', attempt: 1, maxAttempts: 4, retryOf: undefined },
    {
      label: 'project.reconcile',
      attempt: 2,
      maxAttempts: 4,
      retryOf: { reason: 'DEADLOCK', evidence: '40P01', delayMs: 30 },
    },
  ]);
  assert.deepEqual(outcomes, [
    {
      label: 'project.reconcile',
      attempt: 1,
      maxAttempts: 4,
      outcome: 'RETRYING',
      reason: 'DEADLOCK',
      evidence: '40P01',
      delayMs: 30,
      error: deadlock,
    },
    { label: 'project.reconcile', attempt: 2, maxAttempts: 4, outcome: 'COMMITTED' },
  ]);
});

test('an exhausted retry is reported as exhausted, not as a plain failure', async () => {
  const serialization = Object.assign(new Error('could not serialize access'), { code: '40001' });
  const { runner } = fakeRunner([serialization, serialization]);
  const outcomes: TransactionOutcomeEvent[] = [];

  await assert.rejects(
    withTransactionRetry(runner, async () => 'unused', {
      maxAttempts: 2,
      sleep: async () => undefined,
      onOutcome: (event) => void outcomes.push(event),
    }),
    (thrown: unknown) => thrown === serialization,
  );
  assert.deepEqual(outcomes.map((o) => o.outcome), ['RETRYING', 'EXHAUSTED']);
  assert.equal(outcomes[1].reason, 'SERIALIZATION');
});

test('a hook that throws cannot fail a transaction that committed', async () => {
  const { runner } = fakeRunner(['ok']);
  const result = await withTransactionRetry(runner, async () => 'done', {
    onAttempt: () => {
      throw new Error('telemetry is down');
    },
    onOutcome: () => {
      throw new Error('telemetry is still down');
    },
  });
  assert.equal(result, 'done');
});

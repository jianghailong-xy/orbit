import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';

import { ArgumentsHost, ConflictException, HttpException, HttpServer } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS, transientDbConflictBody } from '@orbit/shared';

import {
  DURATION_BUCKETS_MS,
  MAX_SERIES,
  dbConflictMetricsSnapshot,
  recordTransactionUnit,
  renderDbConflictMetrics,
  resetDbConflictMetrics,
} from './db-conflict-metrics';
import { TransactionRunner, withTransactionRetry } from './transaction-retry';
import { TransientDbConflictFilter } from './transient-db-conflict.filter';

/**
 * What the conflict counters say, and what they must never say.
 *
 * Four situations produce a conflict and they mean four different things: one the retry loop
 * absorbed, one it absorbed after two goes, one it ran out of attempts on, and one that reached the
 * API boundary without any loop having tried at all. An operator's whole job during an incident is
 * telling those apart, so each is asserted here as EXACTLY ONE row with EXACTLY the right labels —
 * `deepEqual` on the whole snapshot rather than a lookup, because a counter that also incremented
 * something else is wrong in the way that matters and a lookup would not see it.
 *
 * The other half is what a label may contain. A metric labelled with a task id is not a metric; it
 * is a database with worse tooling, and it fails at the moment it is needed most. So the values are
 * checked against the closed sets they come from, an operation that is not the shape of one is
 * proven to fold into a constant, and the registry is proven to stop growing rather than to grow.
 */

const CLIENT_VERSION = '7.9.1';

/**
 * Everything a leak would consist of, planted where PostgreSQL and Prisma really plant it: the
 * statement, the table, the bound parameters — which on this table are a user's prompt — and a
 * credential that was in the row being written. The same list `transient-db-conflict.spec.ts`
 * asserts the RESPONSE never repeats, asserted here about the metrics instead.
 */
const SECRETS = [
  'UPDATE "conversation_turn"',
  'conversation_turn',
  'sk-ant-oat01-not-a-real-token',
  'summarise my private notes',
  '$1, $2, $3',
  'postgresql://orbit:hunter2@db:5432/orbit',
];

const LEAKY_DETAIL =
  'UPDATE "conversation_turn" SET "text" = $1, "token" = $2 WHERE "id" = $3 · params: ' +
  '($1, $2, $3) = ("summarise my private notes", "sk-ant-oat01-not-a-real-token", 42) · ' +
  'connection postgresql://orbit:hunter2@db:5432/orbit';

/** What Prisma 7 throws for a raw write PostgreSQL aborted: the SQLSTATE two objects down. */
function abortedWrite(originalCode: string, originalMessage: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Invalid \`prisma.$executeRawUnsafe()\` invocation:\n\nRaw query failed. ` +
      `Code: \`${originalCode}\`. Message: \`${originalMessage}\`\n${LEAKY_DETAIL}`,
    {
      code: 'P2010',
      clientVersion: CLIENT_VERSION,
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { originalCode, originalMessage, kind: 'TransactionWriteConflict' },
        },
      },
    },
  );
}

const deadlock = () => abortedWrite('40P01', 'deadlock detected');
const serialization = () =>
  abortedWrite('40001', 'could not serialize access due to concurrent update');

/** Prisma's own name for the same event, which a model write raises instead of a SQLSTATE. */
const writeConflict = () =>
  new Prisma.PrismaClientKnownRequestError(
    `Transaction failed due to a write conflict or a deadlock. Please retry your transaction\n${LEAKY_DETAIL}`,
    { code: 'P2034', clientVersion: CLIENT_VERSION },
  );

/** The failure Prisma could not map at all: no code anywhere, the SQLSTATE only in the text. */
const unmappedDeadlock = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'Invalid `prisma.$executeRaw()` invocation:\n\nRaw query failed. ' +
      `Code: \`40P01\`. Message: \`deadlock detected\`\n${LEAKY_DETAIL}`,
    { clientVersion: CLIENT_VERSION },
  );

/** A `$transaction` whose per-attempt outcome the test scripts. */
function fakeRunner(script: Array<'ok' | unknown>): TransactionRunner<{ tag: string }> {
  let call = 0;
  return {
    async $transaction<T>(work: (tx: { tag: string }) => Promise<T>): Promise<T> {
      call += 1;
      const result = await work({ tag: `tx-${call}` });
      const step = script[call - 1];
      if (step !== 'ok') throw step;
      return result;
    },
  };
}

/** Run a unit through the shared loop with the waits removed. */
const run = (operation: string, script: Array<'ok' | unknown>, maxAttempts?: number) =>
  withTransactionRetry(fakeRunner(script), async () => 'written', {
    label: operation,
    maxAttempts,
    sleep: async () => undefined,
  });

/** The unit counter, with the duration dropped: a wall time is never the same twice. */
function units(): Array<{ labels: Record<string, string>; value: number }> {
  return dbConflictMetricsSnapshot().units;
}

function responses(): Array<{ labels: Record<string, string>; value: number }> {
  return dbConflictMetricsSnapshot().responses;
}

/** An `ArgumentsHost` shaped like the one Nest hands a global filter. */
function hostWith(request: Record<string, unknown>): ArgumentsHost {
  return {
    getType: () => 'http',
    getClass: () => null,
    getArgByIndex: (i: number) => (i === 0 ? request : {}),
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ArgumentsHost;
}

/** The boundary, wired to record nothing else. */
function boundary(): TransientDbConflictFilter {
  const adapter = { isHeadersSent: () => false, setHeader: () => undefined } as unknown as HttpServer;
  return new TransientDbConflictFilter({ catch: () => undefined }, adapter);
}

beforeEach(() => resetDbConflictMetrics());

// ----------------------------------------------------------------------------------------------
// The four situations, each counted exactly once and in exactly one place.
// ----------------------------------------------------------------------------------------------

test('a conflict one retry absorbed is one committed unit that says it was absorbed', async () => {
  await run('tasks.create', [deadlock(), 'ok']);

  assert.deepEqual(units(), [
    {
      labels: {
        operation: 'tasks.create',
        outcome: 'committed',
        handling: 'absorbed',
        origin: 'service',
        classifier: 'deadlock',
        sqlstate: '40P01',
        attempt: '2',
      },
      value: 1,
    },
  ]);
  // The caller was never turned away, so nothing was answered. A conflict that shows up in both
  // counters would double every rate an operator computes from them.
  assert.deepEqual(responses(), []);
});

test('a conflict two retries absorbed says two, and still only committed once', async () => {
  await run('tasks.createMany', [serialization(), serialization(), 'ok']);

  assert.deepEqual(units(), [
    {
      labels: {
        operation: 'tasks.createMany',
        outcome: 'committed',
        handling: 'absorbed',
        origin: 'service',
        classifier: 'serialization',
        sqlstate: '40001',
        attempt: '3',
      },
      value: 1,
    },
  ]);
  assert.deepEqual(responses(), []);
});

test('a retry loop that spent its attempts is a conflict, not a commit and not a failure', async () => {
  await assert.rejects(run('runnerApi.events', [deadlock(), deadlock(), deadlock()], 3));

  assert.deepEqual(units(), [
    {
      labels: {
        operation: 'runnerApi.events',
        outcome: 'conflict',
        handling: 'exhausted',
        origin: 'service',
        classifier: 'deadlock',
        sqlstate: '40P01',
        attempt: '3',
      },
      value: 1,
    },
  ]);
});

test('a conflict with no retry loop behind it is the boundary alone, and says so', () => {
  boundary().catch(deadlock(), hostWith({ method: 'POST', route: { path: '/tasks' } }));

  // Nothing ran it, so there is no unit to count. `boundary_only` is the label that says a write
  // path reached the floor without a loop having tried — the one an audit acts on.
  assert.deepEqual(units(), []);
  assert.deepEqual(responses(), [
    {
      labels: {
        method: 'POST',
        route: '/tasks',
        handling: 'boundary_only',
        classifier: 'deadlock',
        sqlstate: '40P01',
        origin: 'service',
      },
      value: 1,
    },
  ]);
});

test('an exhausted conflict answered 503 is one unit and one response, never two of either', async () => {
  const escaped = await run('sessions.insertTurn', [deadlock(), deadlock()], 2).catch((e: unknown) => e);
  boundary().catch(escaped, hostWith({ method: 'POST', route: { path: '/sessions/:id/turns' } }));

  assert.equal(units().length, 1, 'the loop counted its own exhaustion');
  assert.equal(units()[0].labels.handling, 'exhausted');
  assert.deepEqual(responses(), [
    {
      labels: {
        method: 'POST',
        route: '/sessions/:id/turns',
        handling: 'exhausted',
        classifier: 'deadlock',
        sqlstate: '40P01',
        origin: 'service',
      },
      value: 1,
    },
  ]);
  // The distinction the WeakSet buys: this 503 is NOT evidence of an unretried path.
  assert.equal(
    responses().filter((series) => series.labels.handling === 'boundary_only').length,
    0,
    'an exhausted retry was counted a second time as a path that never retried',
  );
});

test('all three codes get one answer outward and three classifiers inward', () => {
  // The two halves of this contract pull in opposite directions and both are deliberate. A CALLER
  // must not be able to tell a deadlock from a failed serialization from a write conflict: the
  // answer is one constant body, one status and one Retry-After, because the difference is about
  // the server's locking and telling a client would be a leak with no use. An OPERATOR must be
  // able to tell them apart, because the three have different causes and different fixes. So the
  // response is asserted identical across all three, and the metric is asserted different.
  const answers: Array<{ status: number; body: unknown; retryAfter: string[] }> = [];
  for (const conflict of [deadlock(), serialization(), writeConflict(), unmappedDeadlock()]) {
    const retryAfter: string[] = [];
    const adapter = {
      isHeadersSent: () => false,
      setHeader: (_response: unknown, name: string, value: string) => {
        if (name === 'Retry-After') retryAfter.push(value);
      },
    } as unknown as HttpServer;
    let handed: unknown;
    new TransientDbConflictFilter({ catch: (e: unknown) => void (handed = e) }, adapter).catch(
      conflict,
      hostWith({ method: 'POST', route: { path: '/tasks' } }),
    );
    const answer = handed as HttpException;
    answers.push({ status: answer.getStatus(), body: answer.getResponse(), retryAfter });
  }

  const [first] = answers;
  assert.equal(first.status, 503);
  assert.deepEqual(first.body, transientDbConflictBody(), 'the served body is the shared contract');
  assert.deepEqual(first.retryAfter, [String(TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS)]);
  for (const answer of answers) {
    assert.deepEqual(answer, first, 'two of the four conflicts are answered differently');
  }

  // The same four events, told apart. `message` is the fourth: a wrapper that kept the driver's
  // wording and dropped every structured field, which is still a deadlock and still says so.
  assert.deepEqual(
    responses().map((series) => [series.labels.classifier, series.labels.sqlstate]),
    [
      ['deadlock', '40P01'],
      ['serialization', '40001'],
      ['write_conflict', 'P2034'],
      ['deadlock', 'message'],
    ],
  );
});

// ----------------------------------------------------------------------------------------------
// The ordinary paths, which are the denominator of every rate above.
// ----------------------------------------------------------------------------------------------

test('a transaction that committed first go is counted, and says nothing happened', async () => {
  await run('workspaces.reorder', ['ok']);

  assert.deepEqual(units(), [
    {
      labels: {
        operation: 'workspaces.reorder',
        outcome: 'committed',
        handling: 'none',
        origin: 'service',
        classifier: 'none',
        sqlstate: 'none',
        attempt: '1',
      },
      value: 1,
    },
  ]);
});

test('the four families a failure can be are four different classifiers', async () => {
  // Not retried, and not the same thing as each other: a duplicate key is Tuesday, a database with
  // no connections left is an incident, and a refusal a service already turned into a 409 is
  // neither. One `retryable: false` used to be all three.
  await assert.rejects(run('tasks.update', [abortedWrite('23505', 'duplicate key value')]));
  await assert.rejects(run('queue.buildSession', [abortedWrite('53300', 'too many connections')]));
  await assert.rejects(run('projects.update', [new ConflictException('that slug is taken')]));
  await assert.rejects(run('reaper.forceFinalize', [new TypeError('undefined is not a function')]));

  assert.deepEqual(
    units().map((series) => [series.labels.operation, series.labels.outcome, series.labels.classifier]),
    [
      ['tasks.update', 'failed', 'permanent'],
      ['queue.buildSession', 'failed', 'resource'],
      ['projects.update', 'failed', 'answered'],
      ['reaper.forceFinalize', 'failed', 'unclassified'],
    ],
  );
  // None of them waited or ran twice: a classifier is a label, not a second retry policy.
  for (const series of units()) assert.equal(series.labels.attempt, '1');
});

test('a fault injected on purpose is labelled as one, and only a harness can say so', async () => {
  const before = process.env.ORBIT_DB_CONFLICT_ORIGIN;
  process.env.ORBIT_DB_CONFLICT_ORIGIN = 'fault_injection';
  try {
    await run('tasks.create', [deadlock(), 'ok']);
  } finally {
    if (before === undefined) delete process.env.ORBIT_DB_CONFLICT_ORIGIN;
    else process.env.ORBIT_DB_CONFLICT_ORIGIN = before;
  }

  assert.equal(units()[0].labels.origin, 'fault_injection');
  // And back to the default the moment the harness's environment is gone: the label is a property
  // of the process, so no production code path can reach it.
  resetDbConflictMetrics();
  await run('tasks.create', [deadlock(), 'ok']);
  assert.equal(units()[0].labels.origin, 'service');
});

// ----------------------------------------------------------------------------------------------
// Cardinality: what a label may be, and what happens when it is not that.
// ----------------------------------------------------------------------------------------------

/** Every value a label is allowed to take, other than `operation`, `sqlstate` and `route`. */
const CLOSED = {
  outcome: new Set(['committed', 'conflict', 'failed', 'overflow']),
  handling: new Set(['none', 'absorbed', 'exhausted', 'boundary_only', 'overflow']),
  classifier: new Set([
    'none', 'deadlock', 'serialization', 'write_conflict', 'resource', 'permanent', 'answered',
    'unclassified', 'overflow',
  ]),
  origin: new Set(['service', 'fault_injection', 'overflow']),
};

test('no label carries anything a caller sent, on any path that can produce one', async () => {
  await run('tasks.create', [deadlock(), 'ok']);
  await run('tasks.delete', ['ok']);
  await assert.rejects(run('taskLists.remove', [serialization(), serialization()], 2));
  await assert.rejects(run('projects.remove', [abortedWrite('23503', 'violates foreign key')]));
  boundary().catch(deadlock(), hostWith({ method: 'DELETE', route: { path: '/tasks/:id' } }));

  const snapshot = dbConflictMetricsSnapshot();
  const everything = [...snapshot.units, ...snapshot.responses, ...snapshot.durations];
  assert.ok(everything.length > 0, 'nothing was recorded, so nothing was checked');

  for (const series of everything) {
    for (const [name, value] of Object.entries(series.labels)) {
      const closed = CLOSED[name as keyof typeof CLOSED];
      if (closed) {
        assert.ok(closed.has(value), `${name}="${value}" is not one of the values ${name} may take`);
        continue;
      }
      // The three shape-tested labels. A UUID, a base62 public id or a bearer token fails all of
      // them, which is the property being asserted: the shapes admit names, not identities.
      if (name === 'operation') {
        assert.match(value, /^(?:[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*|other|unlabelled|overflow)$/);
      } else if (name === 'sqlstate') {
        assert.match(value, /^(?:[0-9A-Z]{5}|http:[0-9]{3}|message|none|other|overflow)$/);
      } else if (name === 'attempt') {
        assert.match(value, /^(?:[1-9][0-9]?|99\+|overflow)$/, 'an attempt counter is not bounded');
      } else if (name === 'method') {
        assert.match(value, /^(?:[A-Z]{3,7}|other|overflow)$/);
      } else if (name === 'route') {
        assert.match(value, /^(?:\/[A-Za-z0-9/:._-]*|other|overflow)$/);
        assert.ok(!value.includes('?'), 'a query string carries tokens and must never be a label');
      } else {
        assert.fail(`${name} is a label nothing has declared what may go in it`);
      }
    }
  }
});

test('an operation that is an identity rather than a name folds into one constant', () => {
  // The shapes above admit `tasks.create` and refuse this. Asserted from the recording side too,
  // because the shape test is the only thing between a caller's variable and a series per row.
  for (const identity of [
    '34Aqf7cbwLzqRhLOSgbRa/create',
    'tasks.create#f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
    'sk-ant-oat01-not-a-real-token',
    'x'.repeat(200),
  ]) {
    recordTransactionUnit({
      operation: identity,
      outcome: 'committed',
      handling: 'none',
      attempts: 1,
      durationMs: 1,
    });
  }

  assert.deepEqual(
    units().map((series) => [series.labels.operation, series.value]),
    [['other', 4]],
    'four identities became four series instead of one constant',
  );
});

test('a request path that is not a route template cannot become a label', () => {
  // Nest gives the boundary `request.route.path`, which is the TEMPLATE — `/sessions/:id/turns`,
  // never the URL. That is a fact about Nest, and the thing it protects is large: an Orbit URL
  // carries the SSE `access_token` and attachment tokens in its query string, and a metric outlives
  // the request that made it. So the shape is enforced where the label is made.
  for (const path of [
    '/api/sessions/2LHLVc46kYLDCuhhRXXzj5/events?access_token=eyJhbGciOiJIUzI1NiJ9.leaked',
    '/api/attachments/f81d4fae-7dec-11d0-a765-00a0c91e6bf6/download',
    `/api/${'x'.repeat(200)}`,
  ]) {
    boundary().catch(deadlock(), hostWith({ method: 'GET', route: { path } }));
  }

  assert.deepEqual(
    responses().map((series) => [series.labels.route, series.value]),
    [['other', 2], ['/api/attachments/f81d4fae-7dec-11d0-a765-00a0c91e6bf6/download', 1]],
    'a URL with a query string reached a label',
  );
  // The middle one is admitted because it IS the shape of a route: a template with an id already
  // substituted is indistinguishable from one without, and refusing it would mean refusing every
  // real route. What bounds it is the series cap, not this test — which is why the cap exists.
});

test('a code the classifier did not produce cannot become a label either', () => {
  // `sqlstate` is the second caller-supplied value, and today everything that reaches it comes from
  // a closed set the classifier owns. That is a fact about the classifier, not about this registry,
  // and it is the kind of fact a later change quietly ends: `evidence` is a string field on an
  // error object. So the shape is enforced HERE, where the label is made, and asserted here.
  for (const evidence of [
    'Raw query failed. Code: `40001`. Message: `could not serialize access`',
    'postgresql://orbit:hunter2@db:5432/orbit',
    '23505 on task_owner_id_title_key',
    'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
  ]) {
    recordTransactionUnit({
      operation: 'tasks.create',
      outcome: 'failed',
      handling: 'none',
      attempts: 1,
      durationMs: 1,
      error: { family: 'UNCLASSIFIED', evidence },
    });
  }

  assert.deepEqual(
    units().map((series) => [series.labels.sqlstate, series.value]),
    [['other', 4]],
    'a driver message reached a label; four of them became four series',
  );
});

test('an attempt counter is bounded by the metric, not by what a caller asked for', () => {
  // No unit in the tree declares a budget above four, so this is unreachable today. It is here so
  // the bound belongs to the metric: a caller that one day passes `maxAttempts: 100_000` should
  // make its own transactions slow, not make the monitoring unusable for everything else.
  for (const attempts of [4, 99, 100, 100_000]) {
    recordTransactionUnit({
      operation: 'tasks.create',
      outcome: 'committed',
      handling: 'absorbed',
      attempts,
      durationMs: 1,
    });
  }

  assert.deepEqual(
    units().map((series) => [series.labels.attempt, series.value]),
    [['4', 1], ['99', 1], ['99+', 2]],
  );
});

test('the registry stops growing rather than growing without a bound', () => {
  for (let n = 0; n < MAX_SERIES + 50; n += 1) {
    recordTransactionUnit({
      operation: `op.n${n}`,
      outcome: 'committed',
      handling: 'none',
      attempts: 1,
      durationMs: 1,
    });
  }

  const series = units();
  assert.ok(series.length <= MAX_SERIES + 1, `the registry grew to ${series.length} series`);
  const overflow = series.find((one) => one.labels.operation === 'overflow');
  assert.ok(overflow, 'the cap was reached and nothing said so');
  // Visible, not dropped: the excess is counted in one place so a cap that is being hit looks like
  // a number climbing rather than like silence.
  assert.equal(overflow.value, 50);
});

// ----------------------------------------------------------------------------------------------
// The exposition: what a scraper and a `curl` in the runbook actually read.
// ----------------------------------------------------------------------------------------------

test('the duration histogram is cumulative, and its buckets add up to its count', () => {
  for (const durationMs of [0.5, 3, 40, 900, 60_000]) {
    recordTransactionUnit({
      operation: 'tasks.create',
      outcome: 'committed',
      handling: 'none',
      attempts: 1,
      durationMs,
    });
  }

  const [histogram] = dbConflictMetricsSnapshot().durations;
  assert.equal(histogram.count, 5);
  assert.equal(histogram.sum, 0.5 + 3 + 40 + 900 + 60_000);
  // Cumulative: every bucket holds everything at or below its bound, so the series never falls.
  for (let index = 1; index < histogram.buckets.length; index += 1) {
    assert.ok(histogram.buckets[index] >= histogram.buckets[index - 1], 'a bucket went backwards');
  }
  assert.equal(histogram.buckets[0], 1, 'the 1ms bucket holds the 0.5ms sample');
  // The last bound is 5s and one sample is a minute: an unbounded bucket that equalled the last
  // bounded one would hide every slow transaction there is.
  assert.equal(histogram.buckets[histogram.buckets.length - 1], 4);
});

test('the exposition is Prometheus text, and every series it names is declared', async () => {
  await run('tasks.create', [deadlock(), 'ok']);
  boundary().catch(serialization(), hostWith({ method: 'POST', route: { path: '/tasks' } }));

  const text = renderDbConflictMetrics();
  for (const name of [
    'orbit_db_transaction_units_total',
    'orbit_db_conflict_responses_total',
    'orbit_db_transaction_duration_ms',
  ]) {
    assert.ok(text.includes(`# HELP ${name} `), `${name} has no HELP line`);
    assert.ok(text.includes(`# TYPE ${name} `), `${name} has no TYPE line`);
  }
  assert.ok(text.includes(`le="${DURATION_BUCKETS_MS[0]}"`), 'the buckets are not exposed');
  assert.ok(text.includes('le="+Inf"'), 'the unbounded bucket is missing, so the histogram is invalid');
  assert.ok(text.endsWith('\n'), 'the exposition must end with a newline');
  // Every sample line is `name{labels} value`, with no unquoted or unescaped label value: the
  // shapes upstream are what make that true, so this is where a widened shape would be caught.
  for (const line of text.trim().split('\n')) {
    if (line.startsWith('#')) continue;
    assert.match(line, /^[a-z_]+(?:\{[a-z_]+="[^"\\\n]*"(?:,[a-z_]+="[^"\\\n]*")*\})? [0-9.+eIn-]+$/, line);
  }
});

test('nothing the database said reaches the metrics', async () => {
  // The error carries the statement, the table, the bound parameters — which on this table are a
  // user's prompt — a credential and a DSN with a password. Every path that can record something
  // is driven with it, and then the whole exposition is searched.
  await run('sessions.insertTurn', [deadlock(), 'ok']);
  await assert.rejects(run('sessions.createTurn', [serialization(), serialization()], 2));
  await assert.rejects(run('tasks.update', [abortedWrite('23505', 'duplicate key value')]));
  boundary().catch(deadlock(), hostWith({ method: 'POST', route: { path: '/sessions/:id/turns' } }));

  const text = renderDbConflictMetrics();
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), `the metrics repeat ${secret}`);
  }
  assert.ok(!/\bat .*\.(?:ts|js):\d+/.test(text), 'the metrics carry a stack frame');
  assert.ok(!/SELECT |UPDATE |INSERT |DELETE FROM/.test(text), 'the metrics carry SQL');
  assert.ok(!text.includes('Raw query failed'), 'the metrics repeat the driver');
});

// ----------------------------------------------------------------------------------------------
// The wiring, and the one property no runtime test can establish.
// ----------------------------------------------------------------------------------------------

/** The source tree, not the compiled one: this reads what is written, from `build/common`. */
const SRC = path.resolve(__dirname, '../..', 'src');

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, found);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) found.push(full);
  }
  return found;
}

test('every operation label in the tree is a constant, so none can carry an id', () => {
  // The runtime shape test folds an identity into `other`, which contains the damage. This is what
  // prevents it: an operation name is a literal a reviewer can read, never an expression evaluated
  // per request. A template literal here — `tasks.create.${task.id}` — is the one way a caller
  // could put a row into a label, and it cannot be merged.
  const NAMES = /(?:loggedRetry\(\s*[\w.]+\s*,|transientWriteRetry\()\s*([^,)\n]+)/g;
  const offenders: string[] = [];
  let indirect = 0;

  for (const file of sources(SRC)) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    const code = readFileSync(file, 'utf8');
    for (const [, argument] of code.matchAll(NAMES)) {
      const value = argument.trim();
      if (/^'[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*'$/.test(value)) continue;
      // The one hop: `TasksService#transientWriteRetry` DECLARES the name as a parameter and passes
      // it straight on, and every one of ITS call sites is a literal caught by the rule above.
      // Both halves are counted, so a second helper cannot appear without this number moving.
      if (value === 'operation' || value === 'operation: string') {
        indirect += 1;
        continue;
      }
      offenders.push(`${relative}: ${value}`);
    }
  }

  assert.deepEqual(offenders, [], 'an operation label is computed rather than written');
  assert.equal(indirect, 2, 'a second indirection appeared; the argument above covers exactly one');
});

test('the metrics endpoint is registered and behind the ordinary token', () => {
  const controller = readFileSync(path.join(SRC, 'metrics', 'metrics.controller.ts'), 'utf8');
  assert.match(controller, /@UseGuards\(JwtAuthGuard\)/, 'the counters are readable without a token');
  assert.match(
    readFileSync(path.join(SRC, 'app.module.ts'), 'utf8'),
    /MetricsModule,/,
    'the metrics module is not registered, so nothing can read the counters',
  );
});

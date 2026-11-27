import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { RunFailureKind, USAGE_LIMIT_ERROR_MARKERS } from '@orbit/shared';
import { failureKindIs, failureKindIsNot, failureKindIsSql } from '../common/run-failure-kind-filter';
import { CLEARED_RUN_FAILURE, runFailureColumns } from './run-failure-columns';
import { movableFailure } from './subagent-run';
import { runNotCounted } from '../common/run-not-counted';

/**
 * The server's readers of a failure's kind (docs/routing-account-health-design.md §5.4): the columns a run's end
 * writes, the SubAgent move, and the SQL twins of runFailureKind. Each prefers the runner's kind and falls back to the
 * legacy markers for a runner that sends none (§10 Mixed versions).
 */

const CODEX_LIMIT = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.";
const SIGNED_OUT = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const EDGE_BLOCK = 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare';
const CURSOR_PAYMENT = 'Cursor said: "Add a payment method to continue." The Cursor account needs this before the session can go on.';

test('runFailureColumns: a new runner\'s classification is stored, an old runner\'s absence is stored as nulls', () => {
  assert.deepEqual(
    runFailureColumns({ failure: { kind: 'CAPACITY', scope: 'model', said: 'Selected model is at capacity' }, admission: true }, true),
    { failureKind: 'CAPACITY', failureScope: 'model', failureSaid: 'Selected model is at capacity', admissionFailure: true },
  );
  assert.deepEqual(runFailureColumns({}, true), CLEARED_RUN_FAILURE, 'an older runner sends neither field');
  assert.deepEqual(runFailureColumns({ failure: { kind: 'NEWER' }, admission: false }, true),
    { ...CLEARED_RUN_FAILURE, admissionFailure: false });
  assert.deepEqual(runFailureColumns({ failure: 'USAGE_LIMIT', admission: 'yes' }, true), CLEARED_RUN_FAILURE,
    'a malformed body stores nothing');
  assert.deepEqual(runFailureColumns({ failure: { kind: 'CAPACITY' }, admission: true }, false), CLEARED_RUN_FAILURE,
    'only a failed end keeps a failure');
});

test('movableFailure: the runner\'s kind decides, the words decide only when it sent none', () => {
  // Old runner: today's text classes, unchanged.
  assert.equal(movableFailure(CODEX_LIMIT), 'USAGE_LIMIT');
  assert.equal(movableFailure('Selected model is at capacity. Please try a different model.'), 'AT_CAPACITY');
  assert.equal(movableFailure(SIGNED_OUT), 'AUTH_FAILED');
  assert.equal(movableFailure('Not logged in'), 'AUTH_FAILED');
  assert.equal(movableFailure(EDGE_BLOCK), null, 'a dropped connection is no sign-in');
  assert.equal(movableFailure('the build failed'), null);
  // New runner: the kind wins over the words.
  assert.equal(movableFailure('Kimi Code failed this turn (APIProviderOverloadedError)', { kind: 'CAPACITY' }), 'AT_CAPACITY');
  assert.equal(movableFailure(SIGNED_OUT, { kind: 'TRANSPORT' }), null);
  assert.equal(movableFailure(CODEX_LIMIT, { kind: 'REQUEST_REFUSED' }), null);
  // The account kinds move too (§7.3, phase 2); subagent-move.spec.ts covers every kind.
  assert.equal(movableFailure(CURSOR_PAYMENT, { kind: 'ACCOUNT_ACTION_REQUIRED' }), 'ACCOUNT_ACTION_REQUIRED');
  // A kind this server does not know reads through the words.
  assert.equal(movableFailure(CODEX_LIMIT, { kind: 'A_NEWER_KIND' }), 'USAGE_LIMIT');
});

test('failureKindIs: the stored kind, or no kind and a legacy marker', () => {
  const where = failureKindIs([RunFailureKind.USAGE_LIMIT]);
  assert.deepEqual(where, {
    OR: [
      { failureKind: { in: ['USAGE_LIMIT'] } },
      {
        failureKind: null,
        OR: USAGE_LIMIT_ERROR_MARKERS.map((marker) => ({ error: { contains: marker, mode: Prisma.QueryMode.insensitive } })),
      },
    ],
  });
});

test('failureKindIsNot keeps the runs with no kind and no error, which a negated match would drop', () => {
  const where = failureKindIsNot([RunFailureKind.USAGE_LIMIT]);
  const [classified, legacy] = where.OR as Prisma.SessionWhereInput[];
  assert.deepEqual(classified, { AND: [{ NOT: { failureKind: null } }, { failureKind: { notIn: ['USAGE_LIMIT'] } }] });
  assert.equal(legacy.failureKind, null);
  assert.deepEqual((legacy.OR as Prisma.SessionWhereInput[])[0], { error: null });
});

test('failureKindIsSql reads the column first and the markers only when it is null', () => {
  const sql = failureKindIsSql('s', [RunFailureKind.USAGE_LIMIT, RunFailureKind.CAPACITY]);
  // The kind's half is guarded, so the whole is never NULL for a run with no kind: a NOT of it still counts that run.
  assert.match(sql.sql, /^\(\(s\.failure_kind IS NOT NULL AND s\.failure_kind IN \(\?,\?\)\) OR \(s\.failure_kind IS NULL AND \(/);
  assert.deepEqual(sql.values, [
    'USAGE_LIMIT',
    'CAPACITY',
    ...USAGE_LIMIT_ERROR_MARKERS.map((marker) => `%${marker}%`),
    '%at capacity%',
  ]);
});

/**
 * The route history reads a usage-limit marker anywhere in a failed run's error, as its quotaFailure always did
 * (review of revision 1, point 2): a run whose marker sits past character 40 stays not counted for escalation.
 * Read through runNotCounted, the one definition escalation and the failure budget share (§7.4).
 */
test('route history: a usage-limit marker past character 40 still marks the run as not counted', () => {
  const late = `Nothing answered this message across 3 deliveries of it to the engine. It was left for a retry.\n\n${CODEX_LIMIT}`;
  const run = (failureKind: string | null, error: string | null, accountHealthEffect: string | null = null) =>
    runNotCounted({ failureKind, error, accountHealthEffect });
  assert.ok(late.toLowerCase().indexOf('hit your usage limit') > 40, 'the fixture puts the marker past the opening');
  assert.equal(run(null, late), 'usage-limit');
  assert.equal(run(null, 'Turn failed: Selected model is at capacity.'), 'capacity');
  // Both markers in one text: the usage limit, which this history always checked first.
  assert.equal(run(null, `${CODEX_LIMIT} The model is at capacity too.`), 'usage-limit');
  // The runner's kind decides over the words.
  assert.equal(run('ACCOUNT_ACTION_REQUIRED', late), 'account');
  assert.equal(run('USAGE_LIMIT', 'Kimi Code failed this turn'), 'usage-limit');
  assert.equal(run('REQUEST_REFUSED', CODEX_LIMIT), null);
  // An ordinary failure counts, unless account health acted on it.
  assert.equal(run(null, 'Error: something broke'), null);
  assert.equal(run(null, 'Error: something broke', 'BLOCKED'), 'admission');
});

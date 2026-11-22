import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { buildWorld, connect, FIXTURE_CASES, PAYLOAD_KINDS, readPayloads } from './session-payloads.fixture';

/**
 * Plan step 5.1 of docs/session-three-state-plan.md adds four fields to every session payload and leaves the old ones
 * as they were. This holds it to that, against a real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-payloads-legacy.pg.spec.ts
 *
 * For each case of session-payloads.fixture.ts (the seven statuses, a background job running, a turn waiting on an
 * approval, a watch armed, a paused account) and each payload kind, the legacy fields `status`, `runStatus`,
 * `runState`, `sessionState` and `filingState` — each one the kind carries, and which ones it carries — are compared
 * with session-payloads-legacy.golden.json. That table was written by this same spec and fixture at the commit its
 * `base` names, before step 5.1 changed anything (SESSION_PAYLOADS_LEGACY_WRITE=<path>). Never regenerate it to make
 * this pass: a difference is a changed wire value, which an already-shipped client reads. A case added to the fixture
 * later gets its rows the same way, by running this spec and the new fixture at `base` (plan phase 5's settled
 * landing: that run's other 77 rows were the table's, unchanged, and its 7 new ones were appended).
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const WRITE = process.env.SESSION_PAYLOADS_LEGACY_WRITE;
const REPO = path.resolve(__dirname, '../../../..');
const GOLDEN = path.join(REPO, 'src/apiserver/src/sessions/session-payloads-legacy.golden.json');
const LEGACY = ['status', 'runStatus', 'runState', 'sessionState', 'filingState'] as const;

test('the legacy fields of every payload kind are byte-identical to the base commit', { skip }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const stack = connect(URL!);
  try {
    const world = await buildWorld(stack.db, randomUUID().slice(0, 8));
    const payloads = await readPayloads(stack, world);
    const rows: Array<{ key: string; legacy: string }> = [];
    for (const c of FIXTURE_CASES) {
      for (const kind of PAYLOAD_KINDS) {
        const payload = payloads.get(c.label)![kind];
        const legacy = Object.fromEntries(LEGACY.filter((field) => field in payload).map((field) => [field, payload[field]]));
        rows.push({ key: `${c.label} / ${kind}`, legacy: JSON.stringify(legacy) });
      }
    }
    assert.equal(rows.length, FIXTURE_CASES.length * PAYLOAD_KINDS.length);
    if (WRITE) {
      writeFileSync(WRITE, `${JSON.stringify({ base: process.env.SESSION_PAYLOADS_LEGACY_BASE ?? null, rows }, null, 2)}\n`);
      return;
    }
    assert.ok(existsSync(GOLDEN), 'session-payloads-legacy.golden.json is missing');
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { base: string; rows: typeof rows };
    assert.match(golden.base, /^[0-9a-f]{40}$/u);
    const then = new Map(golden.rows.map((row) => [row.key, row.legacy]));
    assert.deepEqual([...then.keys()], rows.map((row) => row.key));
    const differences = rows
      .filter((row) => then.get(row.key) !== row.legacy)
      .map((row) => `${row.key}: base ${then.get(row.key)}, now ${row.legacy}`);
    assert.deepEqual(differences, [], `\n${differences.join('\n')}\n`);
  } finally {
    await stack.db.$disconnect();
  }
});

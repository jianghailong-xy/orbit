import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_JOB_SESSIONS_MAX } from './runner-background-holders';
import { EXECUTING_IDS_MAX, replaceExecutingSets, sanitizeExecuting } from './runner-executing-sets';

// What a beat states is executing (runners/runner-executing-sets.ts). The write itself runs against PostgreSQL in
// runner-api/link-heartbeat.pg.spec.ts case 15.

const A = '0190a000-0000-7000-8000-00000000000a';
const B = '0190a000-0000-7000-8000-00000000000b';

test('a beat without sets carries none, and writes nothing', async () => {
  assert.equal(sanitizeExecuting(undefined), null);
  assert.equal(sanitizeExecuting(null), null);
  assert.equal(sanitizeExecuting({ sessionId: A }), null, 'not a list');
  let asked = 0;
  const prisma = { $queryRaw: async () => { asked += 1; return []; } } as never;
  assert.deepEqual(await replaceExecutingSets(prisma, { runnerId: A, leaseOwner: B, entries: [] }), []);
  assert.deepEqual(await replaceExecutingSets(prisma, { runnerId: A, leaseOwner: null, entries: [{ sessionId: A, jobs: [] }] }), [],
    'a beat that names no process can write no session');
  assert.equal(asked, 0);
});

test('entries: a session by UUID, each once, in id order; only the sets given, each a whole list of ids', () => {
  assert.deepEqual(
    sanitizeExecuting([
      { sessionId: B.toUpperCase(), engineTurnActive: true, jobs: ['bgj_1', 'bgj_1', 'bgj_2'], shells: ['bgj_1'], subagents: [] },
      { sessionId: A, jobs: ['bgj_3'], shells: 'bgj_3', subagents: [7], engineTurnActive: 'yes' },
      { sessionId: B, jobs: [] },
      { sessionId: 'not-a-session', jobs: [] },
      null,
      'x',
    ]),
    [
      { sessionId: A, jobs: ['bgj_3'] },
      { sessionId: B, engineTurnActive: true, jobs: ['bgj_1', 'bgj_2'], shells: ['bgj_1'], subagents: [] },
    ],
  );
});

test('a set too long to state whole is not stated, and the sessions are bounded', () => {
  const ids = Array.from({ length: EXECUTING_IDS_MAX + 1 }, (_, i) => `bgj_${i}`);
  assert.deepEqual(sanitizeExecuting([{ sessionId: A, jobs: ids, shells: ids.slice(1) }]), [{ sessionId: A, shells: ids.slice(1) }]);
  assert.deepEqual(sanitizeExecuting([{ sessionId: A, jobs: ['x'.repeat(201)] }]), [{ sessionId: A }]);
  const many = Array.from({ length: BACKGROUND_JOB_SESSIONS_MAX + 5 }, (_, i) => ({
    sessionId: `0190a000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`, jobs: [],
  }));
  assert.equal(sanitizeExecuting(many)?.length, BACKGROUND_JOB_SESSIONS_MAX);
});

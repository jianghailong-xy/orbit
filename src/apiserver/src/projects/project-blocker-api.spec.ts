import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastValueFrom, of } from 'rxjs';
import { uuidToBase62 } from '@orbit/shared';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { ProjectsService } from './projects.service';

// The blocker audit face (contract §11 + §10's Base62 rule).
//
// Two things have to be true of it and neither is checked by the pg spec, which reads the columns
// directly: the row's columns map onto the five questions §11.1 freezes, and every id a caller
// could hand back reaches them in Base62. The second is the one that is easy to get half right —
// `PublicIdInterceptor` twins fields it recognises, but `dedupeKey` is a STRING with a subject
// buried in the middle of it, which the interceptor cannot see into. That one is publicized by the
// service, and this is what says so.

const OWNER = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const PROJECT = '019fcbf3-0fa8-7f83-9302-46b25389cb16';
const TASK = '019fcda0-d021-72a2-a914-2f4de38f469c';
const BLOCKER = '019fcdad-acd0-73f1-b83e-34c901525105';
const ACTION = '019fcdae-c039-76c2-bb7b-1a7c550f8e26';

const ROW = {
  id: BLOCKER,
  kind: 'MERGE_CONFLICT',
  owner: 'COORDINATOR',
  recovery: 'EVENT',
  severity: 'CRITICAL',
  requiredAction: 'Resolve the merge conflict on this branch and merge again.',
  nextCheckAt: new Date('2026-08-20T00:10:00.000Z'),
  subjectType: 'TASK',
  subjectId: TASK,
  detail: { paths: ['a.ts'] },
  dedupeKey: `MERGE_CONFLICT:TASK:${TASK}`,
  lifecycleGeneration: 3n,
  conditionVersion: 'a'.repeat(64),
  firstSeenAt: new Date('2026-08-20T00:00:00.000Z'),
  lastSeenAt: new Date('2026-08-20T00:05:00.000Z'),
  occurrences: 47,
  escalatedAt: null,
  resolvedAt: null,
  resolvedBy: null,
  raisedByActionId: ACTION,
  raisedByActionStatus: 'APPLIED',
};

function service(rows: unknown[] = [ROW], history: boolean[] = []): ProjectsService {
  const prisma = {
    project: { findFirst: async () => ({ id: PROJECT }) },
    $queryRaw: async (query: { values: unknown[] }) => {
      history.push(query.values.includes(true));
      return rows;
    },
  };
  return new ProjectsService(prisma as never, {} as never);
}

function through<T>(body: T): Promise<T> {
  class Controller {}
  return lastValueFrom(
    new PublicIdInterceptor().intercept(
      { getClass: () => Controller } as never,
      { handle: () => of(body) } as never,
    ),
  ) as Promise<T>;
}

test('a blocker is served with all five answers §11.1 freezes', async () => {
  const { blockers } = await service().blockers(OWNER, PROJECT);
  assert.equal(blockers.length, 1);
  const [row] = blockers;
  assert.equal(row.kind, 'MERGE_CONFLICT');
  assert.equal(row.owner, 'COORDINATOR');
  assert.equal(row.recovery, 'EVENT');
  assert.equal(row.requiredAction, ROW.requiredAction);
  assert.equal(row.nextCheckAt, ROW.nextCheckAt);
  // BL7's two display columns, which are what this endpoint exists to show and the only place in
  // the system they are allowed to appear.
  assert.equal(row.occurrences, 47);
  assert.equal(row.lastSeenAt, ROW.lastSeenAt);
  // A BigInt column crosses the wire as a decimal string, as every other one here does.
  assert.equal(row.lifecycleGeneration, '3');
  assert.equal(row.conditionVersion, ROW.conditionVersion);
  // §11.3 BE3: which action opened it, resolved by the key rather than inferred.
  assert.equal(row.raisedByActionId, ACTION);
});

test('every id a caller could hand back is served in Base62', async () => {
  const payload = await through(
    await service().blockers(OWNER, PROJECT),
  ) as unknown as Record<string, unknown>;
  const row = (payload.blockers as Array<Record<string, unknown>>)[0];
  assert.equal(payload.projectPublicId, uuidToBase62(PROJECT));
  assert.equal(row.publicId, uuidToBase62(BLOCKER));
  assert.equal(row.subjectPublicId, uuidToBase62(TASK));
  assert.equal(row.raisedByActionPublicId, uuidToBase62(ACTION));
  // The one the interceptor cannot reach: a subject buried inside a string.
  assert.equal(row.dedupeKey, `MERGE_CONFLICT:TASK:${uuidToBase62(TASK)}`);
  assert.doesNotMatch(
    JSON.stringify(row.dedupeKey),
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
  );
});

test('a key whose subject is a natural name is left alone, not mangled', async () => {
  // A builtin provider has no row of its own, so its subject is its slug. Publicizing is a
  // best-effort translation of ids and must never damage something that was never one.
  const slugKey = 'PROVIDER_UNAVAILABLE:PROVIDER:claude';
  const { blockers } = await service([{ ...ROW, dedupeKey: slugKey, subjectType: 'PROVIDER', subjectId: 'claude' }])
    .blockers(OWNER, PROJECT);
  assert.equal(blockers[0].dedupeKey, slugKey);
});

test('resolved episodes are opt-in, because "what is stopping me" is the default question', async () => {
  const asked: boolean[] = [];
  await service([ROW], asked).blockers(OWNER, PROJECT);
  await service([ROW], asked).blockers(OWNER, PROJECT, true);
  assert.deepEqual(asked, [false, true]);
});

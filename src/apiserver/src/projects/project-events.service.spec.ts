import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import {
  ProjectEventsService,
  projectEventRetryDelayMs,
} from './project-events.service';

const PROJECT = '00000000-0000-7000-8000-000000000501';
const SOURCE = '00000000-0000-7000-8000-000000000502';
const EVENT = '00000000-0000-7000-8000-000000000503';

test('the delivery retry is exponential and capped at five minutes', () => {
  assert.equal(projectEventRetryDelayMs(1), 1_000);
  assert.equal(projectEventRetryDelayMs(2), 2_000);
  assert.equal(projectEventRetryDelayMs(9), 256_000);
  assert.equal(projectEventRetryDelayMs(10), 300_000);
  assert.equal(projectEventRetryDelayMs(100), 300_000);
  assert.throws(() => projectEventRetryDelayMs(0), RangeError);
  assert.throws(() => projectEventRetryDelayMs(1.5), RangeError);
});

test('enqueue writes the frozen envelope through the pending partial conflict target', async () => {
  let statement: Prisma.Sql | undefined;
  const occurredAt = new Date('2026-08-20T05:00:00.000Z');
  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
      statement = query;
      return [{
        id: EVENT,
        projectId: PROJECT,
        v: 77,
        kind: 'future.kind',
        occurredAt,
        sourceType: 'USER',
        sourceId: SOURCE,
        dedupeKey: `future.kind:${SOURCE}`,
        payload: { display: 'audit only' },
        occurrences: 2,
        lastAt: occurredAt,
        attempts: 0,
        nextAttemptAt: null,
      }];
    },
  } as unknown as Prisma.TransactionClient;
  const service = new ProjectEventsService({} as never);

  const event = await service.enqueue(tx, {
    projectId: PROJECT,
    v: 77,
    kind: 'future.kind',
    source: { type: 'USER', id: SOURCE },
    dedupeKey: `future.kind:${SOURCE}`,
    payload: { display: 'audit only' },
    occurredAt,
  });

  assert.ok(statement);
  assert.match(statement!.sql, /ON CONFLICT \("project_id", "dedupe_key"\) WHERE "consumed_at" IS NULL/);
  assert.match(statement!.sql, /"occurrences" = "project_event"\."occurrences" \+ 1/);
  assert.match(statement!.sql, /GREATEST\("project_event"\."last_at", EXCLUDED\."occurred_at"\)/);
  assert.equal(event.v, 77, 'unknown versions remain valid dirty signals');
  assert.equal(event.kind, 'future.kind', 'unknown kinds remain valid dirty signals');
  assert.deepEqual(event.source, { type: 'USER', id: SOURCE });
  assert.deepEqual(event.payload, { display: 'audit only' });
  assert.equal(event.occurrences, 2);
});

test('enqueue rejects malformed producer input before touching the transaction', async () => {
  let queries = 0;
  const tx = {
    $queryRaw: async () => {
      queries += 1;
      return [];
    },
  } as unknown as Prisma.TransactionClient;
  const service = new ProjectEventsService({} as never);
  const base = {
    projectId: PROJECT,
    kind: 'task.updated',
    source: { type: 'TASK' as const, id: SOURCE },
    dedupeKey: `task.updated:${SOURCE}`,
  };

  await assert.rejects(service.enqueue(tx, { ...base, v: 0 }), RangeError);
  await assert.rejects(service.enqueue(tx, { ...base, kind: ' ' }), RangeError);
  await assert.rejects(service.enqueue(tx, { ...base, dedupeKey: '' }), RangeError);
  assert.equal(queries, 0);
});

test('only one semantic handler can be registered at a time', () => {
  const service = new ProjectEventsService({} as never);
  const first = { handle: async () => {}, deadLetter: async () => {} };
  const second = { handle: async () => {}, deadLetter: async () => {} };

  const unregister = service.registerHandler(first);
  assert.throws(() => service.registerHandler(second), /already registered/);
  unregister();
  assert.doesNotThrow(() => service.registerHandler(second));
});

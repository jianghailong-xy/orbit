import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY, firstValueFrom, take, toArray } from 'rxjs';
import { RunEventType } from '@orbit/shared';
import {
  NON_REPLAYABLE_EVENT_TYPES,
  replayableEventSql,
} from '../common/system-noise';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

const SESSION = '00000000-0000-4000-8000-000000000001';

type TaggedQuery = {
  strings: readonly string[];
  values: readonly unknown[];
};

function renderedQuery(query: TaggedQuery): string {
  return query.strings.reduce((text, fragment, index) => {
    const value = query.values[index];
    const nested =
      typeof value === 'object' && value !== null && 'sql' in value
        ? String((value as { sql: unknown }).sql)
        : '?';
    return `${text}${fragment}${nested}`;
  }, '');
}

function assertReplayFence(query: TaggedQuery | undefined, order: 'ASC' | 'DESC'): void {
  assert.ok(query);
  assert.match(
    renderedQuery(query),
    new RegExp(`type NOT IN \\([?, ]+\\)[\\s\\S]*ORDER BY seq ${order}[\\s\\S]*LIMIT`),
  );
  assert.ok(query.values.includes(replayableEventSql));
}

test('persisted transcript reads fence every live-only event, including legacy tool_output', () => {
  assert.ok(NON_REPLAYABLE_EVENT_TYPES.includes(RunEventType.TOOL_OUTPUT));
  assert.match(replayableEventSql.sql, /type NOT IN \(/);
  assert.deepEqual(
    replayableEventSql.values.filter((value): value is string => typeof value === 'string'),
    [...NON_REPLAYABLE_EVENT_TYPES],
  );
});

test('the client tail page applies the replay fence before its LIMIT', async () => {
  let captured: TaggedQuery | undefined;
  const prisma = {
    session: { findFirst: async () => ({ id: SESSION }) },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured = { strings, values };
      return [];
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);

  const page = await service.getEventPage('owner', SESSION, { tail: 200, maxPayload: 2048 });

  assert.deepEqual(page, { events: [], hasMore: false });
  assertReplayFence(captured, 'DESC');
});

test('the public shared transcript applies the same historical replay fence', async () => {
  let captured: TaggedQuery | undefined;
  const prisma = {
    session: {
      findFirst: async () => ({
        id: SESSION,
        title: 'shared',
        status: 'FAILED',
        endReason: null,
        completedAt: null,
        archivedAt: null,
        deletedAt: null,
        createdAt: new Date('2026-08-31T02:00:00Z'),
        workspace: null,
      }),
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured = { strings, values };
      return [];
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);

  const shared = await service.getShared('share-token');

  assert.deepEqual(shared.events, []);
  assert.ok(captured);
  assert.match(renderedQuery(captured), /type NOT IN \([?, ]+\)[\s\S]*ORDER BY seq ASC/);
  assert.ok(captured.values.includes(replayableEventSql));
});

test('the SSE history replay applies the same fence while leaving its live half alone', async () => {
  let captured: TaggedQuery | undefined;
  const prisma = {
    session: { findFirst: async () => ({ id: SESSION }) },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured = { strings, values };
      return [
        {
          seq: 782,
          type: RunEventType.TURN_END,
          payload: {},
          turnId: null,
          createdAt: new Date('2026-08-31T02:00:00Z'),
        },
      ];
    },
  };
  const controller = new SessionsController(
    {} as never,
    prisma as never,
    { streamForRun: () => EMPTY, turnPrefix: () => ({ text: '', thinking: '' }) } as never,
    {} as never,
    {} as never,
  );

  const replay: any[] = await firstValueFrom(
    (controller.events({ userId: 'owner' } as never, SESSION, '0', '2048') as any).pipe(
      take(1),
      toArray(),
    ),
  );

  assert.equal(replay[0].data.seq, 782);
  assertReplayFence(captured, 'DESC');
});

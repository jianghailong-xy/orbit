import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY, firstValueFrom, take, toArray } from 'rxjs';
import { RunEventType } from '@orbit/shared';
import {
  NON_REPLAYABLE_EVENT_TYPES,
  replayableEventSql,
} from '../common/system-noise';
import { SessionGuestsService } from '../session-guests/session-guests.service';
import { SharedController } from '../shared/shared.controller';
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

  const shared = await service.getSharedTranscript(SESSION);

  assert.deepEqual(shared.events, []);
  assert.equal(shared.hasMore, false);
  // A tail page since the share stopped returning the whole history: the owner's page query,
  // fenced before its LIMIT, read newest-first and handed back in seq order.
  assertReplayFence(captured, 'DESC');
});

test('a shared transcript event fetched by seq sits behind the same fence', async () => {
  let captured: TaggedQuery | undefined;
  const prisma = {
    session: { findFirst: async () => ({ id: SESSION }) },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured = { strings, values };
      return [];
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);

  await assert.rejects(service.getSharedEventFull(SESSION, 7), /event not found/);

  assert.ok(captured);
  assert.match(renderedQuery(captured), /seq = \?[\s\S]*type NOT IN \([?, ]+\)/);
  assert.ok(captured.values.includes(replayableEventSql));
});

// What a raw read reads, by its SQL: the transcript (`run_event`) or the header's `activity`
// (readSessionActivities, a `Prisma.sql` object over `session` rather than a tagged template).
// Counting every `$queryRaw` as "events" is what once made the header's activity read look like a
// second page of events.
function rawRead(strings: TemplateStringsArray | { sql: string }): 'events' | 'activity' {
  const sql = Array.isArray(strings) ? strings.join('?') : (strings as { sql: string }).sql;
  if (/\bFROM\s+run_event\b/i.test(sql)) return 'events';
  assert.match(sql, /FROM\s+"session"\s+s\b/, `an unexpected raw read: ${sql}`);
  return 'activity';
}

test('what a shared session added after a seq sits behind the same fence, read after its header', async () => {
  const reads: string[] = [];
  let captured: TaggedQuery | undefined;
  const prisma = {
    session: {
      findFirst: async () => {
        reads.push('header');
        return {
          id: SESSION,
          title: 'shared',
          status: 'RUNNING',
          endReason: null,
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
          createdAt: new Date('2026-08-31T02:00:00Z'),
          workspace: null,
        };
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const read = rawRead(strings);
      reads.push(read);
      if (read === 'activity') return [];
      captured = { strings, values };
      return [];
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);

  const now = await service.getSharedEventsAfter(SESSION, { after: 7, maxPayload: 2048 });

  assert.deepEqual(now.events, []);
  assert.equal(now.after, null);
  assert.equal(now.runState, 'RUNNING');
  // The header first — its row, then what the parked session is still doing — and the events after
  // it, once: an answer that says the run is over holds every event written before it.
  assert.deepEqual(reads, ['header', 'activity', 'events']);
  assert.ok(captured);
  assert.match(renderedQuery(captured), /seq > \?/);
  assert.ok(captured.values.includes(7));
  assertReplayFence(captured, 'ASC');
});

/** A live shared session with two events after seq 7, answering its header, activity and run_event
 *  reads by their SQL; `eventReads` counts the run_event reads. */
function afterSeqFixture(extra: Record<string, unknown> = {}) {
  const counts = { eventReads: 0 };
  const row = (seq: number) => ({
    seq,
    type: RunEventType.TURN_END,
    payload: {},
    turnId: null,
    createdAt: new Date('2026-08-31T02:00:00Z'),
  });
  const prisma = {
    ...extra,
    session: {
      findFirst: async () => ({
        id: SESSION,
        title: 'shared',
        status: 'RUNNING',
        endReason: null,
        completedAt: null,
        archivedAt: null,
        deletedAt: null,
        createdAt: new Date('2026-08-31T02:00:00Z'),
        workspace: null,
      }),
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      if (rawRead(strings) === 'activity') return [{ id: SESSION, activity: null }];
      counts.eventReads += 1;
      return [row(8), row(9)];
    },
  };
  const sessions = new SessionsService(prisma as never, {} as never, {} as never);
  return { prisma, sessions, counts };
}

/** Exactly one page of events in an answer: one `events` array, seqs 8 and 9 once each, and no
 *  other field carrying a second group of them. */
function assertOneEventGroup(answer: Record<string, unknown>): void {
  const groups = Object.entries(answer).filter(([, value]) =>
    Array.isArray(value) && value.some((item) => item && typeof item === 'object' && 'seq' in item));
  assert.deepEqual(groups.map(([key]) => key), ['events']);
  assert.deepEqual((answer.events as { seq: number }[]).map((event) => event.seq), [8, 9]);
}

test('a shared session read after a seq answers one page of events, each event once', async () => {
  const { sessions, counts } = afterSeqFixture();

  const now = await sessions.getSharedEventsAfter(SESSION, { after: 7, maxPayload: 2048 });

  assert.equal(counts.eventReads, 1);
  assert.deepEqual(now.events.map((event) => event.seq), [8, 9]);
  assert.equal(now.after, null);
  assert.equal(now.activity, null);
});

test('the public share door answers after a seq with one group of events, read once', async () => {
  const { sessions, counts } = afterSeqFixture();
  const links = {
    resolve: async () => ({ sessionId: SESSION, include: { toolOutput: true } }),
  };
  const controller = new SharedController(links as never, sessions, {} as never);

  const answer = await controller.events('token', undefined, '7', undefined, '2048');

  assert.equal(counts.eventReads, 1);
  assertOneEventGroup(answer as unknown as Record<string, unknown>);
  assert.ok('runState' in answer, 'an after-seq answer carries the header');
  assert.equal(answer.runState, 'RUNNING');
});

test('a guest following a session after a seq gets one group of events, read once', async () => {
  const { prisma, sessions, counts } = afterSeqFixture({
    sessionGuest: {
      findFirst: async () => ({
        id: 'guest-row',
        openedAt: null,
        session: { ownerId: 'owner' },
        user: { name: 'Guest' },
      }),
    },
    approval: { findMany: async () => [] },
  });
  const guests = new SessionGuestsService(prisma as never, sessions);

  const answer = await guests.events('guest', SESSION, { after: '7', maxPayload: '2048' });

  assert.equal(counts.eventReads, 1);
  assertOneEventGroup(answer as unknown as Record<string, unknown>);
  assert.ok('waitingOnOwner' in answer, 'an after-seq answer carries the header');
  assert.equal(answer.waitingOnOwner, false);
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';
import { reloadCarriesEnv, RESTART_RELOAD_CONTENT } from './session-settings';

// POST /sessions/:id/restart (the Settings panel's Restart). The service runs against an in-memory
// session and conversation_turn table: what is asserted is what it queues and answers. The inbox side
// — the reload handed out with the env, only after the turn in flight — is in
// runner-api/reload-provider-env.spec.ts and, on real PostgreSQL, session-restart.pg.spec.ts.

const OWNER = '00000000-0000-4000-8000-000000000001';
const STRANGER = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-0000000000aa';

type Row = Record<string, unknown> & { id: string; ownerId: string };
type Turn = { id: string; sessionId: string; seq: number; kind: string; status: string; content?: string | null; clientTurnId: string };

function sessionRow(over: Partial<Row> = {}): Row {
  return {
    id: SESSION,
    ownerId: OWNER,
    status: RunStatus.AWAITING_INPUT,
    cancelRequestedAt: null,
    deletedAt: null,
    sessionKind: 'CONVERSATION',
    env: { FOO: 'bar' },
    ...over,
  };
}

function matches(turn: Turn, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = (turn as Record<string, unknown>)[key];
    if (want && typeof want === 'object' && 'in' in want) return (want.in as unknown[]).includes(have);
    return have === want;
  });
}

function harness(row: Row, turns: Turn[] = []) {
  const state = { row: { ...row }, turns: [...turns], inboxNotified: [] as string[] };
  const conversationTurn = {
    findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
      const hits = state.turns.filter((t) => matches(t, where));
      if (orderBy) hits.sort((a, b) => b.seq - a.seq);
      return hits[0] ?? null;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) => state.turns.filter((t) => matches(t, where)),
    findUnique: async ({ where }: { where: { sessionId_clientTurnId: { sessionId: string; clientTurnId: string } } }) =>
      state.turns.find((t) => t.sessionId === where.sessionId_clientTurnId.sessionId
        && t.clientTurnId === where.sessionId_clientTurnId.clientTurnId) ?? null,
    create: async ({ data }: { data: Omit<Turn, 'id'> }) => {
      const turn = { id: `turn-${state.turns.length + 1}`, ...data };
      state.turns.push(turn);
      return turn;
    },
  };
  const session = {
    findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
      where.id === state.row.id && where.ownerId === state.row.ownerId ? { ...state.row } : null,
  };
  const tx = {
    session,
    conversationTurn,
    // The FOR UPDATE lock: answers a row only for the owner, as the WHERE does.
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) =>
      values[0] === state.row.id && values[1] === state.row.ownerId ? [{ id: state.row.id }] : [],
  };
  const prisma = { session, conversationTurn, $transaction: async (work: (t: typeof tx) => unknown) => work(tx) };
  const realtime = { notifyInbox: (id: string) => state.inboxNotified.push(id), publishSessionUpdated: () => undefined };
  const service = new SessionsService(prisma as never, {} as never, realtime as never);
  const reloads = () => state.turns.filter((t) => t.kind === 'reload');
  return { service, state, reloads };
}

const answeredOpening: Turn = {
  id: 'opening', sessionId: SESSION, seq: 1, kind: 'message', status: 'ANSWERED', content: 'hello', clientTurnId: `initial-${SESSION}`,
};

test('a live idle session queues one reload that carries the env, and wakes the inbox', async () => {
  const { service, state, reloads } = harness(sessionRow(), [answeredOpening]);

  assert.deepEqual(await service.restart(OWNER, SESSION), { queued: true, afterTurn: false });

  assert.equal(reloads().length, 1);
  const [reload] = reloads();
  assert.equal(reload.status, 'PENDING');
  assert.equal(reload.seq, 2);
  assert.equal(reload.content, RESTART_RELOAD_CONTENT);
  // The inbox hands it out with the session's env resolved at that moment (reloadProviderEnv).
  assert.equal(reloadCarriesEnv(reload.content), true);
  assert.deepEqual(state.inboxNotified, [SESSION]);
});

test('during a turn in flight it is queued behind that turn: afterTurn is true', async () => {
  for (const kind of ['message', 'shell']) {
    const { service, reloads } = harness(sessionRow({ status: RunStatus.RUNNING }), [
      answeredOpening,
      { id: 'running', sessionId: SESSION, seq: 2, kind, status: 'IN_FLIGHT', content: 'work', clientTurnId: 'c-2' },
    ]);

    assert.deepEqual(await service.restart(OWNER, SESSION), { queued: true, afterTurn: true }, kind);
    // Still a PENDING reload: the inbox gates `reload` on no message/shell turn being in flight, so
    // it is handed out when this one ends (dequeueTurn; on PostgreSQL in session-restart.pg.spec.ts).
    assert.deepEqual(reloads().map((t) => t.status), ['PENDING'], kind);
  }
});

test('an ended engine is refused 409 ENGINE_NOT_RUNNING and nothing is queued', async () => {
  for (const over of [
    { status: RunStatus.SUCCEEDED },
    { status: RunStatus.CANCELLED },
    { status: RunStatus.FAILED },
    { status: RunStatus.PENDING },
    { status: RunStatus.AWAITING_INPUT, cancelRequestedAt: new Date() },
  ]) {
    const { service, state, reloads } = harness(sessionRow(over), [answeredOpening]);
    await assert.rejects(service.restart(OWNER, SESSION), (error: unknown) => {
      assert.ok(error instanceof ConflictException, String(error));
      assert.equal((error.getResponse() as { code?: string }).code, 'ENGINE_NOT_RUNNING');
      return true;
    }, JSON.stringify(over));
    assert.equal(reloads().length, 0);
    assert.deepEqual(state.inboxNotified, []);
  }
});

test('a second restart while one is queued returns the queued one', async () => {
  const { service, state, reloads } = harness(sessionRow(), [answeredOpening]);

  await service.restart(OWNER, SESSION);
  assert.deepEqual(await service.restart(OWNER, SESSION), { queued: true, afterTurn: false });

  assert.equal(reloads().length, 1);
  assert.deepEqual(state.inboxNotified, [SESSION]);
});

test('a queued provider switch already carries the env, so it is the restart', async () => {
  const { service, reloads } = harness(sessionRow(), [
    answeredOpening,
    { id: 'switch', sessionId: SESSION, seq: 2, kind: 'reload', status: 'PENDING', content: JSON.stringify({ provider: 'claude' }), clientTurnId: 'c-2' },
  ]);

  assert.deepEqual(await service.restart(OWNER, SESSION), { queued: true, afterTurn: false });
  assert.equal(reloads().length, 1);
});

test('a queued model-only reload does not carry the env, so a restart is still queued behind it', async () => {
  const { service, reloads } = harness(sessionRow(), [
    answeredOpening,
    { id: 'model', sessionId: SESSION, seq: 2, kind: 'reload', status: 'PENDING', content: JSON.stringify({ model: 'claude-haiku-4-5' }), clientTurnId: 'c-2' },
  ]);

  await service.restart(OWNER, SESSION);
  assert.deepEqual(reloads().map((t) => t.content), [JSON.stringify({ model: 'claude-haiku-4-5' }), RESTART_RELOAD_CONTENT]);
});

test('once the queued restart was handed out, a new restart queues another', async () => {
  const { service, state, reloads } = harness(sessionRow(), [answeredOpening]);

  await service.restart(OWNER, SESSION);
  reloads()[0].status = 'ANSWERED';
  await service.restart(OWNER, SESSION);

  assert.deepEqual(reloads().map((t) => t.status), ['ANSWERED', 'PENDING']);
  assert.deepEqual(state.inboxNotified, [SESSION, SESSION]);
});

test('a non-owner is refused 404; a trashed session 409; nothing is queued', async () => {
  const stranger = harness(sessionRow(), [answeredOpening]);
  await assert.rejects(stranger.service.restart(STRANGER, SESSION), NotFoundException);
  assert.equal(stranger.reloads().length, 0);

  const trashed = harness(sessionRow({ deletedAt: new Date() }), [answeredOpening]);
  await assert.rejects(trashed.service.restart(OWNER, SESSION), ConflictException);
  assert.equal(trashed.reloads().length, 0);
});

test('reloadCarriesEnv: a provider switch and a restart do; every other reload does not', () => {
  assert.equal(reloadCarriesEnv(RESTART_RELOAD_CONTENT), true);
  assert.equal(reloadCarriesEnv(JSON.stringify({ model: 'm', provider: 'claude' })), true);
  assert.equal(reloadCarriesEnv(JSON.stringify({ model: 'm', provider: '' })), false);
  assert.equal(reloadCarriesEnv(JSON.stringify({ model: 'm', effort: 'high' })), false);
  assert.equal(reloadCarriesEnv(JSON.stringify({ env: 'yes' })), false);
  assert.equal(reloadCarriesEnv('not json'), false);
  assert.equal(reloadCarriesEnv('null'), false);
  assert.equal(reloadCarriesEnv(null), false);
});

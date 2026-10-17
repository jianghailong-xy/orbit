import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import type { ArtifactResultRequest } from '@orbit/shared';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from './sessions.service';
import { isWorktreeArtifactPath } from './worktree-artifact';

const SESSION = randomUUID();
const OWNER = randomUUID();
const RUNNER = randomUUID();

type Row = Record<string, any>;
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'session') return value.assignedRunnerId === RUNNER;
    if (value && typeof value === 'object' && 'gte' in value) return row[key] >= value.gte;
    return row[key] === value;
  });
}

function fixture() {
  let turns: Row[] = [];
  let attachments: Row[] = [];
  let onRead: (turn: Row) => Promise<void> = async () => {};
  const session = {
    id: SESSION, ownerId: OWNER, assignedRunnerId: RUNNER,
    assignedRunner: { status: 'ONLINE', lastHeartbeatAt: new Date() },
    changedFiles: [
      { path: 'one/card.png', status: 'A' }, { path: 'two/card.png', status: 'M' },
      { path: 'gone.png', status: 'D' },
    ],
  };
  const db: Row = {
    $queryRaw: async () => [{ id: SESSION }],
    session: {
      findFirst: async ({ where }: Row) => matches(session, where) ? session : null,
      findUnique: async ({ where }: Row) => where.id === SESSION ? session : null,
    },
    conversationTurn: {
      findUnique: async ({ where }: Row) => turns.find((row) =>
        row.sessionId === where.sessionId_clientTurnId.sessionId
        && row.clientTurnId === where.sessionId_clientTurnId.clientTurnId) ?? null,
      findFirst: async ({ where, select }: Row) => {
        const row = turns.find((turn) => matches(turn, where));
        if (row && select?.attachments) {
          await onRead(row);
          return { ...row, attachments: attachments.filter((att) => att.turnId === row.id
            && matches(att, select.attachments.where)) };
        }
        return row ?? null;
      },
      findMany: async ({ where }: Row) => turns.filter((turn) => matches(turn, where)),
      create: async ({ data }: Row) => {
        const row = { id: randomUUID(), createdAt: new Date(), ...data };
        turns.push(row);
        return row;
      },
      updateMany: async ({ where, data }: Row) => {
        const selected = turns.filter((row) => matches(row, where));
        for (const row of selected) Object.assign(row, data);
        return { count: selected.length };
      },
    },
    attachment: {
      updateMany: async ({ where, data }: Row) => {
        const selected = attachments.filter((row) => matches(row, where));
        for (const row of selected) Object.assign(row, data);
        return { count: selected.length };
      },
      deleteMany: async ({ where }: Row) => {
        const selected = attachments.filter((row) => matches(row, where));
        attachments = attachments.filter((row) => !selected.includes(row));
        return { count: selected.length };
      },
    },
  };
  db.$transaction = async (work: (tx: Row) => Promise<unknown>) => {
    const beforeTurns = turns.map((row) => ({ ...row }));
    const beforeAttachments = attachments.map((row) => ({ ...row }));
    try { return await work(db); } catch (error) {
      turns = beforeTurns;
      attachments = beforeAttachments;
      throw error;
    }
  };
  const api = new RunnerApiController(db as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  const service = new SessionsService(db as never, {} as never, {} as never);
  const realtime = new RealtimeService(db as never, {} as never);
  return {
    service, realtime, session,
    turns: () => turns, attachments: () => attachments,
    onRead: (callback: typeof onRead) => { onRead = callback; },
    addTurn: (content: string, overrides: Row = {}) => {
      const turn = { id: randomUUID(), sessionId: SESSION, kind: 'artifact', status: 'PENDING', content, createdAt: new Date(), ...overrides };
      turns.push(turn);
      return turn;
    },
    addAttachment: (overrides: Row = {}) => {
      const row = { id: randomUUID(), ownerId: OWNER, sessionId: SESSION, turnId: null, createdAt: new Date(),
        fileName: 'card.png', data: Buffer.from('fresh'), mimeType: 'image/png', ...overrides };
      attachments.push(row);
      return row;
    },
    result: (requestId: string, result: Omit<ArtifactResultRequest, 'requestId'>, runnerId = RUNNER) =>
      api.artifactResult({ id: runnerId }, SESSION, { requestId, ...result }),
  };
}

const expectStatus = (status: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === status;

test('worktree file paths reject traversal, absolute paths, git internals and malformed separators', () => {
  for (const invalid of [undefined, '', '/etc/passwd', '../card.png', 'one/../card.png', './one/card.png',
    'one//card.png', 'one/', 'C:/private.png', 'one\\card.png', '.git/config', 'one/.GIT/config', 'one/\0.png']) {
    assert.equal(isWorktreeArtifactPath(invalid), false, String(invalid));
  }
  for (const valid of ['one/card.png', '图/方案 1.png', 'one/100%25.png']) assert.equal(isWorktreeArtifactPath(valid), true);
});

test('only the owner can fetch an existing changed file and an offline runner queues nothing', async () => {
  const f = fixture();
  await assert.rejects(f.service.getWorktreeFileForOwner(randomUUID(), SESSION, 'one/card.png'), expectStatus(404));
  for (const name of ['gone.png', 'other/card.png', '/etc/passwd', '../one/card.png']) {
    await assert.rejects(f.service.getWorktreeFileForOwner(OWNER, SESSION, name), expectStatus(404));
  }
  f.session.assignedRunner.status = 'OFFLINE';
  await assert.rejects(f.service.getWorktreeFileForOwner(OWNER, SESSION, 'one/card.png'), expectStatus(503));
  assert.equal(f.turns().length, 0);
});

test('same-basename files and repeated previews fetch fresh request-scoped bytes, then remove only their temporary upload', async () => {
  const f = fixture();
  const transcriptImage = f.addAttachment({ data: Buffer.from('old transcript image'), createdAt: new Date(0) });
  let read = 0;
  f.onRead(async (turn) => {
    const path = JSON.parse(turn.content).path;
    const upload = f.addAttachment({ data: Buffer.from(`${path}:${++read}`) });
    await f.result(turn.id, { status: 'uploaded', attachmentId: upload.id });
  });
  for (const [index, path] of ['one/card.png', 'two/card.png', 'one/card.png'].entries()) {
    const result = await f.service.getWorktreeFileForOwner(OWNER, SESSION, path);
    assert.equal(result.data.toString(), `${path}:${index + 1}`);
    assert.equal(result.mimeType, 'image/png');
    assert.match(result.disposition, /filename="card.png"/);
  }
  assert.equal(new Set(f.turns().map((turn) => turn.clientTurnId)).size, 3);
  assert.equal(f.turns().every((turn) => turn.status === 'ANSWERED'), true);
  assert.deepEqual(f.attachments().map((row) => row.id), [transcriptImage.id]);
});

test('runner callbacks refuse cross-owner, cross-session, already-linked and older uploads atomically', async () => {
  for (const overrides of [
    { ownerId: randomUUID() }, { sessionId: randomUUID() }, { turnId: randomUUID() }, { createdAt: new Date(0) },
  ]) {
    const f = fixture();
    const content = JSON.stringify({ source: 'worktree', path: 'one/card.png' });
    const turn = f.addTurn(content);
    const upload = f.addAttachment(overrides);
    await assert.rejects(f.result(turn.id, { status: 'uploaded', attachmentId: upload.id }), expectStatus(400));
    assert.equal(f.turns()[0].status, 'PENDING');
    assert.equal(f.turns()[0].content, content);
    assert.equal(f.attachments()[0].turnId, overrides.turnId ?? null);
  }
});

test('only the assigned runner can answer, and duplicate or late callbacks cannot replace bytes', async () => {
  const f = fixture();
  const turn = f.addTurn(JSON.stringify({ source: 'worktree', path: 'one/card.png' }));
  const first = f.addAttachment();
  const later = f.addAttachment();
  await assert.rejects(f.result(turn.id, { status: 'uploaded', attachmentId: first.id }, randomUUID()), expectStatus(403));
  await f.result(turn.id, { status: 'uploaded', attachmentId: first.id });
  await f.result(turn.id, { status: 'uploaded', attachmentId: later.id });
  assert.equal(first.turnId, turn.id);
  assert.equal(later.turnId, null);
  await f.result(randomUUID(), { status: 'uploaded', attachmentId: later.id });
  assert.equal(later.turnId, null);
});

test('runner errors finish immediately with accurate status and never expose runner paths', async () => {
  for (const [result, status] of [
    [{ status: 'missing' }, 404], [{ status: 'error', errorCode: 'too_large' }, 413], [{ status: 'error' }, 502],
  ] as const) {
    const f = fixture();
    f.onRead(async (turn) => { await f.result(turn.id, { ...result, message: '/private/runner/path' }); });
    await assert.rejects(f.service.getWorktreeFileForOwner(OWNER, SESSION, 'one/card.png'), (error: unknown) => {
      assert.ok(expectStatus(status)(error));
      assert.doesNotMatch(String(error), /private/);
      return true;
    });
    assert.equal(f.turns()[0].status, 'ANSWERED');
    assert.doesNotMatch(f.turns()[0].content, /private/);
  }
});

test('timeout closes its pending request and a late result cannot resurrect it', async (t) => {
  const f = fixture();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  f.onRead(async () => { now += 41_000; });
  await assert.rejects(f.service.getWorktreeFileForOwner(OWNER, SESSION, 'one/card.png'), expectStatus(504));
  const turn = f.turns()[0];
  assert.equal(turn.status, 'ANSWERED');
  assert.equal(JSON.parse(turn.content).result.status, 'timeout');
  const upload = f.addAttachment();
  await f.result(turn.id, { status: 'uploaded', attachmentId: upload.id });
  assert.equal(upload.turnId, null);
});

test('heartbeat forwards relative worktree requests while preserving legacy absolute paths and callback behavior', async () => {
  const f = fixture();
  const legacy = f.addTurn('/root/.orbit/uploads/session/card.png');
  const worktree = f.addTurn(JSON.stringify({ source: 'worktree', path: 'one/card.png' }));
  assert.deepEqual(await f.realtime.drainArtifactRequests(RUNNER), [
    { requestId: legacy.id, sessionId: SESSION, path: legacy.content },
    { requestId: worktree.id, sessionId: SESSION, path: 'one/card.png', source: 'worktree' },
  ]);
  const image = f.addAttachment();
  await f.result(legacy.id, { status: 'uploaded', attachmentId: image.id });
  assert.equal(legacy.status, 'ANSWERED');
  assert.equal(legacy.content, '/root/.orbit/uploads/session/card.png');
  assert.equal(image.turnId, null);
  assert.equal((await f.realtime.drainArtifactRequests(RUNNER)).length, 1);
});

/**
 * Coordinator handoff (board 02, docs/coordinator-handoff.md), over a real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/coordinator-handoff.pg.spec.ts
 *
 * `CoordinatorHandoffService` and `ProjectsService` are the real ones over the real database. The
 * session service is the only stand-in, and it writes real rows: `resume` inserts the note turn
 * (`conversation_turn`), `create` a session row, `complete` its `completed_at`, `cancelQueuedTurn`
 * deletes a PENDING turn. A turn's end is what runnerApi.turnComplete hands the service
 * (`afterTurn`), with the turn's reply written as the `run_event` rows the runner flushes before it.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { COORDINATOR_HANDOFF_SECTIONS, COORDINATOR_HANDOFF_TURN_PREFIX } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { isOrbitAuthoredTurn } from '../sessions/orbit-authored-turn';
import type { SessionsService } from '../sessions/sessions.service';
import { readSessionCoordinatorHandoffs } from './coordinator-handoff';
import { CoordinatorHandoffService } from './coordinator-handoff.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { ProjectsService } from './projects.service';
import { turnStateOfWord } from '../sessions/session-turn-state';
import { wordOf } from '../test-support/session-word';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let harness: Promise<{ db: PrismaClient; sql: Client }> | undefined;
function boot() {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    return { db: prismaClientFor(URL!), sql };
  })();
  return harness;
}

after(async () => {
  const h = await harness?.catch(() => undefined);
  if (!h) return;
  await h.db.$disconnect();
  await h.sql.end();
});

const NOTE = [
  'Where things stand',
  '4 of 6 tasks done; Fix login redirect in review.',
  'Rulings not yet recorded',
  "Don't merge Payment retries before Friday's release.",
  'Waiting on',
  'Evidence for Fix login redirect.',
  'Next',
  'Ask for the merge once that evidence is in.',
].join('\n');

interface Fixture {
  db: PrismaClient;
  ownerId: string;
  projectId: string;
  workspaceId: string;
  outgoing: string;
  bystander: string;
  taskId: string;
}

async function fixture(): Promise<Fixture> {
  const { db } = await boot();
  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `${ownerId}@handoff.invalid`, name: 'o', passwordHash: 'x' } });
  const workspaceId = (await db.workspace.create({ data: { ownerId, name: 'home' } })).id;
  const projectId = (await db.project.create({ data: { ownerId, title: 'Checkout redesign' } })).id;
  const mk = async (title: string) => (await db.session.create({
    data: { ownerId, creatorId: ownerId, title, prompt: 'p', workspaceId, turnState: null, dispatchOrigin: 'USER' },
  })).id;
  const outgoing = await mk('the coordinator');
  const bystander = await mk('Payment retries');
  await db.project.update({ where: { id: projectId }, data: { coordinatorSessionId: outgoing, coordinatorWorkspaceId: workspaceId } });
  const taskId = (await db.task.create({
    data: { ownerId, creatorType: 'USER', creatorId: ownerId, title: 'Fix login redirect', projectId, completionCriterion: 'OWNER_CONFIRMED' },
  })).id;
  return { db, ownerId, projectId, workspaceId, outgoing, bystander, taskId };
}

const TERMINAL = new Set(['MATCHED', 'EXPIRED', 'CANCELLED', 'REVOKED', 'UNRESOLVABLE']);

async function watch(f: Fixture, observer: string, state: string, target: { kind: 'TASK' | 'SESSION'; id: string; leaf: string }) {
  const expiresAt = new Date(Date.now() + 3_600_000);
  return (await f.db.watch.create({
    data: {
      ownerId: f.ownerId, observerType: 'SESSION', observerSessionId: observer,
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: target.leaf }, action: 'RESUME_SESSION',
      state, generation: state === 'MATCHED' ? 1 : 0, expiresAt,
      nextEvaluateAt: TERMINAL.has(state) ? null : expiresAt,
      targets: { create: [{ targetKind: target.kind, targetResourceId: target.id }] },
    },
  })).id;
}

/** The two services, real, over a session service that writes real rows and records what it was asked. */
function services(f: Fixture) {
  const db = f.db;
  const turns: Array<{ sessionId: string; clientTurnId: string; content: string; intent?: string }> = [];
  const openings: Array<{ id: string; prompt: string; engine?: string; provider?: string; model?: string }> = [];
  /** Successors the stand-in's resolution refuses, by provider slug, as create() would. */
  const refusedProviders = new Set<string>();
  const completed: string[] = [];
  /** What each completion was asked: a handoff's keeps the outgoing coordinator's background work running. */
  const completeOpts: Array<{ handingOver?: boolean } | undefined> = [];
  const interrupted: string[] = [];
  const published: string[] = [];
  let seq = 100;
  const sessions = {
    // The note turn goes through resume, which revives an ended conversation; a live one gets the turn as is.
    resume: async (_owner: string, sessionId: string, dto: { clientTurnId: string; content: string; intent?: string }) => {
      turns.push({ sessionId, ...dto });
      await db.session.updateMany({
        where: { id: sessionId, status: { in: ['SUCCEEDED', 'FAILED', 'CANCELLED'] } },
        // As the real revive: held again, so the release column and its cause go with the terminal status.
        data: { turnState: 'QUEUED', finishedAt: null},
      });
      await db.conversationTurn.create({
        data: { sessionId, seq: seq++, clientTurnId: dto.clientTurnId, content: dto.content, kind: 'message', sendIntent: dto.intent ?? null },
      });
    },
    cancelQueuedTurn: async (_owner: string, sessionId: string, turnId: string) => {
      await db.conversationTurn.deleteMany({ where: { id: turnId, sessionId, status: 'PENDING' } });
    },
    interrupt: async (_owner: string, sessionId: string) => { interrupted.push(sessionId); },
    complete: async (_owner: string, id: string, opts?: { handingOver?: boolean }) => {
      completed.push(id);
      completeOpts.push(opts);
      await db.session.update({ where: { id }, data: { completedAt: new Date() } });
      return { ok: true };
    },
    assertStartResolves: async (_owner: string, target: { provider?: string | null }) => {
      if (target.provider && refusedProviders.has(target.provider)) {
        throw new BadRequestException(`provider "${target.provider}" cannot run here`);
      }
    },
    create: async (owner: string, dto: { workspaceId: string; title: string; prompt: string; engine?: string; provider?: string; model?: string }) => {
      const row = await db.session.create({
        data: {
          ownerId: owner, creatorId: owner, title: dto.title, prompt: dto.prompt, workspaceId: dto.workspaceId,
          turnState: null, dispatchOrigin: 'USER', titleManagedByProject: true,
        },
      });
      openings.push({ id: row.id, prompt: dto.prompt, engine: dto.engine, provider: dto.provider, model: dto.model });
      return { id: row.id };
    },
    discardProjectCoordinatorCandidate: async (_owner: string, id: string) => {
      await db.session.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },
    announceProjectSessionChanged: () => undefined,
  } as unknown as SessionsService;
  const realtime = new Proxy({}, {
    get: (_t, name) => name === 'publishSessionUpdated'
      ? (sessionId: string) => { published.push(sessionId); }
      : () => undefined,
  }) as unknown as RealtimeService;
  const projects = new ProjectsService(db as unknown as PrismaService, undefined, sessions, realtime);
  const handoffs = new CoordinatorHandoffService(db as unknown as PrismaService, projects, sessions, realtime);
  return { db, projects, handoffs, turns, openings, completed, completeOpts, interrupted, published, refusedProviders };
}

/** The engine took the note turn and the turn failed there: delivered, then ended FAILED. */
async function failedInEngine(s: { db: PrismaClient; handoffs: CoordinatorHandoffService }, sessionId: string, turnId: string) {
  await s.db.conversationTurn.update({ where: { id: turnId }, data: { deliveredAt: new Date() } });
  await s.handoffs.afterTurn(sessionId, turnId, 'FAILED');
}

/** The note turn the handoff asked for, as a row. */
async function noteTurn(f: Fixture, clientTurnId: string) {
  return f.db.conversationTurn.findUniqueOrThrow({
    where: { sessionId_clientTurnId: { sessionId: f.outgoing, clientTurnId } },
  });
}

/** The runner ran the turn and flushed its reply: what turnComplete reads before it reports. */
async function reply(f: Fixture, turnId: string, text: string) {
  const top = await f.db.runEvent.aggregate({ where: { sessionId: f.outgoing }, _max: { seq: true } });
  let seq = (top._max.seq ?? 0) + 1;
  await f.db.runEvent.create({ data: { sessionId: f.outgoing, seq: seq++, type: 'assistant', turnId, payload: { text: 'Let me check the tasks first.' } } });
  await f.db.runEvent.create({ data: { sessionId: f.outgoing, seq: seq++, type: 'assistant', turnId, payload: { text: 'sub-agent report', parentToolUseId: 'toolu_1' } } });
  await f.db.runEvent.create({ data: { sessionId: f.outgoing, seq: seq++, type: 'assistant', turnId, payload: { text } } });
  await f.db.conversationTurn.update({ where: { id: turnId }, data: { status: 'ANSWERED', deliveredAt: new Date(), answeredAt: new Date() } });
}

async function projectPointer(f: Fixture) {
  return (await f.db.project.findUniqueOrThrow({ where: { id: f.projectId } })).coordinatorSessionId;
}

async function observers(f: Fixture, ids: string[]) {
  const rows = await f.db.watch.findMany({ where: { id: { in: ids } }, select: { id: true, observerSessionId: true, state: true } });
  return Object.fromEntries(rows.map((r) => [r.id, { observer: r.observerSessionId, state: r.state }]));
}

// ── Success ──────────────────────────────────────────────────────────────────────────────────────

test('success: the note turn\'s final text becomes the successor\'s opening, the outgoing is completed, its waits move', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const active = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const paused = await watch(f, f.outgoing, 'PAUSED', { kind: 'SESSION', id: f.bystander, leaf: 'SESSION_TURN_SETTLED' });
  const s = services(f);

  const started = await s.handoffs.start(f.ownerId, f.projectId);

  // A platform turn, after any running one, asking for exactly the four sections.
  assert.equal(started.state, 'WRITING');
  assert.equal(s.turns.length, 1);
  const asked = s.turns[0];
  assert.equal(asked.sessionId, f.outgoing);
  assert.equal(asked.intent, 'NEXT_TURN');
  assert.ok(asked.clientTurnId.startsWith(COORDINATOR_HANDOFF_TURN_PREFIX));
  assert.ok(isOrbitAuthoredTurn(asked.clientTurnId), 'the note turn is the platform\'s, not the owner\'s message');
  for (const section of COORDINATOR_HANDOFF_SECTIONS) assert.ok(asked.content.includes(`\n${section}\n`), section);
  assert.deepEqual((await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing)).coordinatorHandoff?.state, 'WRITING');
  assert.ok(s.published.includes(f.outgoing), 'the outgoing session is told it is WRITING');

  // Nothing has moved while it writes.
  assert.equal(await projectPointer(f), f.outgoing);

  const turn = await noteTurn(f, asked.clientTurnId);
  await reply(f, turn.id, NOTE);
  await s.handoffs.afterTurn(f.outgoing, turn.id, 'SUCCEEDED');

  const successor = await projectPointer(f);
  assert.notEqual(successor, f.outgoing);
  assert.deepEqual(s.completed, [f.outgoing], 'the outgoing coordinator is completed');
  // As a handover: its end turn tells the runner to leave its SubAgent runs and bg_run jobs running
  // (SessionsService.complete, session-complete-keeps-work.spec.ts), and their wake comes here.
  assert.deepEqual(s.completeOpts, [{ handingOver: true }], 'the completion is a handover');
  const opening = s.openings.find((o) => o.id === successor)!.prompt;
  assert.ok(opening.includes(`<handoff_note>\n${NOTE}\n</handoff_note>`), 'the note — the final top-level text — is in the opening');
  assert.match(opening, /disagrees with the note or with the digest above, the later read wins/);
  assert.ok(opening.indexOf('</state_digest>') < opening.indexOf('<handoff_note>'), 'the digest is in the opening, before the note');
  assert.ok(!opening.includes('Read first'), 'a successor does not have to read before its first report');
  assert.ok(opening.indexOf('this is its coordinator session') < opening.indexOf('<handoff_note>'), 'after the standing instructions');

  // Both waits moved; the PAUSED one kept its state.
  assert.deepEqual(await observers(f, [active, paused]), {
    [active]: { observer: successor, state: 'ACTIVE' },
    [paused]: { observer: successor, state: 'PAUSED' },
  });

  const out = await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing);
  assert.deepEqual(out.coordinatorHandoff, {
    state: 'COMPLETED', startedAt: out.coordinatorHandoff!.startedAt, failureCode: null, failureReason: null,
    handedOverToSessionId: successor, successor: null,
  });
  assert.equal(out.coordinatorHandoffReceived, null);
  const anchored = s.openings.find((o) => o.id === successor)!;
  assert.deepEqual([anchored.engine, anchored.provider, anchored.model], [undefined, undefined, undefined],
    'nothing named: the successor follows the previous coordinator (its anchor)');
  const inn = await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, successor!);
  assert.equal(inn.coordinatorHandoff, null);
  assert.equal(inn.coordinatorHandoffReceived?.handoffFromSessionId, f.outgoing);
  assert.equal(inn.coordinatorHandoffReceived?.note, NOTE);
  assert.deepEqual(inn.coordinatorHandoffReceived?.movedWaits, [
    { id: active, kind: 'WATCH', label: 'Waiting for "Fix login redirect" to be DONE', paused: false },
    { id: paused, kind: 'WATCH', label: 'Waiting for "Payment retries" to finish its turn', paused: true },
  ]);
  assert.ok(s.published.includes(successor!), 'the successor is told it received a handoff');

  // A late duplicate of the turn's end settles nothing.
  await s.handoffs.afterTurn(f.outgoing, turn.id, 'SUCCEEDED');
  assert.equal(await projectPointer(f), successor);
});

test('requested while a turn runs: the note turn queues behind it, and that turn\'s own end settles nothing', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  await f.db.session.update({ where: { id: f.outgoing }, data: { turnState: 'IN_FLIGHT' } });
  const running = await f.db.conversationTurn.create({
    data: { sessionId: f.outgoing, seq: 1, clientTurnId: 'owner-typed', content: 'how are we doing?', kind: 'message', status: 'IN_FLIGHT', deliveredAt: new Date() },
  });
  const s = services(f);

  const started = await s.handoffs.start(f.ownerId, f.projectId);
  assert.equal(started.state, 'WRITING');
  assert.equal(s.turns[0].intent, 'NEXT_TURN', 'queued as the next turn, not steered into the running one');
  const queued = await noteTurn(f, s.turns[0].clientTurnId);
  assert.equal(queued.status, 'PENDING');

  // The running turn ends: not the note turn, so nothing happens.
  await reply(f, running.id, 'All on track.');
  await s.handoffs.afterTurn(f.outgoing, running.id, 'SUCCEEDED');
  assert.equal(await projectPointer(f), f.outgoing);
  assert.equal((await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing)).coordinatorHandoff?.state, 'WRITING');

  // The sweep leaves a queued note turn alone while it is within its time.
  assert.equal(await s.handoffs.sweep(), 0);

  // Then the note turn runs and ends.
  await reply(f, queued.id, NOTE);
  await s.handoffs.afterTurn(f.outgoing, queued.id, 'SUCCEEDED');
  assert.notEqual(await projectPointer(f), f.outgoing);
});

// ── Failure changes nothing ──────────────────────────────────────────────────────────────────────

for (const [label, end, code, reason] of [
  ['an error', 'FAILED', 'TURN_FAILED', "The handoff note wasn't written: the turn failed."],
  ['a user stop', 'INTERRUPTED', 'TURN_STOPPED', "The handoff note wasn't written: the turn was stopped."],
] as const) {
  test(`failure (${label}): FAILED with a reason; the old coordinator stays current and no wait moves`, { skip, timeout: 120_000 }, async () => {
    const f = await fixture();
    const active = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
    const paused = await watch(f, f.outgoing, 'PAUSED', { kind: 'TASK', id: f.taskId, leaf: 'TASK_FAILED' });
    const s = services(f);
    await s.handoffs.start(f.ownerId, f.projectId);
    const turn = await noteTurn(f, s.turns[0].clientTurnId);

    // The engine took it, then it ended this way.
    await f.db.conversationTurn.update({ where: { id: turn.id }, data: { deliveredAt: new Date() } });
    await s.handoffs.afterTurn(f.outgoing, turn.id, end);

    assert.equal(await projectPointer(f), f.outgoing);
    assert.deepEqual(s.completed, []);
    assert.deepEqual(s.openings, []);
    assert.deepEqual(await observers(f, [active, paused]), {
      [active]: { observer: f.outgoing, state: 'ACTIVE' },
      [paused]: { observer: f.outgoing, state: 'PAUSED' },
    });
    const { coordinatorHandoff } = await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing);
    assert.equal(coordinatorHandoff?.state, 'FAILED');
    assert.equal(coordinatorHandoff?.failureCode, code);
    assert.equal(coordinatorHandoff?.failureReason, reason);
    assert.equal(coordinatorHandoff?.handedOverToSessionId, null);
  });
}

test('failure (timeout, a stop that dropped the queued turn, an empty reply): FAILED, nothing else changes', { skip, timeout: 120_000 }, async () => {
  // Timed out: delivered and still running past its time — FAILED, and the running turn is stopped.
  {
    const f = await fixture();
    const s = services(f);
    await s.handoffs.start(f.ownerId, f.projectId);
    const turn = await noteTurn(f, s.turns[0].clientTurnId);
    await f.db.conversationTurn.update({ where: { id: turn.id }, data: { status: 'IN_FLIGHT', deliveredAt: new Date(Date.now() - 11 * 60_000) } });
    assert.equal(await s.handoffs.sweep(), 1);
    const { coordinatorHandoff } = await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing);
    assert.equal(coordinatorHandoff?.failureCode, 'TIMED_OUT');
    assert.equal(coordinatorHandoff?.failureReason, "The handoff note wasn't written: the turn timed out.");
    assert.deepEqual(s.interrupted, [f.outgoing]);
    assert.equal(await projectPointer(f), f.outgoing);
    // The turn ending afterwards, even successfully, settles nothing: the attempt is over.
    await reply(f, turn.id, NOTE);
    await s.handoffs.afterTurn(f.outgoing, turn.id, 'SUCCEEDED');
    assert.equal(await projectPointer(f), f.outgoing);
    assert.equal((await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing)).coordinatorHandoff?.state, 'FAILED');
  }
  // A stop that took the queued turn off the queue: the sweep finds no turn.
  {
    const f = await fixture();
    const s = services(f);
    await s.handoffs.start(f.ownerId, f.projectId);
    await f.db.conversationTurn.deleteMany({ where: { sessionId: f.outgoing, clientTurnId: s.turns[0].clientTurnId } });
    assert.equal(await s.handoffs.sweep(), 1);
    assert.equal((await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing)).coordinatorHandoff?.failureCode, 'TURN_STOPPED');
    assert.equal(await projectPointer(f), f.outgoing);
  }
  // A reply with no text.
  {
    const f = await fixture();
    const s = services(f);
    await s.handoffs.start(f.ownerId, f.projectId);
    const turn = await noteTurn(f, s.turns[0].clientTurnId);
    await s.handoffs.afterTurn(f.outgoing, turn.id, 'SUCCEEDED');
    assert.equal((await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing)).coordinatorHandoff?.failureCode, 'EMPTY_NOTE');
    assert.equal(await projectPointer(f), f.outgoing);
    assert.deepEqual(s.completed, []);
  }
});

// ── Try again ────────────────────────────────────────────────────────────────────────────────────

test('try again after a failure: a new note turn under a new key; the old turn\'s end settles nothing; the new one hands over', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const active = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const s = services(f);
  await s.handoffs.start(f.ownerId, f.projectId);
  const first = await noteTurn(f, s.turns[0].clientTurnId);
  await failedInEngine(s, f.outgoing, first.id);

  const retried = await s.handoffs.retry(f.ownerId, f.projectId);
  assert.equal(retried.state, 'WRITING');
  assert.equal(retried.failureReason, null);
  assert.equal(s.turns.length, 2);
  assert.notEqual(s.turns[1].clientTurnId, s.turns[0].clientTurnId);
  assert.equal(s.turns[1].intent, 'NEXT_TURN');

  // The first attempt's turn reporting again is not this attempt's.
  await s.handoffs.afterTurn(f.outgoing, first.id, 'SUCCEEDED');
  assert.equal((await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing)).coordinatorHandoff?.state, 'WRITING');

  const second = await noteTurn(f, s.turns[1].clientTurnId);
  await reply(f, second.id, NOTE);
  await s.handoffs.afterTurn(f.outgoing, second.id, 'SUCCEEDED');
  const successor = await projectPointer(f);
  assert.notEqual(successor, f.outgoing);
  assert.equal((await observers(f, [active]))[active].observer, successor);

  // Start on a FAILED handoff is Try again, too.
  const g = await fixture();
  const t = services(g);
  await t.handoffs.start(g.ownerId, g.projectId);
  await failedInEngine(t, g.outgoing, (await noteTurn(g, t.turns[0].clientTurnId)).id);
  assert.equal((await t.handoffs.start(g.ownerId, g.projectId)).state, 'WRITING');
  assert.equal(t.turns.length, 2);
});

// ── Skip ─────────────────────────────────────────────────────────────────────────────────────────

test('skip the note while WRITING: replaced at once with no note, the queued note turn left to the completion', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const active = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const s = services(f);
  await s.handoffs.start(f.ownerId, f.projectId);
  const turn = await noteTurn(f, s.turns[0].clientTurnId);

  const skipped = await s.handoffs.skip(f.ownerId, f.projectId);

  const successor = await projectPointer(f);
  assert.equal(skipped.state, 'COMPLETED');
  assert.equal(skipped.handedOverToSessionId, successor);
  assert.notEqual(successor, f.outgoing);
  assert.deepEqual(s.completed, [f.outgoing]);
  const opening = s.openings.find((o) => o.id === successor)!.prompt;
  assert.ok(!opening.includes('<handoff_note>'), 'no note in the opening');
  assert.equal((await observers(f, [active]))[active].observer, successor);
  const inn = await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, successor!);
  assert.equal(inn.coordinatorHandoffReceived?.note, null);
  assert.equal(inn.coordinatorHandoffReceived?.handoffFromSessionId, f.outgoing);

  // The note turn ending after the skip (the completion dropped it) changes nothing.
  await failedInEngine(s, f.outgoing, turn.id);
  assert.equal((await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing)).coordinatorHandoff?.state, 'COMPLETED');
});

test('hand over without a note after a failure, and with no handoff under way at all', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const s = services(f);
  await s.handoffs.start(f.ownerId, f.projectId);
  await failedInEngine(s, f.outgoing, (await noteTurn(f, s.turns[0].clientTurnId)).id);
  const skipped = await s.handoffs.skip(f.ownerId, f.projectId);
  assert.equal(skipped.state, 'COMPLETED');
  assert.equal(skipped.failureReason, null);
  assert.notEqual(await projectPointer(f), f.outgoing);

  const g = await fixture();
  const t = services(g);
  const direct = await t.handoffs.skip(g.ownerId, g.projectId);
  assert.equal(direct.state, 'COMPLETED');
  assert.deepEqual(t.turns, [], 'no note turn was asked for');
});

test('a successor opened without a handoff — the owner\'s replace, a workspace switch — opens with the digest and the owner\'s answers in force', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const s = services(f);
  // An answer the outgoing coordinator asked for, read long ago, whose task is still open: in force.
  const resolvedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await f.db.projectOpenItem.create({
    data: {
      projectId: f.projectId, ownerId: f.ownerId, kind: 'COORDINATOR_QUESTION', state: 'RESOLVED',
      resolution: 'ANSWERED', resolvedAt, assignee: 'OWNER', assigneeReason: 'DEFAULT',
      dedupeKey: `question:${randomUUID()}`, title: 'Split the redirect fix?', waitingSince: resolvedAt, assignedAt: resolvedAt,
      askedBySessionId: f.outgoing,
      payload: {
        question: 'Split the redirect fix into two tasks?', options: [{ label: 'Keep it one task' }, { label: 'Split it' }],
        recommendedOption: 0, blocksTaskIds: [f.taskId], ifUnanswered: null,
      },
      answer: { option: 0, answeredByUserId: f.ownerId },
    },
  });

  const replaced = await s.projects.coordinator(f.ownerId, f.projectId, undefined, 'replace');

  assert.notEqual(replaced.sessionId, f.outgoing);
  const opening = s.openings.find((o) => o.id === replaced.sessionId)!.prompt;
  assert.ok(opening.includes('<state_digest as_of="'), 'the digest is in the opening, as on a handoff');
  assert.ok(!opening.includes('<handoff_note>'), 'no handoff, so no note');
  assert.ok(!opening.includes('Read first'), 'it reports from the digest');
  assert.match(opening, /\nOwner answers in force \(to questions coordinators asked; newest first\):\n- \d{4}-\d{2}-\d{2} · Split the redirect fix into two tasks\? → Keep it one task · /,
    'the answer the outgoing coordinator read is in the opening, where it costs no turn');
  assert.deepEqual(s.turns, [], 'and it is not replayed as a turn of its own');

  // A project's first coordinator is told the standing instructions alone, as before.
  const g = await fixture();
  await g.db.project.update({ where: { id: g.projectId }, data: { coordinatorSessionId: null } });
  const t = services(g);
  const first = await t.projects.coordinator(g.ownerId, g.projectId);
  const firstOpening = t.openings.find((o) => o.id === first.sessionId)!.prompt;
  assert.ok(!firstOpening.includes('<state_digest'), 'nothing came before it to digest');
  assert.ok(firstOpening.includes('Read first'));
});

// ── Cancel ───────────────────────────────────────────────────────────────────────────────────────

test('cancel handover: nothing changes, the queued note turn is withdrawn, and the session shows no handoff', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const active = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const s = services(f);
  await s.handoffs.start(f.ownerId, f.projectId);
  const turn = await noteTurn(f, s.turns[0].clientTurnId);

  const cancelled = await s.handoffs.cancel(f.ownerId, f.projectId);

  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(await projectPointer(f), f.outgoing);
  assert.deepEqual(s.completed, []);
  assert.deepEqual(s.openings, []);
  assert.equal((await observers(f, [active]))[active].observer, f.outgoing);
  assert.equal(await f.db.conversationTurn.findUnique({ where: { id: turn.id } }), null, 'the queued note turn is taken back');
  assert.deepEqual(await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing), {
    coordinatorHandoff: null, coordinatorHandoffReceived: null,
  });
  // A late end of that turn changes nothing either, and a new handoff can start.
  await s.handoffs.afterTurn(f.outgoing, turn.id, 'SUCCEEDED');
  assert.equal(await projectPointer(f), f.outgoing);
  assert.equal((await s.handoffs.start(f.ownerId, f.projectId)).state, 'WRITING');

  // Keep this coordinator, after a failure, is the same cancel; a running note turn is stopped.
  const g = await fixture();
  const t = services(g);
  await t.handoffs.start(g.ownerId, g.projectId);
  const running = await noteTurn(g, t.turns[0].clientTurnId);
  await g.db.conversationTurn.update({ where: { id: running.id }, data: { status: 'IN_FLIGHT', deliveredAt: new Date() } });
  await t.handoffs.cancel(g.ownerId, g.projectId);
  assert.deepEqual(t.interrupted, [g.outgoing]);
  await t.handoffs.start(g.ownerId, g.projectId);
  await failedInEngine(t, g.outgoing, (await noteTurn(g, t.turns[1].clientTurnId)).id);
  assert.equal((await t.handoffs.cancel(g.ownerId, g.projectId)).state, 'CANCELLED');
  assert.equal(await projectPointer(g), g.outgoing);
});

// ── One handoff at a time, and the preview ───────────────────────────────────────────────────────

test('two presses of Hand over meet one handoff and one note turn', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const s = services(f);
  const [a, b] = await Promise.all([s.handoffs.start(f.ownerId, f.projectId), s.handoffs.start(f.ownerId, f.projectId)]);
  assert.equal(a.state, 'WRITING');
  assert.equal(b.state, 'WRITING');
  assert.equal(await f.db.coordinatorHandoff.count({ where: { fromSessionId: f.outgoing } }), 1);
  assert.equal(await f.db.conversationTurn.count({ where: { sessionId: f.outgoing } }), 1);
});

test('the pending-waits preview lists ACTIVE and PAUSED waits, the PAUSED ones marked', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const active = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const paused = await watch(f, f.outgoing, 'PAUSED', { kind: 'SESSION', id: f.bystander, leaf: 'SESSION_TURN_SETTLED' });
  await watch(f, f.outgoing, 'MATCHED', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  await watch(f, f.bystander, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const s = services(f);
  assert.deepEqual(await s.projects.coordinatorPendingWaits(f.ownerId, f.projectId), [
    { id: active, kind: 'WATCH', label: 'Waiting for "Fix login redirect" to be DONE', paused: false },
    { id: paused, kind: 'WATCH', label: 'Waiting for "Payment retries" to finish its turn', paused: true },
  ]);
});

// ── The current model no longer works ───────────────────────────────────────────────────────────

test('an ended coordinator (FAILED, or recycled while idle) is revived for its note rather than refused', { skip, timeout: 120_000 }, async () => {
  for (const status of ['FAILED', 'CANCELLED'] as const) {
    const f = await fixture();
    // Released as the writers release (session_release_fact_chk, and every writer since 1403/1404): finished_at and
    // a cause, a failure cause for FAILED.
    await f.db.session.update({
      where: { id: f.outgoing },
      data: { turnState: turnStateOfWord(status), finishedAt: new Date()},
    });
    const s = services(f);
    const started = await s.handoffs.start(f.ownerId, f.projectId);
    assert.equal(started.state, 'WRITING', status);
    assert.equal(s.turns.length, 1, status);
    assert.equal(wordOf((await f.db.session.findUniqueOrThrow({ where: { id: f.outgoing } }))), 'PENDING', `${status}: revived`);
  }
});

test('the revived coordinator fails again before its note turn reaches the engine: COORDINATOR_CANT_RUN at the sweep, not an hour later', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const s = services(f);
  await s.handoffs.start(f.ownerId, f.projectId);
  // Its model cannot run: the claim fails and the conversation is FAILED, the note turn never delivered. The failure is
  // on the turn the claim was for, copied to lastTurnOutcome (removal step R2), which is what reads it as failed (R7).
  await f.db.session.update({
    where: { id: f.outgoing }, data: { turnState: null, finishedAt: new Date(), lastTurnOutcome: 'FAILED' },
  });
  assert.equal(await s.handoffs.sweep(), 1);
  const { coordinatorHandoff } = await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing);
  assert.equal(coordinatorHandoff?.state, 'FAILED');
  assert.equal(coordinatorHandoff?.failureCode, 'COORDINATOR_CANT_RUN');
  assert.equal(coordinatorHandoff?.failureReason,
    "The handoff note wasn't written: the model of this coordinator could not start. Pick another model and hand over without a note.");
  assert.equal(await projectPointer(f), f.outgoing, 'nothing else changed: no successor was picked');
});

test('the coordinator cannot run and the owner picked a successor: the handover goes on without a note, on that successor', { skip, timeout: 120_000 }, async () => {
  // The turn-complete hook: the note turn failed without the engine ever taking it.
  {
    const f = await fixture();
    const active = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
    const s = services(f);
    await s.handoffs.start(f.ownerId, f.projectId, { successor: { engine: 'claude', provider: 'claude' } });
    await s.handoffs.afterTurn(f.outgoing, (await noteTurn(f, s.turns[0].clientTurnId)).id, 'FAILED');
    const successor = await projectPointer(f);
    assert.notEqual(successor, f.outgoing, 'handed over');
    assert.deepEqual(s.completed, [f.outgoing]);
    const opened = s.openings.find((o) => o.id === successor)!;
    assert.deepEqual([opened.engine, opened.provider], ['claude', 'claude'], 'on the picked model');
    assert.ok(!opened.prompt.includes('<handoff_note>'), 'with no note');
    assert.equal((await observers(f, [active]))[active].observer, successor, 'its waits moved');
    const inn = await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, successor!);
    assert.equal(inn.coordinatorHandoffReceived?.note, null);
    assert.equal(inn.coordinatorHandoffReceived?.handoffFromSessionId, f.outgoing);
  }
  // The sweep: the revived conversation failed again before its note turn was delivered.
  {
    const f = await fixture();
    const s = services(f);
    await s.handoffs.start(f.ownerId, f.projectId, { successor: { engine: 'claude', provider: 'claude' } });
    // The claim failed: FAILED on the turn it was for, copied (removal step R2), which reads it as failed since R7.
    await f.db.session.update({ where: { id: f.outgoing }, data: { turnState: null, finishedAt: new Date(), lastTurnOutcome: 'FAILED' } });
    assert.equal(await s.handoffs.sweep(), 1);
    assert.notEqual(await projectPointer(f), f.outgoing, 'handed over');
    assert.equal((await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing)).coordinatorHandoff?.state, 'COMPLETED');
  }
  // A note turn the engine took and then failed is the ordinary failure: Try again may help, nothing moves.
  {
    const f = await fixture();
    const s = services(f);
    await s.handoffs.start(f.ownerId, f.projectId, { successor: { engine: 'claude', provider: 'claude' } });
    await failedInEngine(s, f.outgoing, (await noteTurn(f, s.turns[0].clientTurnId)).id);
    assert.equal(await projectPointer(f), f.outgoing);
    assert.equal((await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing)).coordinatorHandoff?.failureCode, 'TURN_FAILED');
  }
});

test('the successor runs on what the owner named: kept from Hand over, replaced by a later pick, refused up front when it cannot open', { skip, timeout: 120_000 }, async () => {
  // Named in the confirm, kept through the note turn, used by the replacement.
  {
    const f = await fixture();
    const s = services(f);
    const started = await s.handoffs.start(f.ownerId, f.projectId, { successor: { engine: 'claude', provider: ' claude ', model: '' } });
    assert.deepEqual(started.successor, { engine: 'claude', provider: 'claude', model: null });
    const turn = await noteTurn(f, s.turns[0].clientTurnId);
    await reply(f, turn.id, NOTE);
    await s.handoffs.afterTurn(f.outgoing, turn.id, 'SUCCEEDED');
    const pointer = await projectPointer(f);
    const opened = s.openings.find((o) => o.id === pointer)!;
    assert.deepEqual([opened.engine, opened.provider, opened.model], ['claude', 'claude', undefined]);
  }
  // The note failed (the old model is broken); Hand over without a note names another, which wins.
  {
    const f = await fixture();
    const s = services(f);
    await s.handoffs.start(f.ownerId, f.projectId, { successor: { engine: 'codex' } });
    await failedInEngine(s, f.outgoing, (await noteTurn(f, s.turns[0].clientTurnId)).id);
    const failed = await readSessionCoordinatorHandoffs(f.db as unknown as PrismaService, f.outgoing);
    assert.deepEqual(failed.coordinatorHandoff?.successor, { engine: 'codex', provider: null, model: null }, 'the failure shows the pick');
    const skipped = await s.handoffs.skip(f.ownerId, f.projectId, { successor: { engine: 'kimi', model: 'kimi-k3' } });
    assert.equal(skipped.state, 'COMPLETED');
    const opened = s.openings.find((o) => o.id === skipped.handedOverToSessionId)!;
    assert.deepEqual([opened.engine, opened.provider, opened.model], ['kimi', undefined, 'kimi-k3']);
  }
  // A pick that could not open is refused before anything happens: no row, no turn, nothing completed.
  {
    const f = await fixture();
    const s = services(f);
    s.refusedProviders.add('gone-key');
    await assert.rejects(s.handoffs.skip(f.ownerId, f.projectId, { successor: { provider: 'gone-key' } }), BadRequestException);
    await assert.rejects(s.handoffs.start(f.ownerId, f.projectId, { successor: { provider: 'gone-key' } }), BadRequestException);
    assert.deepEqual(s.completed, []);
    assert.deepEqual(s.turns, []);
    assert.equal(await f.db.coordinatorHandoff.count({ where: { projectId: f.projectId } }), 0);
    assert.equal(await projectPointer(f), f.outgoing);
    await assert.rejects(s.handoffs.start(f.ownerId, f.projectId, { successor: { engine: 7 } } as never), BadRequestException);
  }
});

test('"Same as this one" (successor: null) clears an earlier pick; leaving successor out keeps it', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const s = services(f);
  await s.handoffs.start(f.ownerId, f.projectId, { successor: { engine: 'codex', provider: 'codex' } });
  await failedInEngine(s, f.outgoing, (await noteTurn(f, s.turns[0].clientTurnId)).id);
  // Try again with no successor in the body keeps the pick.
  const kept = await s.handoffs.retry(f.ownerId, f.projectId, {});
  assert.deepEqual(kept.successor, { engine: 'codex', provider: 'codex', model: null });
  await failedInEngine(s, f.outgoing, (await noteTurn(f, s.turns[1].clientTurnId)).id);
  // Hand over without a note on "Same as this one" clears it: the successor follows the previous coordinator.
  const skipped = await s.handoffs.skip(f.ownerId, f.projectId, { successor: null });
  assert.equal(skipped.state, 'COMPLETED');
  assert.equal(skipped.successor, null);
  const opened = s.openings.find((o) => o.id === skipped.handedOverToSessionId)!;
  assert.deepEqual([opened.engine, opened.provider, opened.model], [undefined, undefined, undefined]);
  // An object with every field empty is the same as null.
  const g = await fixture();
  const t = services(g);
  await t.handoffs.start(g.ownerId, g.projectId, { successor: { engine: 'kimi' } });
  const cleared = await t.handoffs.start(g.ownerId, g.projectId, { successor: { engine: ' ', provider: null } });
  assert.equal(cleared.successor, null);
});

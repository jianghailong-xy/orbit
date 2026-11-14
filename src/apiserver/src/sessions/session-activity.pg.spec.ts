import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import type { SessionActivity } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionGuestsService } from '../session-guests/session-guests.service';
import { SessionsService } from './sessions.service';

/**
 * Every session — not only a task's work session — says what it is doing beyond its status, on every
 * door that shows its state, against a real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-activity.pg.spec.ts
 *
 * WHAT WAS WRONG
 * ==============
 * 2026-11-13: a shared session was running a background task, and its public page said "Awaiting
 * reply". The page read `status` alone, and a parked session — AWAITING_INPUT — is parked whether the
 * engine is generating on its own, a sub-agent or a `bg_run` job is in flight, or a watch, wake-up or
 * retry will resume it. The answer to "is it still working?" existed (`sessionRunReasonSql`) but only
 * for a task's carrier, and only the owner's web view rebuilt part of it from raw columns.
 *
 * WHAT IS ASSERTED
 * ================
 * One case per wake source on a plain conversation (no task): the owner's list row, the shared
 * header (a public link and the guest page) and the guest's Shared with me all carry the same
 * `activity`. Paired with the cases that must stay null: a `service` left up, nothing to wake it, an
 * ended session — and RUNNING, which is TURN.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);

interface Stack {
  db: PrismaClient;
  sessions: SessionsService;
  guests: SessionGuestsService;
}

function connect(): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return { db, sessions, guests: new SessionGuestsService(prisma, sessions) };
}

interface World {
  ownerId: string;
  guestId: string;
  sessionId: string;
}

/** An owner's plain conversation at `status` with `parked` on it, shared with one guest. */
async function world(
  db: PrismaClient,
  label: string,
  parked: Partial<Prisma.SessionUncheckedCreateInput>,
  status: RunStatus,
): Promise<World> {
  const w: World = { ownerId: randomUUID(), guestId: randomUUID(), sessionId: randomUUID() };
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  for (const [id, who] of [[w.ownerId, 'owner'], [w.guestId, 'guest']] as const) {
    await db.user.create({
      data: { id, email: `${label}-${who}-${RUN}-${id}@session-activity.invalid`, name: `${label} ${who}`, passwordHash: 'x' },
    });
  }
  await db.runner.create({
    data: {
      id: runnerId, ownerId: w.ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: w.ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.session.create({
    data: {
      id: w.sessionId, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `${label} conversation`, prompt: 'hello', provider: 'claude', status,
      dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(Date.now() - 60 * 60_000), numTurns: 1,
      ...parked,
    },
  });
  await db.sessionGuest.create({ data: { sessionId: w.sessionId, userId: w.guestId, ownerId: w.ownerId } });
  return w;
}

/** `activity` as each door that shows the session's state says it. */
async function readEverywhere(stack: Stack, w: World) {
  const [row] = await stack.sessions.listRowsByIds(w.ownerId, [w.sessionId]);
  assert.ok(row, 'the session is missing from its owner\'s list');
  const shared = await stack.sessions.getSharedTranscript(w.sessionId);
  const after = await stack.sessions.getSharedEventsAfter(w.sessionId, { after: 0 });
  const mine = (await stack.guests.sharedWithMe(w.guestId)).sessions.find((s) => s.id === w.sessionId);
  assert.ok(mine, 'the session is missing from its guest\'s Shared with me');
  return {
    ownerList: (row as { activity?: unknown }).activity,
    sharedHead: shared.activity,
    sharedFollow: after.activity,
    sharedWithMe: mine.activity,
  };
}

const everywhere = (activity: SessionActivity | null) =>
  ({ ownerList: activity, sharedHead: activity, sharedFollow: activity, sharedWithMe: activity });

const CASES: Array<{
  name: string;
  activity: SessionActivity | null;
  status?: RunStatus;
  parked?: Partial<Prisma.SessionUncheckedCreateInput>;
  arm?: (db: PrismaClient, w: World) => Promise<unknown>;
}> = [
  { name: 'a turn the engine is generating on its own', activity: 'TURN', parked: { engineTurnActive: true } },
  { name: 'a sub-agent still in flight', activity: 'TURN', parked: { runningSubagents: ['toolu_subagent'] } },
  {
    name: 'a bg_run job it will be woken by',
    activity: 'BACKGROUND_JOB',
    parked: {
      runningBgShells: ['bgj_matrix'],
      runningBgJobs: ['bgj_matrix'],
      runningBgJobActivity: { bgj_matrix: Date.now() - 30_000 },
    },
  },
  {
    name: 'an ACTIVE RESUME_SESSION watch it observes',
    activity: 'WAITING',
    arm: (db, w) => db.watch.create({
      data: {
        ownerId: w.ownerId,
        observerType: 'SESSION',
        observerSessionId: w.sessionId,
        predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
        mode: 'ONE_SHOT',
        action: 'RESUME_SESSION',
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    }),
  },
  {
    name: 'a pending scheduled wake-up',
    activity: 'WAITING',
    arm: (db, w) => db.sessionScheduledWakeup.create({
      data: { sessionId: w.sessionId, delaySeconds: 1800, reason: 'check back', dueAt: new Date(Date.now() + 30 * 60_000) },
    }),
  },
  { name: 'an armed auto-retry', activity: 'WAITING', parked: { retryAt: new Date(Date.now() + 20 * 60_000) } },
  { name: 'only a service left up (a dev server)', activity: null, parked: { runningBgShells: ['bgj_devserver'] } },
  { name: 'nothing that will wake it', activity: null },
  { name: 'a running turn', activity: 'TURN', status: RunStatus.RUNNING },
  { name: 'an ended session', activity: null, status: RunStatus.CANCELLED, parked: { endReason: 'cancelled' } },
];

for (const [index, c] of CASES.entries()) {
  test(`${c.status ?? 'AWAITING_INPUT'} with ${c.name}: activity ${c.activity ?? 'null'} on every door`,
    { skip, timeout: 120_000 }, async () => {
      const stack = connect();
      try {
        const w = await world(stack.db, `act${index}`, c.parked ?? {}, c.status ?? RunStatus.AWAITING_INPUT);
        await c.arm?.(stack.db, w);
        assert.deepEqual(await readEverywhere(stack, w), everywhere(c.activity));
      } finally {
        await stack.db.$disconnect();
      }
    });
}

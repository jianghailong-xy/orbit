import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient, RunnerStatus, RunStatus, SessionDispatchOrigin } from '@prisma/client';
import { ControlEventType } from '@orbit/shared';

import type { AttachmentsService } from '../attachments/attachments.service';
import { LinkPreviewsService } from '../link-previews/link-previews.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionGuestsService } from '../session-guests/session-guests.service';
import { TasksService } from '../tasks/tasks.service';
import { SessionsService } from './sessions.service';

/**
 * The session-payload fixture of plan step 5.1 (docs/session-three-state-plan.md §8): one owner's conversations, one
 * per stored status and one per shape the step names — a background job running, a turn waiting on an approval, a
 * watch armed, a queued turn on a paused account — each read through every payload kind a session is sent in.
 *
 * Deliberately built from what the base commit already had, and nothing this step added: the legacy-field spec
 * (session-payloads-legacy.pg.spec.ts) runs this same file at the base commit to write its golden table, so a
 * difference there is a changed wire value and not a changed fixture.
 */

/** The payload kinds, by the names contracts/session-state.contract.json gives them. */
export const PAYLOAD_KINDS = [
  'listRow', 'detail', 'sessionSummary', 'sessionEnded', 'linkPreview', 'guestRow', 'sharedHead', 'taskRun',
] as const;
export type PayloadKind = (typeof PAYLOAD_KINDS)[number];

/** A search hit (`GET /sessions/search`, the recents an empty query answers with): the six facts and the Background
 *  mark's inputs joined it later (task 353YrK2AEGTm6mfl8GrW9), so it is read beside the kinds above and is not one of
 *  them — the legacy golden (session-payloads-legacy.pg.spec.ts) has no rows for it. Search never answers a LANDING
 *  row, so the settled landing has none. */
export const SEARCH_HIT = 'searchHit';

export interface FixtureCase {
  label: string;
  status: RunStatus;
  row?: Partial<Prisma.SessionUncheckedCreateInput>;
  arm?: (db: PrismaClient, ownerId: string, sessionId: string) => Promise<unknown>;
}

const MINUTE = 60_000;

/** One case per stored status, then the four shapes, then a settled landing container (plan phase 5). */
export const FIXTURE_CASES: readonly FixtureCase[] = [
  { label: 'PENDING', status: RunStatus.PENDING },
  { label: 'RUNNING', status: RunStatus.RUNNING },
  { label: 'AWAITING_INPUT', status: RunStatus.AWAITING_INPUT, row: { lastTurnOutcome: 'ANSWERED' } },
  { label: 'INTERRUPTED', status: RunStatus.INTERRUPTED, row: { lastTurnOutcome: 'INTERRUPTED' } },
  { label: 'SUCCEEDED', status: RunStatus.SUCCEEDED, row: { endReason: 'task_done', lastTurnOutcome: 'ANSWERED' } },
  { label: 'FAILED', status: RunStatus.FAILED, row: { lastTurnOutcome: 'FAILED', error: 'engine exited' } },
  { label: 'CANCELLED', status: RunStatus.CANCELLED, row: { endReason: 'ended', lastTurnOutcome: 'ANSWERED' } },
  {
    label: 'job running',
    status: RunStatus.AWAITING_INPUT,
    row: {
      lastTurnOutcome: 'ANSWERED',
      runningBgShells: ['bgj_fixture'],
      runningBgJobs: ['bgj_fixture'],
      runningBgJobActivity: { bgj_fixture: Date.now() - 30_000 },
    },
  },
  {
    label: 'waiting on an approval',
    status: RunStatus.RUNNING,
    arm: (db, _ownerId, sessionId) => db.approval.create({
      data: { sessionId, toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseId: `toolu_${sessionId}` },
    }),
  },
  {
    label: 'watch armed',
    status: RunStatus.AWAITING_INPUT,
    row: { lastTurnOutcome: 'ANSWERED' },
    arm: (db, ownerId, sessionId) => db.watch.create({
      data: {
        ownerId,
        observerType: 'SESSION',
        observerSessionId: sessionId,
        predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
        mode: 'ONE_SHOT',
        action: 'RESUME_SESSION',
        state: 'ACTIVE',
        expiresAt: new Date(Date.now() + 24 * 60 * MINUTE),
      } as never,
    }),
  },
  {
    label: 'paused account',
    status: RunStatus.PENDING,
    row: { error: 'Account paused until 2099-01-01T00:00:00.000Z', lastTurnOutcome: 'ANSWERED' },
  },
  // Plan phase 5: a landing container that settled, released with no end reason — finished work with no task_done.
  { label: 'settled landing', status: RunStatus.SUCCEEDED, row: { sessionKind: 'LANDING', lastTurnOutcome: 'ANSWERED' } },
];

const RELEASED = new Set<RunStatus>([RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED]);

export interface Stack {
  db: PrismaClient;
  sessions: SessionsService;
  guests: SessionGuestsService;
  previews: LinkPreviewsService;
  tasks: TasksService;
  realtime: RealtimeService;
}

export function connect(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const push = { scheduleBadgeSync: () => undefined, notifySessionSettled: async () => undefined } as unknown as PushService;
  const realtime = new RealtimeService(prisma, push);
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(prisma, { notifySessionQueued: () => undefined } as unknown as QueueService, publishes);
  const tasks = new TasksService(prisma, sessions, publishes);
  return {
    db,
    sessions,
    guests: new SessionGuestsService(prisma, sessions, {} as AttachmentsService),
    previews: new LinkPreviewsService(prisma, sessions, tasks),
    tasks,
    realtime,
  };
}

export interface World {
  ownerId: string;
  guestId: string;
  /** Session id by case label. */
  ids: Map<string, string>;
  /** The task each case's session is the run of, by case label (the task detail's `sessions[]`): one live run per task. */
  taskIds: Map<string, string>;
}

/** The owner, an online runner, a workspace, a guest, and one shared conversation per case. */
export async function buildWorld(db: PrismaClient, run: string): Promise<World> {
  const w: World = { ownerId: randomUUID(), guestId: randomUUID(), ids: new Map(), taskIds: new Map() };
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  for (const [id, who] of [[w.ownerId, 'owner'], [w.guestId, 'guest']] as const) {
    await db.user.create({
      data: { id, email: `${who}-${run}-${id}@session-payloads.invalid`, name: `payloads ${who}`, passwordHash: 'x' },
    });
  }
  await db.runner.create({
    data: {
      id: runnerId, ownerId: w.ownerId, name: `payloads-runner-${run}`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 8,
      // Heard from just now: a PENDING row is held by its runner's silence otherwise.
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId: w.ownerId, runnerId, name: 'payloads-agent', enabled: true } });
  const taskIdOf = (label: string) => {
    if (!w.taskIds.has(label)) w.taskIds.set(label, randomUUID());
    return w.taskIds.get(label)!;
  };
  const makeTask = (label: string) => db.task.create({ data: { id: taskIdOf(label), ownerId: w.ownerId, creatorId: w.ownerId, creatorType: 'USER', completionCriterion: 'EVIDENCE_JUDGMENT', title: `payloads task ${label} ${run}`, autoRunWhenReady: false } });
  let n = 0;
  for (const c of FIXTURE_CASES) {
    const id = randomUUID();
    n += 1;
    await makeTask(c.label);
    await db.session.create({
      data: {
        id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId, assignedRunnerId: runnerId,
        title: `payloads ${c.label}`, taskId: taskIdOf(c.label), prompt: 'hello', provider: 'claude', status: c.status,
        dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(Date.now() - 60 * MINUTE), numTurns: 1,
        createdAt: new Date(Date.now() - n * MINUTE),
        ...(RELEASED.has(c.status) ? { finishedAt: new Date() } : {}),
        ...c.row,
      },
    });
    await db.sessionGuest.create({ data: { sessionId: id, userId: w.guestId, ownerId: w.ownerId } });
    await c.arm?.(db, w.ownerId, id);
    w.ids.set(c.label, id);
  }
  return w;
}

type Payload = Record<string, unknown>;

/** Each case's payload on every kind, by label then kind. */
export async function readPayloads(
  stack: Stack,
  w: World,
): Promise<Map<string, Record<PayloadKind, Payload> & { [SEARCH_HIT]: Payload | null }>> {
  const ids = [...w.ids.values()];
  const hits = new Map((await stack.sessions.search(w.ownerId, undefined, 50)).hits
    .map((hit) => [hit.id, hit as unknown as Payload]));
  const rows = new Map((await stack.sessions.listRowsByIds(w.ownerId, ids)).map((row) => [row.id, row as Payload]));
  const previews = await stack.previews.read(w.ownerId, ids.map((id) => ({ kind: 'session' as const, id })));
  const previewOf = (id: string) => {
    const found = previews.previews.find((p) => p.kind === 'session' && p.state === 'ok'
      && (p as unknown as { session: { id: string } }).session.id === id);
    return (found as unknown as { session: Payload } | undefined)?.session;
  };
  const shared = new Map((await stack.guests.sharedWithMe(w.guestId)).sessions.map((s) => [s.id, s as unknown as Payload]));
  const realtime = stack.realtime as unknown as {
    buildSessionSummary(id: string): Promise<Payload | null>;
    readEventData(id: string, type: ControlEventType, ev: unknown, ownerId: string): Promise<Payload | null>;
  };
  const out = new Map<string, Record<PayloadKind, Payload> & { [SEARCH_HIT]: Payload | null }>();
  for (const [label, id] of w.ids) {
    const row = await stack.db.session.findUniqueOrThrow({ where: { id }, select: { status: true, endReason: true } });
    const taskDetail = (await stack.tasks.get(w.ownerId, w.taskIds.get(label)!)) as unknown as { sessions: Payload[] };
    const need = <T>(value: T | null | undefined, kind: string): T => {
      if (value == null) throw new Error(`${label}: no ${kind} payload`);
      return value;
    };
    out.set(label, {
      listRow: need(rows.get(id), 'listRow'),
      detail: (await stack.sessions.get(w.ownerId, id)) as unknown as Payload,
      sessionSummary: need(await realtime.buildSessionSummary(id), 'sessionSummary'),
      // The event as an end publishes it: the run status and end reason it settled with.
      sessionEnded: need(await realtime.readEventData(id, ControlEventType.SESSION_ENDED, {
        type: 'session_ended', payload: { runStatus: row.status, endReason: row.endReason },
      }, w.ownerId), 'sessionEnded'),
      linkPreview: need(previewOf(id), 'linkPreview'),
      guestRow: need(shared.get(id), 'guestRow'),
      sharedHead: (await stack.sessions.sharedHead(id)) as unknown as Payload,
      // A run in the task detail's `sessions[]`.
      taskRun: need(taskDetail.sessions.find((run) => run.id === id), 'taskRun'),
      [SEARCH_HIT]: hits.get(id) ?? null,
    });
  }
  return out;
}

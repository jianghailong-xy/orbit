/**
 * `forkSnapshotsOpen` on the heartbeat (docs/task-fork-from-session-design.md §2.6, SR55), over a real PostgreSQL
 * migrated from empty, through the real RunnerApiController.heartbeat. The runner deletes every keep-alive ref
 * `refs/orbit/fork/*` whose snapshot this list leaves out, so the list must never leave out a snapshot an open task
 * still starts from — an early deletion lets git drop S and refuses the task's next run — and must not keep a
 * snapshot alive for a task that is settled, or for someone else's.
 *
 *   1. a full reconcile of a runner that declares task-fork/v1 lists the fork_sha of every OPEN and IN_PROGRESS task
 *      forked on it: one that is running, one OPEN again between runs after a send-back (IN_PROGRESS → OPEN), one
 *      reopened after DONE (DONE → OPEN), and two tasks sharing one snapshot, listed once;
 *   2. it leaves out DONE, CANCELLED and FAILED forked tasks, tasks forked on another runner of the same owner,
 *      tasks of another owner, and tasks that are not forked; with none open the list is present and empty ([]),
 *      which is the statement "delete them all", not silence;
 *   3. a runner that does not declare task-fork/v1 is given no field at all (absent: the runner deletes nothing);
 *   4. over the link: a full reconcile carries the list; a quiet beat (answered from runner_presence) carries no
 *      field, which the runner reads as "no statement" (FULL_ONLY in link-heartbeat.ts's HEARTBEAT_DELIVERIES).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/fork-snapshots-heartbeat.pg.spec.ts
 *
 * Not destructive: every row belongs to the accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CreatorType, PrismaClient, TaskStatus } from '@prisma/client';
import type { RunnerHeartbeatRequest, RunnerHeartbeatResponse } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import type { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerHints, type HintBus } from '../realtime/runner-hints';
import { RunnerPresenceService } from '../runners/runner-presence';
import { WikiRepoOps } from '../wiki-worker/wiki-repo-ops';
import { IntegrationJobRelay } from './integration-job-relay';
import { RunnerApiController } from './runner-api.controller';
import type { RunnerLinkContext } from './runner-link-call';
import { runnerLinkCredential } from './runner-link-token';

const URL_ = process.env.COORDINATOR_PG_URL;

const BASE_CAPABILITIES = ['session-orchestration-credential-v1', 'source-pin/v1', 'integration-job/v1'];
const WITH_FORK = [...BASE_CAPABILITIES, 'task-fork/v1'].join(',');
const WITHOUT_FORK = BASE_CAPABILITIES.join(',');

type Answer = RunnerHeartbeatResponse & { linkHints?: unknown };
const isFull = (answer: Answer) => 'agentDirs' in answer;
const sha = () => randomBytes(20).toString('hex');

test('forkSnapshotsOpen on the heartbeat', { skip: !URL_, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  process.env.DATABASE_URL ??= url;
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);

  const bus: HintBus = {
    up: true,
    publish: () => undefined,
    subscribe: () => () => undefined,
    request: async () => null,
    close: async () => undefined,
  };
  const hints = new RunnerHints(prisma as never, 'nats://nats.invalid:4222', () => bus, Date.now, true);
  hints.onModuleInit();
  const push = { notifyEngineSignedOut: () => undefined, notifyRunnerDrainWaiting: async () => undefined };
  const realtime = new RealtimeService(prisma as unknown as PrismaService, push as never, hints);
  await realtime.onModuleInit();
  const db = prisma as unknown as PrismaService;
  const door = new RunnerApiController(
    db, { notifySessionQueued: () => undefined } as never, realtime, push as never, {} as never, {} as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    new IntegrationJobRelay(db), undefined, undefined, undefined, undefined, new WikiRepoOps(db), undefined, undefined,
    new RunnerPresenceService(db), undefined,
  );
  t.after(async () => {
    realtime.onModuleDestroy();
    await hints.onModuleDestroy();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const owner = async () => {
    const id = randomUUID();
    await prisma.user.create({ data: { id, email: `fork-hb-${id}@fork.invalid`, name: 'owner', passwordHash: 'x' } });
    return id;
  };
  const machine = async (ownerId: string, name: string) => {
    const token = `fork-hb-${randomUUID()}`;
    const id = randomUUID();
    await prisma.runner.create({
      data: { id, ownerId, name, tokenHash: sha256(token), status: 'ONLINE', lastHeartbeatAt: new Date() },
    });
    await prisma.workspace.create({ data: { ownerId, name: `${name}-ws`, runnerId: id, workDir: `/srv/${name}`, enableWorktree: true } });
    return { id, token, ownerId };
  };

  const ownerId = await owner();
  const runner = await machine(ownerId, 'forking-machine');
  const otherRunner = await machine(ownerId, 'other-machine');
  const strangerId = await owner();

  /** A task row as the create door writes a fork (the five columns at INSERT, migration 0615), or not forked. */
  const task = async (o: {
    owner?: string; status: TaskStatus; forkRunnerId?: string | null; forkSha?: string; title: string;
  }) => {
    const id = randomUUID();
    const forkSha = o.forkSha ?? sha();
    const baseHead = sha();
    await prisma.task.create({
      data: {
        id, ownerId: o.owner ?? ownerId, title: o.title, creatorType: CreatorType.USER, creatorId: o.owner ?? ownerId,
        completionCriterion: 'EVIDENCE_JUDGMENT', status: o.status,
        ...(o.forkRunnerId === null ? {} : {
          forkSessionId: randomUUID(), forkRunnerId: o.forkRunnerId ?? runner.id, forkSha, forkBaseHead: baseHead,
          forkIncludesUncommitted: true,
        }),
      },
    });
    return { id, forkSha };
  };
  const setStatus = (id: string, status: TaskStatus) => prisma.task.update({ where: { id }, data: { status } });

  const body = (leaseOwner: string): RunnerHeartbeatRequest => ({
    status: 'ONLINE', idleCapacity: 1, version: '0.1.254', leaseOwner, supervisedSessionIds: [],
  } as unknown as RunnerHeartbeatRequest);
  /** An HTTPS heartbeat, which reconciles in full on every beat. */
  const httpsBeat = async (capabilities: string, r = runner) => {
    const row = await prisma.runner.findUniqueOrThrow({ where: { id: r.id } });
    return await door.heartbeat(row as never, body(randomUUID()), capabilities, 'claude', 'linux') as Answer;
  };
  const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();

  // ── the rows ──────────────────────────────────────────────────────────────────────────────────────
  const running = await task({ status: TaskStatus.IN_PROGRESS, title: 'running' });
  const open = await task({ status: TaskStatus.OPEN, title: 'filed, not started' });
  // A run that was sent back: IN_PROGRESS while it ran, OPEN between runs.
  const sentBack = await task({ status: TaskStatus.IN_PROGRESS, title: 'sent back' });
  await setStatus(sentBack.id, TaskStatus.OPEN);
  // A task reopened after it was DONE. (DONE is written only with its canonical fact — the trigger refuses a bare
  // UPDATE to DONE — so the row starts DONE, as a settled task's row is, and is reopened.)
  const reopened = await task({ status: TaskStatus.DONE, title: 'reopened' });
  await setStatus(reopened.id, TaskStatus.OPEN);
  // Two tasks of one batch, sharing the call's one snapshot; one of them already settled.
  const shared = sha();
  await task({ status: TaskStatus.OPEN, forkSha: shared, title: 'batch item 1' });
  await task({ status: TaskStatus.DONE, forkSha: shared, title: 'batch item 2, done' });
  const sharedOpenTwice = sha();
  await task({ status: TaskStatus.OPEN, forkSha: sharedOpenTwice, title: 'batch b item 1' });
  await task({ status: TaskStatus.IN_PROGRESS, forkSha: sharedOpenTwice, title: 'batch b item 2' });

  const done = await task({ status: TaskStatus.DONE, title: 'done' });
  const cancelled = await task({ status: TaskStatus.CANCELLED, title: 'cancelled' });
  const failed = await task({ status: TaskStatus.FAILED, title: 'failed' });
  const otherMachine = await task({ status: TaskStatus.OPEN, forkRunnerId: otherRunner.id, title: 'forked on the other machine' });
  const stranger = await task({ owner: strangerId, status: TaskStatus.OPEN, title: "another owner's" });
  await task({ status: TaskStatus.OPEN, forkRunnerId: null, title: 'not forked' });

  const expected = sorted([running.forkSha, open.forkSha, sentBack.forkSha, reopened.forkSha, shared, sharedOpenTwice]);

  await t.test('1. a full reconcile lists every OPEN and IN_PROGRESS snapshot forked on this runner, each once', async () => {
    const answer = await httpsBeat(WITH_FORK);
    assert.ok(isFull(answer), 'an HTTPS beat reconciles in full');
    assert.ok(Array.isArray(answer.forkSnapshotsOpen), `forkSnapshotsOpen = ${JSON.stringify(answer.forkSnapshotsOpen)}`);
    assert.deepEqual(sorted(answer.forkSnapshotsOpen), expected);
    assert.equal(answer.forkSnapshotsOpen!.filter((s) => s === shared).length, 1, 'a shared snapshot is listed once');
    assert.equal(answer.forkSnapshotsOpen!.filter((s) => s === sharedOpenTwice).length, 1, 'two open tasks on one snapshot: once');
  });

  await t.test('2. settled, other machines\' and other owners\' forks are left out; none open is [], not silence', async () => {
    const listed = new Set((await httpsBeat(WITH_FORK)).forkSnapshotsOpen);
    for (const [label, row] of Object.entries({ done, cancelled, failed, otherMachine, stranger })) {
      assert.equal(listed.has(row.forkSha), false, `${label}'s snapshot is listed`);
    }
    // The other machine's own list names its own fork, and nothing of this runner's.
    assert.deepEqual((await httpsBeat(WITH_FORK, otherRunner)).forkSnapshotsOpen, [otherMachine.forkSha]);
    // The forked task that closes drops out on the next full reconcile — the gc's signal.
    await setStatus(running.id, TaskStatus.CANCELLED);
    const after = await httpsBeat(WITH_FORK);
    assert.equal(after.forkSnapshotsOpen!.includes(running.forkSha), false, 'a task that closed still keeps its snapshot');
    assert.deepEqual(sorted(after.forkSnapshotsOpen), expected.filter((s) => s !== running.forkSha));
    // A runner with no open forked task is told so: present and empty.
    const fresh = await machine(ownerId, 'fresh-machine');
    const none = await httpsBeat(WITH_FORK, fresh);
    assert.deepEqual(none.forkSnapshotsOpen, []);
  });

  await t.test('3. a runner that does not declare task-fork/v1 is given no field', async () => {
    const answer = await httpsBeat(WITHOUT_FORK);
    assert.ok(isFull(answer));
    assert.equal('forkSnapshotsOpen' in answer, false, JSON.stringify(answer.forkSnapshotsOpen));
  });

  await t.test('4. over the link: the full reconcile carries the list, a quiet beat carries no field', async () => {
    const leaseOwner = randomUUID();
    const link: RunnerLinkContext = {
      leaseOwner, requestId: null, afterSeq: null, gatewayId: 'orbit-link-gateway-1',
      admission: { credential: runnerLinkCredential(sha256(runner.token)), ownerId },
    };
    const linkBeat = async () => await door.heartbeat(
      { id: runner.id, ownerId } as never, body(leaseOwner), WITH_FORK, 'claude', 'linux', undefined, link, {},
    ) as Answer;
    const first = await linkBeat();
    assert.ok(isFull(first), 'the first link beat reconciles in full');
    assert.deepEqual(sorted(first.forkSnapshotsOpen), expected.filter((s) => s !== running.forkSha));
    const quiet = await linkBeat();
    assert.equal(isFull(quiet), false, `the second beat, with nothing changed, is quiet: ${JSON.stringify(quiet)}`);
    assert.equal('forkSnapshotsOpen' in quiet, false, 'a quiet answer states nothing about the snapshots');
  });
});

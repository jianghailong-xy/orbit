/**
 * The dispatch/claim protocol's S2 cases (`docs/project-source-contract.md` §12.2), on real
 * PostgreSQL.
 *
 * Everything this unit promises is a property of statements meeting a schema: the selector is
 * frozen by the INSERT that creates the session (SR28), the pin is frozen by one compare-and-set
 * that only one of several racers can win (SR30), and neither can be rewritten afterwards. None of
 * those can be shown against a mock — a mock agrees with whatever the code does, including
 * rewriting a column a trigger would have refused.
 *
 * Destructive: it truncates. It refuses to run anywhere but the disposable server
 * `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SOURCE_PROTOCOL_UNSUPPORTED_ERROR } from '../runner-api/runner-provider-support';
import { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  decideSessionSource,
  freezeSessionSourcePin,
  sessionSourceSnapshot,
  SESSION_SOURCE_SELECT,
} from './session-source';

const URL = process.env.COORDINATOR_PG_URL;
const SHA = (c: string) => c.repeat(40);

interface World {
  ownerId: string;
  runnerId: string;
  otherRunnerId: string;
  workspaceId: string;
  projectId: string;
  codebaseId: string;
  taskId: string;
  codelessTaskId: string;
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "run_event", "conversation_turn", "project_codebase", "task", "session",
             "workspace", "runner", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const otherRunnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pcc175s2.invalid`, name: label, passwordHash: 'x' },
  });
  for (const [id, name] of [[runnerId, `${label}-a`], [otherRunnerId, `${label}-b`]] as const) {
    await db.runner.create({
      data: { id, ownerId, name, tokenHash: `x-${id}`, status: RunnerStatus.ONLINE, maxConcurrent: 4 },
    });
  }
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true, workDir: `/tmp/${label}` },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: label } });
  const codebase = await db.projectCodebase.create({
    data: {
      projectId,
      ownerId,
      canonicalRepoUrl: 'https://github.com/acme/widgets',
      upstreamRef: 'refs/heads/main',
      integrationRef: 'refs/heads/main',
      refAuthority: 'REMOTE',
    },
    select: { id: true },
  });
  const task = await db.task.create({
    data: { ownerId, projectId, title: `${label} work`, creatorType: 'USER', creatorId: ownerId },
    select: { id: true },
  });
  const codelessTask = await db.task.create({
    data: {
      ownerId, projectId, title: `${label} research`, creatorType: 'USER', creatorId: ownerId,
      codeless: true,
    },
    select: { id: true },
  });
  return {
    ownerId, runnerId, otherRunnerId, workspaceId, projectId,
    codebaseId: codebase.id, taskId: task.id, codelessTaskId: codelessTask.id,
  };
}

/** A PENDING session created the way `SessionsService.create` creates one: selector in the INSERT. */
async function createSession(
  db: PrismaClient,
  w: World,
  taskId: string | null,
): Promise<string> {
  const task = taskId
    ? await db.task.findUniqueOrThrow({
        where: { id: taskId },
        select: {
          id: true, projectId: true, verifiesTaskId: true, pinnedRevision: true,
          codeless: true, attemptGeneration: true, knownGoodSha: true,
        },
      })
    : null;
  const decision = await decideSessionSource(db as unknown as PrismaService, task);
  const session = await db.session.create({
    data: {
      title: 'dispatch',
      prompt: 'do the thing',
      status: RunStatus.PENDING,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      taskId: taskId ?? undefined,
      provider: 'claude',
      providerBuiltin: true,
      ...decision.columns,
    },
    select: { id: true },
  });
  return session.id;
}

function queueService(db: PrismaClient): QueueService {
  // The claim publishes; nothing here reads what it published, and a stub keeps the spec off the
  // realtime fan-out entirely.
  const realtime = {
    publishSessionUpdated: () => {},
    publishSessionCreated: () => {},
    notifyInbox: () => {},
  };
  return new QueueService(db as unknown as PrismaService, realtime as unknown as RealtimeService);
}

/** The refusal `fn` produced, or '' if it did not refuse. */
async function message(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  return '';
}

const suite = URL ? test : test.skip;

suite('SOURCE freeze and pin, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  const db = prismaClientFor(URL);
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  // ---------------------------------------------------------------------------------------
  // S2.01 / S2.03 — the selector is a property of the INSERT, and of nothing after it
  // ---------------------------------------------------------------------------------------

  await t.test('S2.01 the selector lands with the session row, and no second statement may write it', async () => {
    await emptyWorld(client);
    const w = await world(db, 'insert');
    const sessionId = await createSession(db, w, w.taskId);

    const row = await db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: SESSION_SOURCE_SELECT,
    });
    assert.equal(row.sourceState, 'SELECTED');
    assert.equal(row.sourceKind, 'PROJECT_UPSTREAM');
    assert.equal(row.sourceCodebaseId, w.codebaseId);
    assert.equal(row.sourceRepoUrl, 'https://github.com/acme/widgets');
    assert.equal(row.sourceRef, 'refs/heads/main');
    assert.equal(row.sourceRevisionSha, null);
    assert.equal(row.sourceRefAuthority, 'REMOTE');
    assert.equal(row.sourceConfigRevision, 0n);
    // The pin is the OTHER half and is not frozen yet: this is the difference between intent and
    // fact, and a session that had both at creation would be one whose ref never got to move
    // between being queued and being started (SR32).
    assert.equal(row.sourceBaseSha, null);

    // SR28's mechanism, stated by the database rather than by this code: there is no second
    // statement that could have written those columns, so "the session was claimable before its
    // selector existed" is not a window that exists.
    assert.match(
      await message(() =>
        db.session.update({ where: { id: sessionId }, data: { sourceRef: 'refs/heads/other' } }),
      ),
      /SOURCE_PIN_IMMUTABLE/,
    );
  });

  await t.test('S2.03 reconfiguring the binding after create does not reach the frozen selector', async () => {
    await emptyWorld(client);
    const w = await world(db, 'reconfig');
    const sessionId = await createSession(db, w, w.taskId);
    const before = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });

    // An administrator re-points the project's code line while the session sits in the queue. The
    // trigger bumps configRevision, which is exactly the fact the frozen snapshot pins down: the
    // run is about the configuration it was filed under, not the one it happens to start under.
    await db.projectCodebase.update({
      where: { id: w.codebaseId },
      data: { upstreamRef: 'refs/heads/develop', integrationRef: 'refs/heads/release/next' },
    });
    const binding = await db.projectCodebase.findUniqueOrThrow({
      where: { id: w.codebaseId }, select: { configRevision: true },
    });
    assert.ok(binding.configRevision > 0n, 'the binding did not record a configuration change');

    const after = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });
    assert.deepEqual(after, before);
    assert.equal(after.sourceRef, 'refs/heads/main');
  });

  await t.test('a codeless task and a session with no task are both Legacy, and take no Git requirement', async () => {
    await emptyWorld(client);
    const w = await world(db, 'legacy');
    for (const taskId of [w.codelessTaskId, null]) {
      const sessionId = await createSession(db, w, taskId);
      const row = await db.session.findUniqueOrThrow({
        where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
      });
      assert.equal(row.sourceState, 'UNBOUND');
      assert.equal(row.sourceKind, null);
      assert.equal(row.sourceCodebaseId, null);
      assert.equal(sessionSourceSnapshot(row), undefined);
    }
  });

  // ---------------------------------------------------------------------------------------
  // S2.06 — the compatibility refusal
  // ---------------------------------------------------------------------------------------

  await t.test('S2.06 a runner without source-pin/v1 is not offered the session, and it stays SELECTED', async () => {
    await emptyWorld(client);
    const w = await world(db, 'capability');
    const sessionId = await createSession(db, w, w.taskId);
    const queue = queueService(db);

    const refused = await queue.claimSessionForRunner({ id: w.runnerId }, 0, false, false);
    assert.equal(refused, null, 'an incapable runner was handed a session with a resolved SOURCE');
    // The marker is written by the claim preflight, exactly as the OpenCode one is: without it the
    // row sits PENDING with nothing on it to say the machine, not the queue, is the reason.
    await new RunnerApiController(
      db as unknown as PrismaService,
      queue,
      { publishSessionCreated: () => {} } as unknown as RealtimeService,
      {} as never, {} as never, {} as never, {} as never,
    ).claim({ id: w.runnerId }, 'gpu');
    const stalled = await db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { status: true, sourceState: true, sourceRefusalCode: true, error: true },
    });
    assert.equal(stalled.error, SOURCE_PROTOCOL_UNSUPPORTED_ERROR);
    // Not REFUSED: the state machine's refusal is terminal and recovery from it is a NEW session,
    // whereas this row becomes runnable the moment a newer runner appears. Withholding is the
    // whole answer (SR35).
    assert.equal(stalled.status, RunStatus.PENDING);
    assert.equal(stalled.sourceState, 'SELECTED');
    assert.equal(stalled.sourceRefusalCode, null);

    const claimed = await queue.claimSessionForRunner({ id: w.runnerId }, 0, false, true);
    assert.equal(claimed?.sessionId, sessionId);
    // The stall was disproved by the claim itself, so its explanation goes: a running session that
    // still reads "no runner supports this" describes the one machine that just took it.
    const started = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: { error: true },
    });
    assert.equal(started.error, null);
    assert.equal(claimed?.source?.state, 'SELECTED');
    assert.equal(claimed?.source?.ref, 'refs/heads/main');
    assert.equal(claimed?.source?.remoteName, 'origin');
    assert.equal(claimed?.source?.baseSha, undefined);
  });

  await t.test('a Legacy session is still claimable by a runner that never heard of SOURCE', async () => {
    await emptyWorld(client);
    const w = await world(db, 'legacyclaim');
    const sessionId = await createSession(db, w, w.codelessTaskId);
    const claimed = await queueService(db).claimSessionForRunner({ id: w.runnerId }, 0, false, false);
    assert.equal(claimed?.sessionId, sessionId);
    // Absent, not "an object saying UNBOUND": an omitted field is exactly the payload every runner
    // has always received, which is what makes the compatibility claim a structural one (SR46).
    assert.equal(claimed?.source, undefined);
  });

  // ---------------------------------------------------------------------------------------
  // S2.02 / S2.04 / S2.05 — one pin, whoever asks and however often
  // ---------------------------------------------------------------------------------------

  await t.test('S2.02 repeated dispatch, a concurrent claim and a takeover produce ONE pin', async () => {
    await emptyWorld(client);
    const w = await world(db, 'cas');
    const sessionId = await createSession(db, w, w.taskId);
    const prisma = db as unknown as PrismaService;
    const actor = { sessionId, runnerId: w.runnerId, ownerId: w.ownerId };

    // Two claims resolving the same ref a moment apart, so their answers differ. Exactly one may
    // freeze, and the other must adopt it rather than overwrite — a worktree may already stand on
    // the winner's commit.
    const [first, second] = await Promise.all([
      freezeSessionSourcePin(prisma, actor, { baseSha: SHA('1') }),
      freezeSessionSourcePin(prisma, actor, { baseSha: SHA('2') }),
    ]);
    assert.equal([first, second].filter((r) => r.wonRace).length, 1, 'two writers both won the CAS');
    assert.equal(first.baseSha, second.baseSha);
    assert.equal(first.state, 'PINNED');
    assert.equal(second.state, 'PINNED');
    const winner = first.baseSha!;
    assert.ok([SHA('1'), SHA('2')].includes(winner));

    // A repeated dispatch: the same runner sends its answer again because the first response was
    // lost. It gets the frozen one back, not a second freeze.
    const again = await freezeSessionSourcePin(prisma, actor, { baseSha: SHA('1') });
    assert.equal(again.wonRace, false);
    assert.equal(again.baseSha, winner);

    // A takeover: the session moves to another machine, which resolves it independently. Same
    // answer — the pin belongs to the session, not to whoever is holding it (SR30 / §6.4).
    await db.session.update({ where: { id: sessionId }, data: { assignedRunnerId: w.otherRunnerId } });
    const takeover = await freezeSessionSourcePin(
      prisma,
      { sessionId, runnerId: w.otherRunnerId, ownerId: w.ownerId },
      { baseSha: SHA('3') },
    );
    assert.equal(takeover.wonRace, false);
    assert.equal(takeover.baseSha, winner);

    const row = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });
    assert.equal(row.sourceBaseSha, winner);
    assert.equal(row.sourceResolvedByRunnerId, w.runnerId);
    assert.ok(row.sourceResolvedAt instanceof Date);
  });

  await t.test('S2.04/S2.05 the pin is whatever the ref was at start, and every later read reuses it', async () => {
    await emptyWorld(client);
    const w = await world(db, 'freeze');
    const sessionId = await createSession(db, w, w.taskId);
    const prisma = db as unknown as PrismaService;
    const actor = { sessionId, runnerId: w.runnerId, ownerId: w.ownerId };

    // S2.04: the SHA was NOT decided when the session was created — the selector named a ref and
    // the commit arrives later, from the machine that could actually resolve it. So a ref that
    // advanced while the session queued is seen by this run, which is the point of the two moments
    // being separate (SR32).
    const startedFrom = SHA('a');
    const pinned = await freezeSessionSourcePin(prisma, actor, { baseSha: startedFrom });
    assert.equal(pinned.wonRace, true);
    assert.equal(pinned.baseSha, startedFrom);

    // The ref moves on, the binding is reconfigured, its configRevision advances. None of it may
    // reach a run that has already started (SR29).
    await db.projectCodebase.update({
      where: { id: w.codebaseId },
      data: { upstreamRef: 'refs/heads/develop', remoteName: 'upstream' },
    });

    // S2.05: the claim path (a resume) and the reclaim path (a runner restart) both READ.
    const resumed = await queueService(db).claimSessionForRunner({ id: w.runnerId }, 0, false, true);
    assert.equal(resumed?.sessionId, sessionId);
    assert.equal(resumed?.source?.state, 'PINNED');
    assert.equal(resumed?.source?.baseSha, startedFrom);
    assert.equal(resumed?.source?.ref, 'refs/heads/main', 'the frozen selector followed the binding');
    // `remoteName` is how to ASK and is deliberately not frozen (§3.2), so it does follow.
    assert.equal(resumed?.source?.remoteName, 'upstream');

    const row = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });
    const binding = await db.projectCodebase.findUniqueOrThrow({
      where: { id: w.codebaseId }, select: { remoteName: true, authorityRunnerId: true },
    });
    const reclaimed = sessionSourceSnapshot(row, binding);
    assert.equal(reclaimed?.state, 'PINNED');
    assert.equal(reclaimed?.baseSha, startedFrom);

    // And there is no door back: an unreachable commit is a reason to fail this run, never to
    // silently change what the run is about (SR12).
    assert.match(
      await message(() =>
        db.session.update({ where: { id: sessionId }, data: { sourceBaseSha: SHA('b') } }),
      ),
      /SOURCE_PIN_IMMUTABLE/,
    );
  });

  await t.test('a refusal is terminal, and carries the one action that fixes it', async () => {
    await emptyWorld(client);
    const w = await world(db, 'refusal');
    const sessionId = await createSession(db, w, w.taskId);
    const prisma = db as unknown as PrismaService;
    const actor = { sessionId, runnerId: w.runnerId, ownerId: w.ownerId };

    const refused = await freezeSessionSourcePin(prisma, actor, {
      refusal: { code: 'BASE_REF_NOT_FOUND', detail: { ref: 'refs/heads/main' } },
    });
    assert.equal(refused.state, 'REFUSED');
    assert.equal(refused.wonRace, true);
    assert.equal(refused.refusalCode, 'BASE_REF_NOT_FOUND');
    const row = await db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { sourceRefusalDetail: true, sourceBaseSha: true },
    });
    // SR49: the code and its executable next step travel together, so no client has to keep its
    // own copy of §10.1's pairing.
    assert.deepEqual(row.sourceRefusalDetail, { ref: 'refs/heads/main', fixAction: 'FIX_REF' });
    assert.equal(row.sourceBaseSha, null);

    // T8: recovery is a new session frozen against the configuration as it is then, never a second
    // resolution of this one — that is what keeps "the selector is frozen at create" exceptionless.
    const late = await freezeSessionSourcePin(prisma, actor, { baseSha: SHA('c') });
    assert.equal(late.wonRace, false);
    assert.equal(late.state, 'REFUSED');
    assert.equal(late.baseSha, undefined);
  });

  await t.test('the pin route refuses what would make the row say two things at once', async () => {
    await emptyWorld(client);
    const w = await world(db, 'guards');
    const prisma = db as unknown as PrismaService;
    const pinned = await createSession(db, w, w.taskId);
    const legacy = await createSession(db, w, w.codelessTaskId);
    const actor = { sessionId: pinned, runnerId: w.runnerId, ownerId: w.ownerId };

    assert.match(await message(() => freezeSessionSourcePin(prisma, actor, {})), /exactly one/);
    assert.match(
      await message(() => freezeSessionSourcePin(prisma, actor, { baseSha: 'a1b2c3d' })),
      /full 40-character lowercase commit SHA/,
    );
    // The one dispatch-path code, refused before it can reach the CHECK that would also refuse it:
    // a session both recording "no runner supports this" and still queued for one that does would
    // be the state machine holding two answers.
    assert.match(
      await message(() =>
        freezeSessionSourcePin(prisma, actor, {
          refusal: { code: 'SOURCE_PROTOCOL_UNSUPPORTED' as never },
        }),
      ),
      /decided at dispatch/,
    );
    // A Legacy session has no SOURCE to pin; letting one be pinned would be letting the runner
    // invent a baseline for a session that never resolved one.
    assert.match(
      await message(() =>
        freezeSessionSourcePin(
          prisma,
          { sessionId: legacy, runnerId: w.runnerId, ownerId: w.ownerId },
          { baseSha: SHA('d') },
        ),
      ),
      /resolves no SOURCE/,
    );
    // And a machine that does not hold the session cannot freeze its baseline.
    assert.match(
      await message(() =>
        freezeSessionSourcePin(
          prisma,
          { sessionId: pinned, runnerId: w.otherRunnerId, ownerId: w.ownerId },
          { baseSha: SHA('d') },
        ),
      ),
      /does not belong to this runner/,
    );
  });
});

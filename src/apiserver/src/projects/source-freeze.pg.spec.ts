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
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

/**
 * The deploy-time repair for the shells the old refusal path left, byte for byte the file
 * `prisma migrate deploy` applies. Read rather than re-typed: the assertions below are about what
 * that migration does, and a copy of its SQL in this file would be a second thing to keep in step.
 */
const REPAIR_SQL = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0394_close_refused_running_shells/migration.sql'),
  'utf8',
);

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
    data: {
      ownerId, projectId, title: `${label} work`, creatorType: 'USER', creatorId: ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    },
    select: { id: true },
  });
  const codelessTask = await db.task.create({
    data: {
      ownerId, projectId, title: `${label} research`, creatorType: 'USER', creatorId: ownerId,
      codeless: true, completionCriterion: 'EVIDENCE_JUDGMENT',
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
    ).claim({ id: w.runnerId, ownerId: w.ownerId }, 'gpu');
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

  await t.test('a refused run is closed, not left RUNNING with its claim held', async () => {
    await emptyWorld(client);
    const w = await world(db, 'running-refusal');
    const sessionId = await createSession(db, w, w.taskId);
    const prisma = db as unknown as PrismaService;
    const actor = { sessionId, runnerId: w.runnerId, ownerId: w.ownerId };

    // The incident's shape, which is the ordinary one: the runner claimed the run before it could
    // resolve the ref, so the row it refuses is RUNNING and holds the claim its owner handed it.
    const leaseOwner = randomUUID();
    const generation = randomUUID();
    await db.session.update({
      where: { id: sessionId },
      data: {
        status: RunStatus.RUNNING,
        runClaimedAt: new Date(),
        inboxLeaseOwner: leaseOwner,
        inboxLeaseGeneration: generation,
        numTurns: 0,
      },
    });
    await db.inboxLeaseGeneration.create({
      data: { generation, sessionId, leaseOwner },
    });
    const stderr = "fatal: couldn't find remote ref refs/heads/project/34bZ3i4AvgJaaoaw5E9tH";
    const before = new Date();

    const refused = await freezeSessionSourcePin(prisma, actor, {
      refusal: {
        code: 'BASE_REF_NOT_FOUND',
        detail: { ref: 'refs/heads/project/34bZ3i4AvgJaaoaw5E9tH', stderr, remoteName: 'origin' },
      },
    });
    assert.equal(refused.wonRace, true);
    assert.equal(refused.state, 'REFUSED');
    const after = new Date();

    // The run is OVER: not RUNNING, and carrying the same `<code>: <reason>` sentence a checkout
    // refusal leaves in `error` — the runner's own words, not a second spelling of the code.
    const row = await db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        status: true, error: true, finishedAt: true, runClaimedAt: true, inboxLeaseOwner: true,
        inboxLeaseGeneration: true, numTurns: true, sourceState: true,
      },
    });
    assert.equal(row.status, RunStatus.FAILED, 'a refused run was left running');
    assert.equal(row.error, `BASE_REF_NOT_FOUND: ${stderr}`);
    assert.ok(row.finishedAt instanceof Date && row.finishedAt >= before && row.finishedAt <= after);
    assert.equal(row.numTurns, 0, 'the refused run reported turns');
    assert.equal(row.sourceState, 'REFUSED');

    // And the execution authority is released: the claim's clocks and owner are gone, and the
    // inbox generation the runner held is retired — the tombstone a revive has to find.
    assert.equal(row.runClaimedAt, null, 'the refused run still holds its claim clock');
    assert.equal(row.inboxLeaseOwner, null, 'the refused run still holds an inbox owner');
    const retired = await db.inboxLeaseGeneration.findUniqueOrThrow({
      where: { generation },
      select: { retiredAt: true },
    });
    assert.ok(retired.retiredAt instanceof Date, 'the refused run left its lease generation open');

    // A refusal that LOSES the compare-and-set closes nothing: the row is the winner's, and a
    // runner re-issuing a request whose response it never saw must not rewrite it either way.
    const late = await freezeSessionSourcePin(prisma, actor, {
      refusal: { code: 'BASE_REF_NOT_FOUND', detail: { ref: 'refs/heads/project/x', stderr: 'other' } },
    });
    assert.equal(late.wonRace, false);
    const untouched = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: { error: true, finishedAt: true },
    });
    assert.equal(untouched.error, row.error);
    assert.deepEqual(untouched.finishedAt, row.finishedAt);
  });

  await t.test('the shells an earlier refusal left RUNNING are closed by the deploy backfill, once', async () => {
    await emptyWorld(client);
    const w = await world(db, 'shell-backfill');

    // The shell the old code left: the refusal frozen onto the session and nothing else — still
    // RUNNING, `num_turns` 0, and the claim its owner handed it. The door cannot produce this any
    // more (the refusal now closes the run in the same transaction), which is exactly why the
    // historical half is a migration and why this state has to be stated rather than driven.
    const shell = await createSession(db, w, w.taskId);
    // The ref the run was told to start from — the selector frozen at create, which is what the
    // refusal's own detail names and what the item's key is built from (the live path reads it off
    // the SELECTED row too, rather than off anything the runner said).
    const ref = (await db.session.findUniqueOrThrow({
      where: { id: shell }, select: { sourceRef: true },
    })).sourceRef!;
    const stderr = `fatal: couldn't find remote ref ${ref}`;
    const refusalDetail = { ref, stderr, remoteName: 'origin', fixAction: 'FIX_REF' };
    const shellLeaseOwner = randomUUID();
    const shellGeneration = randomUUID();
    await db.session.update({
      where: { id: shell },
      data: {
        sourceState: 'REFUSED',
        sourceRefusalCode: 'BASE_REF_NOT_FOUND',
        sourceRefusalDetail: refusalDetail,
        status: RunStatus.RUNNING,
        runClaimedAt: new Date(),
        inboxLeaseOwner: shellLeaseOwner,
        inboxLeaseGeneration: shellGeneration,
      },
    });
    await db.inboxLeaseGeneration.create({
      data: { generation: shellGeneration, sessionId: shell, leaseOwner: shellLeaseOwner },
    });

    // And one whose task is in no project: no project for an item to hang on, so this one must be
    // closed like the other and file nothing. Inserted whole rather than driven — a session in no
    // project resolves no SOURCE, so its selector and its refusal are stated together with the row
    // (0231's freeze guard refuses a second statement that writes the selector at all).
    const orphanTask = await db.task.create({
      data: {
        ownerId: w.ownerId, title: 'a task in no project', creatorType: 'USER', creatorId: w.ownerId,
        completionCriterion: 'EVIDENCE_JUDGMENT',
      },
      select: { id: true },
    });
    const orphanShell = randomUUID();
    await db.session.create({
      data: {
        id: orphanShell, ownerId: w.ownerId, creatorId: w.ownerId, taskId: orphanTask.id,
        workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
        title: 'refused without a project', prompt: 'do the thing', provider: 'claude',
        providerBuiltin: true, status: RunStatus.RUNNING,
        sourceState: 'REFUSED', sourceKind: 'PROJECT_UPSTREAM',
        sourceCodebaseId: w.codebaseId, sourceRepoUrl: 'https://github.com/acme/widgets',
        sourceRef: ref, sourceRefAuthority: 'REMOTE', sourceConfigRevision: 0n,
        sourceRequiredContains: [],
        sourceRefusalCode: 'SOURCE_AUTHORITY_UNREACHABLE',
        sourceRefusalDetail: { ref, stderr, fixAction: 'RETRY_OR_FIX_CREDENTIALS' },
        runClaimedAt: new Date(), inboxLeaseOwner: randomUUID(),
      },
    });

    await client.query(REPAIR_SQL);

    // The run is over, in the same columns the live path writes, with the runner's own words.
    const closed = await db.session.findUniqueOrThrow({
      where: { id: shell },
      select: {
        status: true, error: true, finishedAt: true, runClaimedAt: true, inboxLeaseOwner: true,
        sourceState: true, updatedAt: true,
      },
    });
    assert.equal(closed.status, RunStatus.FAILED);
    assert.equal(closed.error, `BASE_REF_NOT_FOUND: ${stderr}`);
    assert.ok(closed.finishedAt instanceof Date, 'the closed shell has no finished_at');
    assert.equal(closed.runClaimedAt, null, 'the closed shell still holds its claim clock');
    assert.equal(closed.inboxLeaseOwner, null, 'the closed shell still holds an inbox owner');
    assert.equal(closed.sourceState, 'REFUSED', 'the repair moved the SOURCE state');
    const tombstone = await db.inboxLeaseGeneration.findUniqueOrThrow({
      where: { generation: shellGeneration }, select: { retiredAt: true },
    });
    assert.ok(tombstone.retiredAt instanceof Date, 'the closed shell left its lease generation open');
    const closedOrphan = await db.session.findUniqueOrThrow({
      where: { id: orphanShell }, select: { status: true, error: true, runClaimedAt: true },
    });
    assert.equal(closedOrphan.status, RunStatus.FAILED);
    assert.equal(closedOrphan.error, `SOURCE_AUTHORITY_UNREACHABLE: ${stderr}`);
    assert.equal(closedOrphan.runClaimedAt, null);

    // The project is told, once, under the key the live path builds: the ref and the code, which is
    // what a person has to change. The project-less shell contributes nothing.
    const blockers = await db.projectBlocker.findMany({
      where: { projectId: w.projectId },
      select: {
        id: true, kind: true, owner: true, recovery: true, subjectType: true, subjectId: true,
        detail: true, dedupeKey: true, requiredAction: true, lifecycleGeneration: true,
        firstSeenAt: true, lastSeenAt: true,
      },
    });
    assert.equal(blockers.length, 1, 'the backfill raised no item, or more than one');
    const [item] = blockers;
    assert.equal(item.kind, 'SOURCE_UNRESOLVED');
    assert.equal(item.owner, 'USER');
    assert.equal(item.recovery, 'HUMAN');
    assert.equal(item.subjectType, 'PROJECT');
    assert.equal(item.subjectId, w.projectId);
    assert.equal(item.dedupeKey, `SOURCE_UNRESOLVED:BASE_REF_NOT_FOUND:${ref}`);
    assert.deepEqual(item.detail, {
      code: 'BASE_REF_NOT_FOUND', fixAction: 'FIX_REF', ref, taskIds: [w.taskId],
    });
    assert.ok(item.requiredAction.includes('BASE_REF_NOT_FOUND'));
    assert.equal(await db.projectBlocker.count(), 1, 'a project-less shell filed an item somewhere');

    // Idempotent: the same file again is a no-op, which is what makes it safe to re-apply.
    await client.query(REPAIR_SQL);
    const again = await db.projectBlocker.findMany({
      where: { projectId: w.projectId }, select: { id: true, firstSeenAt: true, lifecycleGeneration: true },
    });
    assert.deepEqual(again, [{ id: item.id, firstSeenAt: item.firstSeenAt, lifecycleGeneration: item.lifecycleGeneration }]);
    assert.equal(await db.projectBlocker.count(), 1);
    const untouched = await db.session.findUniqueOrThrow({
      where: { id: shell }, select: { updatedAt: true, finishedAt: true },
    });
    assert.deepEqual(untouched.updatedAt, closed.updatedAt, 'a second repair rewrote the closed shell');
    assert.deepEqual(untouched.finishedAt, closed.finishedAt);
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

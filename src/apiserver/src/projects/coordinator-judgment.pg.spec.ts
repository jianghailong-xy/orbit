import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorJudgmentService, JUDGMENT_NO_LANDING } from './coordinator-judgment.service';
import { buildJudgmentOpening, judgmentSessionTitle } from './coordinator-judgment-opening';
import { WakeFact, attemptEndedUnsettledFact, projectTasksSettledFact } from './coordinator-wake';
import { CoordinatorWakeService, WakeAuthorizer } from './coordinator-wake.service';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

/**
 * Unit T3 against a real PostgreSQL, because every claim it makes is the DATABASE's.
 *
 * "One wake opens exactly one session" is a partial unique index and a compare-and-set; "the next
 * wake opens a NEW one" is the absence of any reuse path; "`session_list` tells the two apart" is a
 * column. None of the three has a fake-client version that would mean anything — a hand-rolled
 * double agrees with whatever the code does, which is the drift a unique index exists to prevent.
 *
 *   docker run -d --name pcct3judge-pg -e POSTGRES_PASSWORD=pcct3 -e POSTGRES_USER=pcct3_admin \
 *     -e POSTGRES_DB=pcct3_judge -p 127.0.0.1:55801:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://pcct3_admin:pcct3@127.0.0.1:55801/pcct3_judge \
 *     npx prisma migrate deploy
 *   COORDINATOR_PG_URL=postgresql://pcct3_admin:pcct3@127.0.0.1:55801/pcct3_judge \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcct3_judge COORDINATOR_PG_EXPECTED_USER=pcct3_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(psql -tAc \
 *     'SELECT system_identifier FROM pg_control_system()') \
 *   node --test build/projects/coordinator-judgment.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Always yes. Authorizing a wake is unit T6's; this one only has to not refuse. */
const ALLOW: WakeAuthorizer = () => ({ allowed: true });

interface Stack {
  db: PrismaClient;
  judgments: CoordinatorJudgmentService;
  sessions: SessionsService;
  projects: ProjectsService;
}

/**
 * A whole service stack over its OWN pool. Two of these is how a race is driven here — nothing
 * about who wins may live in a process, and two callers sharing one pool would serialize.
 */
function connect(): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  return {
    db,
    sessions,
    judgments: new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma), sessions),
  };
}

interface Fixture {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
}

/**
 * A project whose coordinator has a workspace of record — the state `coordinatorWorkspaceId` is in
 * once a person has opened its coordinator once, which is the precondition a judgment inherits
 * rather than decides for itself.
 */
async function fixture(db: PrismaClient, label: string, landed = true): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@judge.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} 项目`, coordinatorEnabled: true,
      ...(landed ? { coordinatorWorkspaceId: workspaceId } : {}),
    },
  });
  await db.task.create({
    data: {
      id: taskId, ownerId, projectId, assigneeId: workspaceId, title: `${label} 的一个任务`,
      creatorType: CreatorType.USER, creatorId: ownerId, status: TaskStatus.IN_PROGRESS,
    },
  });
  return { ownerId, workspaceId, projectId, taskId };
}

/** A wake fact for an attempt that ended without settling its task — the everyday one. */
function endedFact(target: Fixture, attemptSessionId: string): WakeFact {
  return attemptEndedUnsettledFact({
    projectId: target.projectId,
    taskId: target.taskId,
    taskStatus: 'IN_PROGRESS',
    sessionId: attemptSessionId,
  })!;
}

/** Every judgment session this project has, and only the live ones. */
async function judgmentSessions(db: PrismaClient, target: Fixture) {
  return db.session.findMany({
    where: {
      ownerId: target.ownerId,
      deletedAt: null,
      dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
    },
    select: { id: true, title: true, prompt: true, runSource: true, taskId: true },
    orderBy: { createdAt: 'asc' },
  });
}

async function wakeRows(db: PrismaClient, target: Fixture) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId: target.projectId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, sessionId: true, refusalCode: true, idempotencyKey: true },
  });
}

/**
 * Acceptance criterion 1, first half: one wake, exactly one session — however many times the same
 * committed fact is delivered.
 *
 * Sequential here and concurrent below, because they fail differently: a read-then-write survives
 * this one whenever the first delivery finished before the second began, and only the race shows
 * it for what it is.
 */
test('one wake opens exactly one judgment session, and five deliveries of the fact do not add a second',
  { skip, timeout: 180_000 }, async () => {
    const stack = connect();
    try {
      const target = await fixture(stack.db, 'once');
      const attempt = randomUUID();

      const outcomes = [];
      for (let delivery = 0; delivery < 5; delivery += 1) {
        // Re-derived every time, as a producer re-reading committed rows would. The fact object is
        // not carried between deliveries — the KEY is what makes them one fact.
        outcomes.push(await stack.judgments.wake(endedFact(target, attempt), ALLOW));
      }

      assert.equal(outcomes[0].outcome, 'OPENED');
      for (const later of outcomes.slice(1)) {
        assert.equal(later.outcome, 'ALREADY_AWAKE',
          'SESSION_OPENED is inside 0174’s partial index, so the fact still holds its key');
      }

      const sessions = await judgmentSessions(stack.db, target);
      assert.equal(sessions.length, 1, 'five deliveries of one fact must leave one session');
      assert.equal(sessions[0].runSource, SessionRunSource.PROJECT_COORDINATOR);
      // A judgment is not an execution: it takes no task claim and occupies no project slot.
      assert.equal(sessions[0].taskId, null);
      assert.match(sessions[0].title, /^判断：/);
      assert.match(sessions[0].prompt!, /发生了什么：/);

      const wakes = await wakeRows(stack.db, target);
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0].status, 'SESSION_OPENED');
      assert.equal(wakes[0].sessionId, sessions[0].id, 'the ledger names the session it opened');
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * Acceptance criterion 1, second half: the same fact delivered CONCURRENTLY still opens one.
 *
 * Four stacks, four pools, one fact. What decides the winner is 0174's partial unique index on
 * `idempotency_key` — three of the four INSERTs lose it and never reach the session-opening step at
 * all. Nothing here reads "is one already running" and then acts on the answer, which is the read
 * that is never safe: under this exact interleaving all four would read "none".
 */
test('four concurrent deliveries of one fact open one session, decided by the index and not by a read',
  { skip, timeout: 180_000 }, async () => {
    const stacks = [connect(), connect(), connect(), connect()];
    try {
      const target = await fixture(stacks[0].db, 'race');
      const attempt = randomUUID();

      const outcomes = await Promise.all(
        stacks.map((stack) => stack.judgments.wake(endedFact(target, attempt), ALLOW)),
      );

      const opened = outcomes.filter((o) => o.outcome === 'OPENED');
      assert.equal(opened.length, 1, `exactly one delivery may open: ${JSON.stringify(outcomes)}`);
      // Everything else lost the INSERT. `ALREADY_OPEN` would mean two callers held one wake, which
      // the composed entry point makes unreachable; either is a loss, neither may open a session.
      for (const other of outcomes.filter((o) => o.outcome !== 'OPENED')) {
        assert.ok(['ALREADY_AWAKE', 'ALREADY_OPEN'].includes(other.outcome), other.outcome);
      }

      const sessions = await judgmentSessions(stacks[0].db, target);
      assert.equal(sessions.length, 1, 'a race must not leave two live judgment sessions');
      const wakes = await wakeRows(stacks[0].db, target);
      assert.equal(wakes.length, 1, 'and must not leave two wake rows either');
      assert.equal(wakes[0].sessionId, sessions[0].id);
    } finally {
      await Promise.all(stacks.map((s) => s.db.$disconnect()));
    }
  });

test('a persistent-coordinator delivery replays the pre-planned Session id',
  { skip, timeout: 180_000 }, async () => {
    const stack = connect();
    try {
      const target = await fixture(stack.db, 'planned');
      const fact = endedFact(target, randomUUID());
      const plannedSessionId = randomUUID();

      const first = await stack.judgments.wakePlanned(fact, ALLOW, plannedSessionId);
      const replay = await stack.judgments.wakePlanned(fact, ALLOW, plannedSessionId);

      assert.equal(first.outcome, 'OPENED');
      assert.equal(replay.outcome, 'OPENED');
      if (first.outcome !== 'OPENED' || replay.outcome !== 'OPENED') return;
      assert.equal(first.sessionId, plannedSessionId);
      assert.equal(replay.sessionId, plannedSessionId);
      assert.equal(replay.replayed, true);
      assert.equal((await judgmentSessions(stack.db, target)).length, 1);
      assert.equal((await wakeRows(stack.db, target)).length, 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a successor binds the exact Session left between insert and wake CAS',
  { skip, timeout: 180_000 }, async () => {
    const stack = connect();
    try {
      const target = await fixture(stack.db, 'crash-window');
      const fact = endedFact(target, randomUUID());
      const plannedSessionId = randomUUID();
      const claim = await new CoordinatorWakeService(
        stack.db as unknown as PrismaService,
      ).claim(fact, ALLOW);
      assert.equal(claim.outcome, 'WOKEN');

      const project = await stack.db.project.findUniqueOrThrow({ where: { id: target.projectId } });
      await stack.sessions.create(target.ownerId, {
        workspaceId: target.workspaceId,
        title: judgmentSessionTitle(project.title),
        prompt: buildJudgmentOpening(fact, project.title),
      }, {
        id: plannedSessionId,
        dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
        runSource: SessionRunSource.PROJECT_COORDINATOR,
      });
      const before = await wakeRows(stack.db, target);
      assert.equal(before[0].status, 'CLAIMED');
      assert.equal(before[0].sessionId, null);

      const recovered = await stack.judgments.wakePlanned(fact, ALLOW, plannedSessionId);
      assert.equal(recovered.outcome, 'OPENED');
      if (recovered.outcome !== 'OPENED') return;
      assert.equal(recovered.sessionId, plannedSessionId);
      assert.equal(recovered.replayed, true);
      const after = await wakeRows(stack.db, target);
      assert.equal(after[0].status, 'SESSION_OPENED');
      assert.equal(after[0].sessionId, plannedSessionId);
      assert.equal((await judgmentSessions(stack.db, target)).length, 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * The other direction of "at most one", which the key's index does not imply: two DIFFERENT wakes
 * may not name one session. Asserted against the constraint itself, because no code path today
 * would try it — and the index is there so that none ever can.
 */
test('two wakes cannot name one session', { skip, timeout: 120_000 }, async () => {
  const stack = connect();
  try {
    const target = await fixture(stack.db, 'onesession');
    const first = await stack.judgments.wake(endedFact(target, randomUUID()), ALLOW);
    assert.equal(first.outcome, 'OPENED');
    const sessionId = first.outcome === 'OPENED' ? first.sessionId : '';

    const second = await stack.judgments.wake(endedFact(target, randomUUID()), ALLOW);
    assert.equal(second.outcome, 'OPENED');
    const secondWakeId = second.outcome === 'OPENED' ? second.wakeId : '';

    await assert.rejects(
      stack.db.projectCoordinatorWake.update({
        where: { id: secondWakeId },
        data: { sessionId },
      }),
      /Unique constraint|project_coordinator_wake_session_id_key/,
    );
  } finally {
    await stack.db.$disconnect();
  }
});

/**
 * Acceptance criterion 2: a judgment session is never reused. The next wake opens a NEW one, and
 * the previous one having ENDED changes nothing — there is no reuse branch to reach.
 *
 * This is the property the whole unit exists for. The version that was removed kept one
 * conversation and steered it; here the state is in the database, so a second fact is a second
 * session that reads that state fresh.
 */
test('a second wake opens a second session — an ended judgment is never resumed',
  { skip, timeout: 180_000 }, async () => {
    const stack = connect();
    try {
      const target = await fixture(stack.db, 'fresh');

      const first = await stack.judgments.wake(endedFact(target, randomUUID()), ALLOW);
      assert.equal(first.outcome, 'OPENED');
      const firstId = first.outcome === 'OPENED' ? first.sessionId : '';

      // The judgment does its work and ends, which is the ordinary end of one.
      await stack.sessions.end(target.ownerId, firstId);
      const ended = await stack.db.session.findUniqueOrThrow({
        where: { id: firstId }, select: { finishedAt: true, status: true },
      });
      assert.ok(ended.finishedAt, 'the first judgment really has finished');

      // A different fact about the same project: the project's tasks all settled.
      await stack.db.task.update({
        where: { id: target.taskId }, data: { status: TaskStatus.DONE },
      });
      const settled = projectTasksSettledFact(target.projectId, [
        { taskId: target.taskId, status: 'DONE' },
      ])!;
      const second = await stack.judgments.wake(settled, ALLOW);
      assert.equal(second.outcome, 'OPENED');
      const secondId = second.outcome === 'OPENED' ? second.sessionId : '';

      assert.notEqual(secondId, firstId, 'the second wake must not resume the first session');
      const sessions = await judgmentSessions(stack.db, target);
      assert.equal(sessions.length, 2);
      // And the second one opens on ITS fact, not on the one that opened the first.
      assert.match(sessions[1].prompt!, /都到了终态/);
      assert.doesNotMatch(sessions[1].prompt!, /不是终态/);
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * Acceptance criterion 3: `session_list` — `SessionsService.listForOrchestration`, the method the
 * `session_list` tool calls — tells a judgment from the conversation a person opened.
 *
 * Both are opened here through the doors that really open them: `ProjectsService.coordinator` for
 * the person, `CoordinatorJudgmentService.wake` for the fact. They end up in the same workspace
 * under the same owner, which is exactly why the field is needed.
 */
test('session_list tells a judgment session from the coordinator conversation a person opened',
  { skip, timeout: 180_000 }, async () => {
    const stack = connect();
    try {
      const target = await fixture(stack.db, 'listing');

      const pressed = await stack.projects.coordinator(target.ownerId, target.projectId);
      assert.equal(pressed.created, true);
      const judged = await stack.judgments.wake(endedFact(target, randomUUID()), ALLOW);
      assert.equal(judged.outcome, 'OPENED');
      const judgedId = judged.outcome === 'OPENED' ? judged.sessionId : '';

      const listed = await stack.sessions.listForOrchestration(target.ownerId, {});
      const byId = new Map(listed.map((s) => [s.id, s]));

      assert.equal(byId.get(pressed.sessionId)?.dispatchOrigin, SessionDispatchOrigin.USER);
      assert.equal(
        byId.get(judgedId)?.dispatchOrigin,
        SessionDispatchOrigin.PROJECT_COORDINATOR,
        'a judgment must be distinguishable in the list without a second query',
      );
      // Same owner, same workspace: the two facts above are the ONLY thing separating them.
      assert.equal(byId.get(pressed.sessionId)?.workspaceId, byId.get(judgedId)?.workspaceId);
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * Acceptance criterion 4: the person's door behaves exactly as 60dece5e left it, with judgments
 * opening beside it.
 *
 * The second press returning `created: false` and the SAME session is the property that endpoint
 * was restored for. A judgment must not become that session, must not repoint the project at
 * itself, and must not make the second press open a third conversation.
 */
test('the coordinator a person opens still resolves to the same conversation on a second press',
  { skip, timeout: 180_000 }, async () => {
    const stack = connect();
    try {
      const target = await fixture(stack.db, 'unchanged');

      const first = await stack.projects.coordinator(target.ownerId, target.projectId);
      assert.equal(first.created, true);

      // A judgment happens in between, which is the whole point of the two coexisting.
      const judged = await stack.judgments.wake(endedFact(target, randomUUID()), ALLOW);
      assert.equal(judged.outcome, 'OPENED');
      const judgedId = judged.outcome === 'OPENED' ? judged.sessionId : '';

      const second = await stack.projects.coordinator(target.ownerId, target.projectId);
      assert.equal(second.created, false);
      assert.equal(second.sessionId, first.sessionId);
      assert.notEqual(second.sessionId, judgedId);

      // The project still points at the person's conversation, and its generation never moved:
      // a judgment is not a rotation.
      const project = await stack.db.project.findUniqueOrThrow({
        where: { id: target.projectId },
        select: {
          coordinatorSessionId: true,
          coordinatorWorkspaceId: true,
          runtime: { select: { coordinatorGeneration: true } },
        },
      });
      assert.equal(project.coordinatorSessionId, first.sessionId);
      assert.equal(project.coordinatorWorkspaceId, target.workspaceId);
      assert.equal(project.runtime?.coordinatorGeneration ?? 0n, 0n);
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * A wake that cannot open gives the key back — the half `project_action` got wrong, at this layer.
 *
 * A project nobody has opened a coordinator for has no workspace of record, and a judgment does not
 * pick one (that branch of `coordinatorLanding` belongs to the person pressing the button). The
 * fact must survive that: once the landing exists, the SAME fact wakes.
 */
test('a wake with nowhere to open releases its key, and the same fact wakes once there is a landing',
  { skip, timeout: 180_000 }, async () => {
    const stack = connect();
    try {
      const target = await fixture(stack.db, 'nolanding', false);
      const attempt = randomUUID();

      const refused = await stack.judgments.wake(endedFact(target, attempt), ALLOW);
      assert.equal(refused.outcome, 'REFUSED');
      assert.equal(refused.outcome === 'REFUSED' ? refused.refusalCode : '', JUDGMENT_NO_LANDING);
      assert.equal((await judgmentSessions(stack.db, target)).length, 0);

      // The refusal is on the record — "it silently did nothing" is not a state this ledger has.
      const afterRefusal = await wakeRows(stack.db, target);
      assert.equal(afterRefusal.length, 1);
      assert.equal(afterRefusal[0].status, 'REFUSED');
      assert.equal(afterRefusal[0].refusalCode, JUDGMENT_NO_LANDING);
      assert.equal(afterRefusal[0].sessionId, null);

      // Somebody opens the coordinator, which is what gives the project a workspace of record.
      await stack.projects.coordinator(target.ownerId, target.projectId, target.workspaceId);

      const retried = await stack.judgments.wake(endedFact(target, attempt), ALLOW);
      assert.equal(retried.outcome, 'OPENED',
        'a refusal must not spend the key — the same fact has to be able to wake again');
      assert.equal((await judgmentSessions(stack.db, target)).length, 1);
    } finally {
      await stack.db.$disconnect();
    }
  });

/**
 * The red line, checked against the database rather than against the source: creating a
 * PROJECT_COORDINATOR session must not walk into the machinery 0163-0165 removed.
 *
 * That value had five trigger guards and three CHECKs over it, dropped on the stated grounds that
 * "no new PROJECT_COORDINATOR session can be created". This unit creates them again, so what is
 * left has to be looked at rather than assumed — and what is left is one trigger, on
 * `project_action`, a table nothing here writes.
 */
test('nothing left over from the control loop fires on a judgment session',
  { skip, timeout: 120_000 }, async () => {
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);

      const checks = await client.query(`
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'session'::regclass
           AND pg_get_constraintdef(oid) LIKE '%PROJECT_COORDINATOR%'`);
      assert.deepEqual(checks.rows, [], 'session carries no PROJECT_COORDINATOR CHECK any more');

      const triggers = await client.query(`
        SELECT c.relname AS on_table, t.tgname
          FROM pg_trigger t
          JOIN pg_proc p ON p.oid = t.tgfoid
          JOIN pg_class c ON c.oid = t.tgrelid
         WHERE NOT t.tgisinternal
           AND pg_get_functiondef(p.oid) LIKE '%PROJECT_COORDINATOR%'
         ORDER BY 1, 2`);
      assert.deepEqual(
        triggers.rows.map((r) => r.on_table),
        ['project_action'],
        'the only survivor guards project_action, which no judgment path writes',
      );
    } finally {
      await client.end();
    }
  });

/** The harness's own precondition, asserted once rather than in each test above. */
test('the database under test really is a disposable one', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});

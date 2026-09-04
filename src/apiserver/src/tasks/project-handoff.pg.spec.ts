/**
 * Unit L4 on real PostgreSQL: a crossing that is declared, answered, spent once — and every way of
 * getting one of those wrong.
 *
 * The unit tests decide the rules. They cannot decide these, because what is under test is either
 * the DATABASE's own refusal (a rule that only means something against a writer the service never
 * sees — a repair script, a psql session, a mixed-version binary) or an ORDER between two
 * transactions, which a sequential test can only ever demonstrate one half of.
 *
 * Give it its own database, as the L3 fence spec does:
 *
 *   docker run -d --name pcc-l4-pg -e POSTGRES_USER=pccl4-u -e POSTGRES_PASSWORD=pccl4 \
 *     -e POSTGRES_DB=pccl4-db -p 127.0.0.1:55824:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine
 *   DATABASE_URL=postgresql://pccl4-u:pccl4@127.0.0.1:55824/pccl4-db npx prisma migrate deploy
 *   COORDINATOR_PG_URL=… COORDINATOR_PG_EXPECTED_DATABASE=pccl4-db COORDINATOR_PG_EXPECTED_USER=pccl4-u \
 *     node --test --test-concurrency=1 build/tasks/project-handoff.pg.spec.js
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CreatorType, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { handoffPayloadDigest, type HandoffRequestIdentity } from '../projects/project-handoff';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const POLL_INTERVAL_MS = 2;
const DEADLINE_MS = 30_000;

interface World {
  ownerId: string;
  otherOwnerId: string;
  /** The project the coordinator session holds. */
  projectA: string;
  /** The project work is handed TO. */
  projectB: string;
  /** A third project the same owner owns — the one a coordinator of it may not speak for. */
  projectC: string;
  workspaceId: string;
  sessionA: string;
  sessionC: string;
  successorSessionId: string;
  taskInA: string;
  taskInB: string;
}

test('unit L4: a crossing is declared, answered and spent exactly once', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const { prismaClientFor } = await import('../prisma/prisma-client.js');

  const connect = async (): Promise<Client> => {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await client.connect();
    await verifyCoordinatorPgIdentity(client);
    return client;
  };
  const admin = await connect();
  /** Holds a row open while the work under test parks behind it. */
  const barrier = await connect();
  /** Read-only, so watching a blocked backend never joins what it observes. */
  const observer = await connect();
  const barrierPid = (await barrier.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const prisma: PrismaClient = prismaClientFor(url);

  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await barrier.query('ROLLBACK').catch(() => undefined);
    for (const client of [admin, barrier, observer]) await client.end().catch(() => undefined);
  });

  const handoffs = new ProjectHandoffService(prisma as never);
  const tasks = new TasksService(
    prisma as never,
    {} as never,
    { publishTaskChanged: () => undefined, publishForUser: () => undefined } as never,
    handoffs,
  );
  const AGENT = (ownerId: string) => ({ type: CreatorType.AGENT, id: ownerId });

  async function seed(label: string, policies: { a?: string; b?: string } = {}): Promise<World> {
    const w: World = {
      ownerId: randomUUID(),
      otherOwnerId: randomUUID(),
      projectA: randomUUID(),
      projectB: randomUUID(),
      projectC: randomUUID(),
      workspaceId: randomUUID(),
      sessionA: randomUUID(),
      sessionC: randomUUID(),
      successorSessionId: randomUUID(),
      taskInA: randomUUID(),
      taskInB: randomUUID(),
    };
    const runnerId = randomUUID();
    for (const [id, suffix] of [[w.ownerId, 'a'], [w.otherOwnerId, 'b']] as const) {
      await admin.query(
        `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
        [id, `${label}-${suffix}-${id}@l4.invalid`, label],
      );
    }
    await admin.query(
      `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
       VALUES ($1,$2,$3,'ONLINE',$4,now())`,
      [runnerId, w.ownerId, `${label}-runner`, `${label}-${runnerId}`],
    );
    await admin.query(
      `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
       VALUES ($1,$2,$3,$4,true,true)`,
      [w.workspaceId, w.ownerId, `${label}-agent`, runnerId],
    );
    for (const [id, policy] of [
      [w.projectA, policies.a ?? 'GUARDED_AUTO'],
      [w.projectB, policies.b ?? 'GUARDED_AUTO'],
      [w.projectC, 'GUARDED_AUTO'],
    ] as const) {
      await admin.query(
        `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","automation_policy","updated_at")
         VALUES ($1,$2,$3,true,$4::"project_automation_policy",now())`,
        [id, w.ownerId, `${label}-${id.slice(0, 4)}`, policy],
      );
      await admin.query(
        `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
           ON CONFLICT ("project_id") DO NOTHING`,
        [id],
      );
    }
    for (const id of [w.sessionA, w.sessionC, w.successorSessionId]) {
      await admin.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
           "provider","status","dispatch_origin","updated_at")
         VALUES ($1,$2,$3,$4,'fixture',$2,'claude','RUNNING'::"run_status",
           'USER'::"session_dispatch_origin",now())`,
        [id, w.ownerId, w.workspaceId, `${label}-session`],
      );
    }
    for (const [id, project] of [[w.taskInA, w.projectA], [w.taskInB, w.projectB]] as const) {
      await admin.query(
        `INSERT INTO "task" ("id","owner_id","title","status","project_id","creator_type","creator_id","updated_at","completion_criterion")
         VALUES ($1,$2,$3,'OPEN'::"task_status",$4,'USER'::"creator_type",$2,now(),'EVIDENCE_JUDGMENT')`,
        [id, w.ownerId, `${label}-task-${id.slice(0, 4)}`, project],
      );
    }
    // The turn a coordinator's writes belong to. Without one there is no idempotency key, so a
    // second call is a second WRITE rather than a redelivery — which is a different case, and one
    // R9 is supposed to refuse.
    await admin.query(
      `INSERT INTO "conversation_turn" ("id","session_id","seq","client_turn_id","kind","status")
       VALUES ($1,$2,1,$3,'message','IN_FLIGHT')`,
      [randomUUID(), w.sessionA, `${label}-turn`],
    );
    await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.projectA, w.sessionA]);
    await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.projectC, w.sessionC]);
    return w;
  }

  const identityFor = (w: World, over: Record<string, unknown> = {}): HandoffRequestIdentity => ({
    plan: {
      title: 'the crossing', description: null, acceptanceCriteria: null, labels: [],
      assigneeId: null, listId: null, provider: null, model: null, autoRunWhenReady: null,
      runAt: null, dueDate: null, completionPolicy: null, parentTaskId: null, parentRefDigest: null,
      verifiesTaskId: null, verifiesRefDigest: null, supersedesTaskId: null,
      dependsOnTaskIds: [], dependsOnRefDigests: [], ...over,
    },
    source: {
      projectId: w.projectA, taskId: null, sessionId: w.sessionA,
      triggerEvent: 'coordinator.session_filed',
    },
  });

  const declarationFor = (w: World, over: Record<string, unknown> = {}) => ({
    fromProjectId: w.projectA,
    toProjectId: w.projectB,
    kind: 'FILE_TASK' as const,
    subjectTaskId: null,
    identity: identityFor(w),
    title: 'the crossing',
    reason: 'it belongs over there',
    requestedBySessionId: w.sessionA,
    ...over,
  });

  const scopeOf = async (w: World) => ({
    projectId: w.projectA,
    generation: (await admin.query<{ g: string }>(
      `SELECT "coordinator_generation"::text AS g FROM "project_runtime" WHERE "project_id" = $1::uuid`,
      [w.projectA],
    )).rows[0].g,
  });

  async function rows(ownerId: string) {
    const { rows: found } = await admin.query(
      `SELECT * FROM "project_handoff_approval" WHERE "owner_id" = $1::uuid ORDER BY "requested_at"`,
      [ownerId],
    );
    return found;
  }

  async function tasksIn(projectId: string): Promise<string[]> {
    const { rows: found } = await admin.query<{ title: string }>(
      'SELECT "title" FROM "task" WHERE "project_id" = $1::uuid ORDER BY "title"', [projectId]);
    return found.map((row) => row.title);
  }

  async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (error) {
      assert.ok(
        error instanceof ForbiddenException || error instanceof ConflictException
        || error instanceof BadRequestException,
        `expected a typed refusal, got ${error}`,
      );
      return (error as { getResponse(): unknown }).getResponse();
    }
    throw new assert.AssertionError({ message: 'the call was not refused' });
  }

  /**
   * A real reopen, inside the barrier transaction: terminal and back.
   *
   * This used to be the one event that could refuse a plan for surviving it: 0150 advanced the
   * acceptance epoch on `DONE|CANCELLED -> OPEN`, and a plan that named the epoch before it was
   * stale by definition. `0229_project_acceptance_judgment_removal` dropped the epoch, so what is
   * left is a status round trip that ends on the status it started from — nothing the plan fence
   * reads has moved. The transition is kept here because that is the fact under test now.
   */
  async function reopen(projectId: string): Promise<void> {
    await barrier.query(
      `UPDATE "project" SET "status"='CANCELLED'::"project_status", "updated_at"=now()
        WHERE "id"=$1::uuid`, [projectId]);
    await barrier.query(
      `UPDATE "project" SET "status"='OPEN'::"project_status", "updated_at"=now()
        WHERE "id"=$1::uuid`, [projectId]);
  }

  /** Wait until some backend is parked in a lock wait behind `blocker`, or give up loudly. */
  async function awaitBlockedBy(blocker: number, what: string): Promise<void> {
    const until = Date.now() + DEADLINE_MS;
    for (;;) {
      const { rows: found } = await observer.query(
        `SELECT pid FROM pg_stat_activity
          WHERE $1 = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`,
        [blocker],
      );
      if (found[0]) return;
      assert.ok(Date.now() < until, `deadline exceeded waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  // ------------------------------------------------------------------------------------------
  // The database's own refusals. Every one of these is a statement the SERVICE would never make;
  // they exist because psql, a repair script and a mixed-version binary all reach this table.
  // ------------------------------------------------------------------------------------------

  await t.test('a spent approval accepts nothing at all', async () => {
    const w = await seed('spent');
    const answer = await handoffs.declare(w.ownerId, declarationFor(w), await scopeOf(w), new Date());
    await admin.query(
      `UPDATE "project_handoff_approval" SET "state"='APPROVED',"decided_by"='USER',
        "decided_by_user_id"=$2::uuid,"decided_at"=now(),"expires_at"=now()+interval '1 day'
       WHERE "id"=$1::uuid`, [answer.row.id, w.ownerId]);
    await admin.query(
      `UPDATE "project_handoff_approval" SET "state"='APPLIED',"applied_task_id"=$2::uuid,
        "applied_at"=now() WHERE "id"=$1::uuid`, [answer.row.id, w.taskInB]);
    for (const [what, sql, params] of [
      ['a second spend', `UPDATE "project_handoff_approval" SET "applied_task_id"=$2::uuid WHERE "id"=$1::uuid`, [answer.row.id, w.taskInA]],
      ['a re-answer', `UPDATE "project_handoff_approval" SET "state"='DENIED' WHERE "id"=$1::uuid`, [answer.row.id]],
      ['an edit', `UPDATE "project_handoff_approval" SET "reason"='something else' WHERE "id"=$1::uuid`, [answer.row.id]],
    ] as const) {
      await assert.rejects(() => admin.query(sql, params as never), /PROJECT_HANDOFF_SPENT/, what);
    }
  });

  await t.test('an answer cannot be renamed, in any state', async () => {
    const w = await seed('renamed');
    const answer = await handoffs.declare(w.ownerId, declarationFor(w), await scopeOf(w), new Date());
    const id = answer.row.id;
    // Every state the row can be in, including the two that have no other outgoing edge. The
    // statement changes nothing else, so every CHECK on this table is satisfied and every
    // transition arm reads it as a no-op — which is exactly why the guard has to name the key.
    const states: Array<[string, () => Promise<unknown>]> = [
      ['PENDING', async () => undefined],
      ['APPROVED', async () => handoffs.decide(w.ownerId, w.ownerId, id, 'APPROVE', new Date())],
      ['APPLIED', async () => admin.query(
        `UPDATE "project_handoff_approval" SET "state"='APPLIED',"applied_task_id"=$2::uuid,
          "applied_at"=now() WHERE "id"=$1::uuid`, [id, w.taskInB])],
    ];
    for (const [state, reach] of states) {
      await reach();
      const before = (await rows(w.ownerId))[0];
      await assert.rejects(
        () => admin.query(
          `UPDATE "project_handoff_approval" SET "id"=$2::uuid WHERE "id"=$1::uuid`,
          [id, randomUUID()]),
        /PROJECT_HANDOFF_(IMMUTABLE|SPENT)/,
        `a ${state} answer was renamed`,
      );
      const after = (await rows(w.ownerId))[0];
      assert.equal(after.id, id, `the ${state} answer kept the name it was given out under`);
      assert.deepEqual(after, before, `something else moved while renaming a ${state} answer`);
    }
    // And the state with the only other terminal shape, on its own row: a refusal.
    const refused = await seed('renamed-denied');
    const denied = await handoffs.declare(
      refused.ownerId, declarationFor(refused), await scopeOf(refused), new Date());
    await handoffs.decide(refused.ownerId, refused.ownerId, denied.row.id, 'DENY', new Date());
    await assert.rejects(
      () => admin.query(
        `UPDATE "project_handoff_approval" SET "id"=$2::uuid WHERE "id"=$1::uuid`,
        [denied.row.id, randomUUID()]),
      /PROJECT_HANDOFF_IMMUTABLE/);
    assert.equal((await rows(refused.ownerId))[0].id, denied.row.id);
  });

  await t.test('a refused crossing stays refused — no resurrection, by any writer', async () => {
    const w = await seed('denied');
    const answer = await handoffs.declare(w.ownerId, declarationFor(w), await scopeOf(w), new Date());
    await handoffs.decide(w.ownerId, w.ownerId, answer.row.id, 'DENY', new Date());
    // The service refuses it...
    const refusal = await refusalOf(() =>
      handoffs.decide(w.ownerId, w.ownerId, answer.row.id, 'APPROVE', new Date()));
    assert.match(JSON.stringify(refusal), /stays refused/);
    // ...and so does the database, to a writer that never asked the service.
    await assert.rejects(() => admin.query(
      `UPDATE "project_handoff_approval" SET "state"='APPROVED',"decided_at"=now(),
        "expires_at"=now()+interval '1 day' WHERE "id"=$1::uuid`, [answer.row.id]),
      /PROJECT_HANDOFF_TRANSITION/);
    const [row] = await rows(w.ownerId);
    assert.equal(row.state, 'DENIED');
  });

  await t.test('an answer is not edited in place: decider, deadline and question are frozen', async () => {
    const w = await seed('frozen');
    const answer = await handoffs.declare(w.ownerId, declarationFor(w), await scopeOf(w), new Date());
    await handoffs.decide(w.ownerId, w.ownerId, answer.row.id, 'APPROVE', new Date());
    const before = (await rows(w.ownerId))[0];
    const tamper: Array<[string, string]> = [
      ['a person\'s yes becomes the policy\'s', `SET "decided_by"='POLICY',"decided_by_user_id"=NULL`],
      ['the deadline is extended', `SET "expires_at"=now()+interval '10 years'`],
      ['the decision time is moved', `SET "decided_at"=now()+interval '1 hour'`],
      ['the question is reworded', `SET "title"='something the user never read'`],
      ['the reason is rewritten', `SET "reason"='a different argument'`],
      ['it is re-aimed at another project', `SET "to_project_id"='${w.projectC}'::uuid`],
      ['it is re-aimed at another kind', `SET "kind"='MOVE_TASK'`],
      ['its payload is swapped', `SET "payload_digest"=repeat('f', 64)`],
      ['its crossing is swapped', `SET "crossing_key"=repeat('f', 64)`],
      ['its asker is swapped', `SET "requested_by_session_id"='${w.successorSessionId}'::uuid`],
    ];
    for (const [what, set] of tamper) {
      await assert.rejects(
        () => admin.query(`UPDATE "project_handoff_approval" ${set} WHERE "id"=$1::uuid`, [answer.row.id]),
        /PROJECT_HANDOFF_IMMUTABLE/,
        what,
      );
    }
    const after = (await rows(w.ownerId))[0];
    for (const column of ['decided_by', 'decided_by_user_id', 'title', 'reason', 'to_project_id',
      'kind', 'payload_digest', 'crossing_key', 'requested_by_session_id']) {
      assert.deepEqual(after[column], before[column], `${column} moved`);
    }
    assert.equal(after.expires_at.getTime(), before.expires_at.getTime());
    assert.equal(after.decided_at.getTime(), before.decided_at.getTime());
  });

  await t.test('spending keeps who approved it, when, and what it was good for', async () => {
    const w = await seed('preserve');
    const answer = await handoffs.declare(w.ownerId, declarationFor(w), await scopeOf(w), new Date());
    await handoffs.decide(w.ownerId, w.ownerId, answer.row.id, 'APPROVE', new Date());
    await assert.rejects(() => admin.query(
      `UPDATE "project_handoff_approval" SET "state"='APPLIED',"applied_task_id"=$2::uuid,
        "applied_at"=now(),"decided_by_user_id"=$3::uuid WHERE "id"=$1::uuid`,
      [answer.row.id, w.taskInB, w.otherOwnerId]), /PROJECT_HANDOFF_IMMUTABLE/);
    await assert.rejects(() => admin.query(
      `UPDATE "project_handoff_approval" SET "state"='APPLIED',"applied_task_id"=$2::uuid,
        "applied_at"=now(),"expires_at"=now()+interval '9 years' WHERE "id"=$1::uuid`,
      [answer.row.id, w.taskInB]), /PROJECT_HANDOFF_IMMUTABLE/);
    // The legal shape: append the evidence, keep the authority.
    await admin.query(
      `UPDATE "project_handoff_approval" SET "state"='APPLIED',"applied_task_id"=$2::uuid,
        "applied_at"=now() WHERE "id"=$1::uuid`, [answer.row.id, w.taskInB]);
    const row = (await rows(w.ownerId))[0];
    assert.equal(row.state, 'APPLIED');
    assert.equal(row.decided_by, 'USER');
    assert.ok(row.expires_at, 'the record of how long the authority was good for survives the spend');
  });

  // ------------------------------------------------------------------------------------------
  // Who may declare what, derived from rows rather than believed.
  // ------------------------------------------------------------------------------------------

  await t.test('a third project\'s coordinator cannot speak for A, and writes nothing', async () => {
    const w = await seed('third');
    // Everything about this is owned by the right account; the only thing wrong with it is who is
    // asking. That is the whole point — ownership was never the boundary.
    //
    // Two shapes, because a caller can get here two ways and §4's ORDER decides which answer each
    // gets. The honest one is what the product produces: the server derives the scope from the same
    // session, so C's coordinator arrives holding C and naming A as the source (R6 — file at home
    // or ask). The fabricated one claims to hold A; presented against derived that is R3, the
    // takeover answer, which says yield rather than retry. Both refuse and both write nothing.
    const honest = await refusalOf(() => handoffs.declare(
      w.ownerId,
      declarationFor(w, { requestedBySessionId: w.sessionC }),
      { projectId: w.projectC, generation: '0' },
      new Date(),
    ));
    assert.equal((honest as { code: string }).code, 'PROJECT_SCOPE_MISMATCH');
    const fabricated = await refusalOf(() => handoffs.declare(
      w.ownerId,
      declarationFor(w, { requestedBySessionId: w.sessionC }),
      { projectId: w.projectA, generation: '0' },
      new Date(),
    ));
    assert.equal((fabricated as { code: string }).code, 'COORDINATOR_GENERATION_MOVED');
    assert.deepEqual(await rows(w.ownerId), []);
  });

  await t.test('source evidence that does not describe the session is refused', async () => {
    const w = await seed('evidence');
    const scope = await scopeOf(w);
    const bad: Array<[string, HandoffRequestIdentity]> = [
      ['another project', { ...identityFor(w), source: { ...identityFor(w).source, projectId: w.projectC } }],
      ['another session', { ...identityFor(w), source: { ...identityFor(w).source, sessionId: w.successorSessionId } }],
      ['a task it is not running', { ...identityFor(w), source: { ...identityFor(w).source, taskId: w.taskInA } }],
      ['an event it did not produce', { ...identityFor(w), source: { ...identityFor(w).source, triggerEvent: 'agent.session_filed' } }],
    ];
    for (const [what, identity] of bad) {
      const refusal = await refusalOf(() =>
        handoffs.declare(w.ownerId, declarationFor(w, { identity }), scope, new Date()));
      assert.equal((refusal as { code: string }).code, 'PROJECT_SCOPE_MISMATCH', what);
    }
    assert.deepEqual(await rows(w.ownerId), []);
  });

  await t.test('a subject on the wrong side of the crossing is incoherent, and refused', async () => {
    const w = await seed('subject');
    const scope = await scopeOf(w);
    // A MOVE takes a task OUT of the source: naming one that lives in the target is backwards.
    await refusalOf(() => handoffs.declare(w.ownerId, declarationFor(w, {
      kind: 'MOVE_TASK', subjectTaskId: w.taskInB,
    }), scope, new Date()));
    // A dependency waits ON work in the target: naming one in the source is the same mistake.
    await refusalOf(() => handoffs.declare(w.ownerId, declarationFor(w, {
      kind: 'DEPEND_ON_TASK', subjectTaskId: w.taskInA, dependentTaskId: w.taskInA,
    }), scope, new Date()));
    assert.deepEqual(await rows(w.ownerId), []);
    // And the right way round is accepted.
    const ok = await handoffs.declare(w.ownerId, declarationFor(w, {
      kind: 'MOVE_TASK', subjectTaskId: w.taskInA,
    }), scope, new Date());
    assert.equal(ok.row.state, 'PENDING');
  });

  await t.test('a rotated scope cannot file a question in its own name', async () => {
    const w = await seed('rotated');
    const scope = await scopeOf(w);
    await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.projectA, w.successorSessionId]);
    const refusal = await refusalOf(() => handoffs.declare(w.ownerId, declarationFor(w), scope, new Date()));
    assert.equal((refusal as { code: string }).code, 'COORDINATOR_GENERATION_MOVED');
    assert.deepEqual(await rows(w.ownerId), []);
  });

  await t.test('guarded-auto waits for a person; both ends on AUTO do not', async () => {
    const guarded = await seed('guarded');
    const first = await handoffs.declare(guarded.ownerId, declarationFor(guarded), await scopeOf(guarded), new Date());
    assert.equal(first.row.state, 'PENDING');
    assert.equal(first.row.decidedBy, null);

    const auto = await seed('auto', { a: 'AUTO', b: 'AUTO' });
    const second = await handoffs.declare(auto.ownerId, declarationFor(auto), await scopeOf(auto), new Date());
    assert.equal(second.row.state, 'APPROVED');
    assert.equal(second.row.decidedBy, 'POLICY');
    assert.equal(second.row.decidedByUserId, null);

    // One end guarded is enough to need a person.
    const half = await seed('half', { a: 'AUTO', b: 'GUARDED_AUTO' });
    const third = await handoffs.declare(half.ownerId, declarationFor(half), await scopeOf(half), new Date());
    assert.equal(third.row.state, 'PENDING');
  });

  await t.test('the same words about a different source are a different question', async () => {
    const w = await seed('sources');
    const scope = await scopeOf(w);
    // Two coordinator runs of the same project, noticing the same thing on two different tasks.
    await admin.query('UPDATE "session" SET "task_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.sessionA, w.taskInA]);
    const withTaskA = await handoffs.declare(w.ownerId, declarationFor(w, {
      identity: { ...identityFor(w), source: { ...identityFor(w).source, taskId: w.taskInA } },
    }), scope, new Date());
    await admin.query('UPDATE "session" SET "task_id" = NULL WHERE "id" = $1::uuid', [w.sessionA]);
    const withNoTask = await handoffs.declare(w.ownerId, declarationFor(w), scope, new Date());
    assert.notEqual(withTaskA.row.id, withNoTask.row.id, 'two sources collapsed into one question');
    assert.equal((await rows(w.ownerId)).length, 2);
  });

  await t.test('declaring twice, and two declaring at once, reach one row', async () => {
    const w = await seed('idempotent');
    const scope = await scopeOf(w);
    const once = await handoffs.declare(w.ownerId, declarationFor(w), scope, new Date());
    const twice = await handoffs.declare(w.ownerId, declarationFor(w), scope, new Date());
    assert.equal(once.row.id, twice.row.id);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
      handoffs.declare(w.ownerId, declarationFor(w), scope, new Date())));
    assert.equal(new Set(concurrent.map((answer) => answer.row.id)).size, 1);
    assert.equal((await rows(w.ownerId)).length, 1);
  });

  await t.test('approving a live yes writes nothing: no second decision, no fresh deadline', async () => {
    const w = await seed('stable');
    const answer = await handoffs.declare(w.ownerId, declarationFor(w), await scopeOf(w), new Date());
    const first = await handoffs.decide(w.ownerId, w.ownerId, answer.row.id, 'APPROVE', new Date());
    const again = await handoffs.decide(
      w.ownerId, w.ownerId, answer.row.id, 'APPROVE',
      new Date(Date.now() + 60_000),
    );
    assert.equal(again.row.expiresAt!.getTime(), first.row.expiresAt!.getTime(),
      'clicking approve twice extended the authorization it was supposed to bound');
    assert.equal(again.row.decidedAt!.getTime(), first.row.decidedAt!.getTime());
  });

  // ------------------------------------------------------------------------------------------
  // The whole path, through the service a coordinator actually calls.
  // ------------------------------------------------------------------------------------------

  await t.test('a declared crossing files the question, writes no task, and lands one when answered', async () => {
    const w = await seed('endtoend');
    const create = () => tasks.create(w.ownerId, {
      title: 'the crossing', projectId: w.projectB, handoff: { reason: 'it belongs over there' },
    } as never, AGENT(w.ownerId), w.sessionA);

    const before = await tasksIn(w.projectB);
    const refusal = await refusalOf(create) as Record<string, unknown>;
    assert.equal(refusal.code, 'APPROVAL_PENDING');
    assert.equal(refusal.requiredAction, 'AWAIT_HANDOFF_APPROVAL');
    assert.ok(refusal.handoffId, 'the refusal names the question it filed');
    assert.deepEqual(await tasksIn(w.projectB), before, 'nothing of the plan was written');
    const [question] = await rows(w.ownerId);
    assert.equal(question.state, 'PENDING');

    // Retrying while it is pending asks nothing new and writes nothing.
    await refusalOf(create);
    assert.equal((await rows(w.ownerId)).length, 1);

    await handoffs.decide(w.ownerId, w.ownerId, question.id, 'APPROVE', new Date());
    const landed = await create();
    assert.equal(landed.projectId, w.projectB);
    // AC2: the target task keeps the source project, task, session and event.
    const { rows: [row] } = await admin.query(
      `SELECT "discovered_from_project_id","source_session_id","source_task_id","trigger_event"
         FROM "task" WHERE "id" = $1::uuid`, [landed.id]);
    assert.equal(row.discovered_from_project_id, w.projectA);
    assert.equal(row.source_session_id, w.sessionA);
    assert.equal(row.trigger_event, 'coordinator.session_filed');
    const spent = (await rows(w.ownerId))[0];
    assert.equal(spent.state, 'APPLIED');
    assert.equal(spent.applied_task_id, landed.id);

    // AC3: the same turn again is the same task, not a second one.
    const replay = await create();
    assert.equal(replay.id, landed.id);
    assert.deepEqual(await tasksIn(w.projectB), [...before, 'the crossing'].sort());
  });

  await t.test('a spent yes does not authorise a second crossing', async () => {
    const w = await seed('spend-once');
    const create = (title: string) => tasks.create(w.ownerId, {
      title, projectId: w.projectB, handoff: {},
    } as never, AGENT(w.ownerId), w.sessionA);
    const before = await tasksIn(w.projectB);
    await refusalOf(() => create('one'));
    const [question] = await rows(w.ownerId);
    await handoffs.decide(w.ownerId, w.ownerId, question.id, 'APPROVE', new Date());
    await create('one');
    // A different plan is a different crossing and gets its own question...
    const refusal = await refusalOf(() => create('two')) as Record<string, unknown>;
    assert.equal(refusal.code, 'APPROVAL_PENDING');
    assert.notEqual(refusal.handoffId, question.id);
    assert.deepEqual(await tasksIn(w.projectB), [...before, 'one'].sort());
    // ...and the spent one cannot be re-spent, whoever asks.
    await assert.rejects(() => admin.query(
      `UPDATE "project_handoff_approval" SET "applied_task_id"=$2::uuid WHERE "id"=$1::uuid`,
      [question.id, w.taskInB]), /PROJECT_HANDOFF_SPENT/);
  });

  await t.test('a settled destination is refused without filing a question anybody could answer', async () => {
    const w = await seed('settled');
    // CANCELLED rather than DONE: both are "not open" to §4 R8, and reaching DONE goes through the
    // acceptance gate (0150), which is a different unit's rule and not what this case is about.
    await admin.query(`UPDATE "project" SET "status"='CANCELLED'::"project_status" WHERE "id"=$1::uuid`,
      [w.projectB]);
    const refusal = await refusalOf(() => tasks.create(w.ownerId, {
      title: 'into a settled goal', projectId: w.projectB, handoff: {},
    } as never, AGENT(w.ownerId), w.sessionA)) as Record<string, unknown>;
    assert.equal(refusal.code, 'PROJECT_REOPEN_REQUIRED');
    assert.equal(refusal.requiredAction, 'REOPEN_PROJECT_FIRST');
    assert.deepEqual(await rows(w.ownerId), [], 'an approval cannot buy a way into a settled project');
  });

  await t.test('a cross-project edge needs its own answer, and spends it', async () => {
    const w = await seed('edge');
    const create = () => tasks.create(w.ownerId, {
      title: 'waits on the other goal', projectId: w.projectA,
      dependsOnTaskIds: [w.taskInB], handoff: {},
    } as never, AGENT(w.ownerId), w.sessionA);
    const refusal = await refusalOf(create) as Record<string, unknown>;
    assert.equal(
      JSON.stringify(refusal).includes('APPROVAL_PENDING')
      || JSON.stringify(refusal).includes('CROSS_PROJECT_APPROVAL_REQUIRED'), true,
      `unexpected refusal ${JSON.stringify(refusal)}`);
    assert.deepEqual(await tasksIn(w.projectA), [
      (await admin.query<{ title: string }>('SELECT "title" FROM "task" WHERE "id"=$1::uuid', [w.taskInA])).rows[0].title,
    ], 'the plan wrote nothing');
    const [question] = await rows(w.ownerId);
    assert.equal(question.kind, 'DEPEND_ON_TASK');
    assert.equal(question.subject_task_id, w.taskInB);
    await handoffs.decide(w.ownerId, w.ownerId, question.id, 'APPROVE', new Date());
    const landed = await create();
    const spent = (await rows(w.ownerId))[0];
    assert.equal(spent.state, 'APPLIED');
    assert.equal(spent.applied_task_id, landed.id, 'the edge\'s yes names the task it was spent on');
  });

  await t.test('a batch that fails preflight writes no task, no edge and no answer', async () => {
    const w = await seed('batch-zero');
    const before = await rows(w.ownerId);
    const refusal = await refusalOf(() => tasks.createMany(w.ownerId, {
      tasks: [
        { title: 'a', ref: 'a', projectId: w.projectA },
        // A parent in another project: never approvable, so the whole plan is refused.
        { title: 'b', projectId: w.projectA, parentTaskId: w.taskInB },
      ],
    } as never, AGENT(w.ownerId), w.sessionA)) as Record<string, unknown>;
    assert.equal(refusal.code, 'PLAN_PREFLIGHT_FAILED');
    assert.equal(refusal.written, 0);
    assert.deepEqual(await tasksIn(w.projectA), [
      (await admin.query<{ title: string }>('SELECT "title" FROM "task" WHERE "id"=$1::uuid', [w.taskInA])).rows[0].title,
    ]);
    assert.deepEqual(await rows(w.ownerId), before);
  });

  // ------------------------------------------------------------------------------------------
  // Orders between transactions. A sequential test can only ever show one half of these.
  // ------------------------------------------------------------------------------------------

  await t.test('a rotation that commits mid-declaration refuses it, and leaves nothing', async () => {
    const w = await seed('barrier-rotation');
    const scope = await scopeOf(w);
    await barrier.query('BEGIN');
    await barrier.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.projectA, w.successorSessionId]);
    const declaring = handoffs.declare(w.ownerId, declarationFor(w), scope, new Date());
    declaring.catch(() => undefined);
    await awaitBlockedBy(barrierPid, 'the declaration parking behind the source project row');
    await barrier.query('COMMIT');
    const refusal = await refusalOf(() => declaring) as { code: string };
    assert.equal(refusal.code, 'COORDINATOR_GENERATION_MOVED');
    assert.deepEqual(await rows(w.ownerId), []);
  });

  await t.test('an owner\'s own plan still locks the project it names, and lands across a reopen', async () => {
    const w = await seed('barrier-user');
    await barrier.query('BEGIN');
    await reopen(w.projectA);
    // No creator session at all: this is the user API path, the one §4 R1 exempts from the scope
    // contract. What used to judge them here anyway was the single claim only a caller can make —
    // "I planned this against acceptance epoch N" — and 0229 took the epoch away, so a user write
    // has nothing left to state and nothing left to be refused for. It still parks behind the row
    // rather than returning without taking a lock; it lands once the reopen commits.
    const creating = tasks.create(w.ownerId, {
      title: 'the owner plans against a project that reopens underneath them', projectId: w.projectA,
    } as never);
    creating.catch(() => undefined);
    await awaitBlockedBy(barrierPid, 'the owner\'s create parking behind the project row');
    await barrier.query('COMMIT');
    const landed = await creating;
    assert.equal(landed.projectId, w.projectA);
    assert.equal((await tasksIn(w.projectA)).length, 2, 'the fixture task and the one it planned');
  });

  await t.test('a declared crossing locks BOTH ends before it writes', async () => {
    for (const end of ['source', 'target'] as const) {
      const w = await seed(`barrier-${end}`);
      // Approve it first, so what is under test is the WRITE's lock set rather than the refusal.
      const answer = await handoffs.declare(w.ownerId, declarationFor(w), await scopeOf(w), new Date());
      await handoffs.decide(w.ownerId, w.ownerId, answer.row.id, 'APPROVE', new Date());
      const held = end === 'source' ? w.projectA : w.projectB;
      await barrier.query('BEGIN');
      await barrier.query(
        'SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE', [held]);
      const creating = tasks.create(w.ownerId, {
        title: 'the crossing', projectId: w.projectB, handoff: { reason: 'it belongs over there' },
      } as never, AGENT(w.ownerId), w.sessionA);
      creating.catch(() => undefined);
      // The claim: the write parks behind THIS end. Held source proves the project a crossing
      // derives its authority from is in the lock set — which it was not until the call site passed
      // it — and held target proves the project it lands in still is.
      await awaitBlockedBy(barrierPid, `the crossing parking behind its ${end}`);
      await barrier.query('COMMIT');
      const landed = await creating;
      assert.equal(landed.projectId, w.projectB);
    }
  });

  await t.test('a team that is revoked mid-plan refuses it rather than writing against the old one', async () => {
    const w = await seed('barrier-team');
    // COMMITTED before anything starts: the assignee is on the team, so the plan the preflight sees
    // is an ALLOWED one. That is the whole shape of the case — a plan refused before the
    // transaction proves nothing about what happens after it.
    const membership = randomUUID();
    await admin.query(
      `INSERT INTO "project_member" ("id","project_id","agent_id","role")
       VALUES ($1,$2,$3,'MEMBER'::"project_role")`,
      [membership, w.projectA, w.workspaceId]);

    await barrier.query('BEGIN');
    // The authority lock this plan's own fence takes, held by somebody else, and the revocation in
    // the same transaction: the writer parks first and sees the team change only once it commits.
    await barrier.query('SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE', [w.projectA]);
    await barrier.query('DELETE FROM "project_member" WHERE "id" = $1::uuid', [membership]);
    const creating = tasks.create(w.ownerId, {
      title: 'assigned to somebody the team no longer has', projectId: w.projectA,
      assigneeId: w.workspaceId,
    } as never, AGENT(w.ownerId), w.sessionA);
    creating.catch(() => undefined);
    await awaitBlockedBy(barrierPid, 'the create parking behind the project row');
    await barrier.query('COMMIT');
    const refusal = await refusalOf(() => creating) as { code: string; message: string };
    assert.equal(refusal.code, 'PLAN_AUTHORITY_MOVED');
    assert.match(refusal.message, /team or its coordinator/);
    assert.equal((await tasksIn(w.projectA)).length, 1, 'only the fixture task is there');
    assert.deepEqual(await rows(w.ownerId), [], 'and no crossing was spent');
  });

  await t.test('a budget lowered mid-plan refuses the plan the contract covers, not the owner\'s own', async () => {
    const w = await seed('barrier-budget');
    await barrier.query('BEGIN');
    await barrier.query(
      `UPDATE "project" SET "max_concurrent_tasks" = 1, "updated_at" = now() WHERE "id" = $1::uuid`,
      [w.projectA]);
    // A session's plan is inside the scope contract: it parks behind the row and is judged on the
    // world it finds when it wakes, budget included.
    const creating = tasks.create(w.ownerId, {
      title: 'planned against a budget that has since been lowered', projectId: w.projectA,
    } as never, AGENT(w.ownerId), w.sessionA);
    creating.catch(() => undefined);
    await awaitBlockedBy(barrierPid, 'the create parking behind the project row');
    await barrier.query('COMMIT');
    const refusal = await refusalOf(() => creating) as { code: string; message: string };
    assert.equal(refusal.code, 'PLAN_AUTHORITY_MOVED');
    assert.match(refusal.message, /concurrency budget/);
    assert.equal((await tasksIn(w.projectA)).length, 1, 'only the fixture task is there');

    // The owner's own path is the other half, and it moved: §4 R1 exempted them from the SCOPE, and
    // the acceptance-epoch claim was the only thing that ever pulled a user write into the preflight
    // regardless. 0229 removed the epoch, so the same lowered budget does not refuse their hand.
    const owned = await tasks.create(w.ownerId, {
      title: 'the owner plans against the same lowered budget', projectId: w.projectA,
    } as never);
    assert.equal(owned.projectId, w.projectA);
  });

  await t.test('an automatic acceptance is re-derived when it is spent, not when it was given', async () => {
    const w = await seed('barrier-policy', { a: 'AUTO', b: 'AUTO' });
    const create = () => tasks.create(w.ownerId, {
      title: 'the crossing', projectId: w.projectB, handoff: { reason: 'both ends are automatic' },
    } as never, AGENT(w.ownerId), w.sessionA);
    // Both ends on AUTO: the owner's standing instruction accepts it, and the write goes through.
    const declared = await handoffs.declare(w.ownerId, declarationFor(w), await scopeOf(w), new Date());
    assert.equal(declared.row.state, 'APPROVED');
    assert.equal(declared.row.decidedBy, 'POLICY');

    await barrier.query('BEGIN');
    await barrier.query('SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE', [w.projectB]);
    await barrier.query(
      `UPDATE "project" SET "automation_policy" = 'GUARDED_AUTO'::"project_automation_policy",
        "updated_at" = now() WHERE "id" = $1::uuid`, [w.projectB]);
    const creating = create();
    creating.catch(() => undefined);
    await awaitBlockedBy(barrierPid, 'the crossing parking behind its target');
    await barrier.query('COMMIT');
    const refusal = await refusalOf(() => creating) as { code: string };
    // The instruction was withdrawn between the yes and the spend. An automatic acceptance is a
    // fact about the world right now, so it stops being one the moment the world says otherwise.
    assert.equal(refusal.code, 'CROSS_PROJECT_APPROVAL_REQUIRED');
    assert.deepEqual(
      (await rows(w.ownerId)).map((row) => row.state), ['APPROVED'],
      'the yes was not spent, and nothing was written',
    );
    assert.equal((await tasksIn(w.projectB)).length, 1, 'only the fixture task is there');
  });

  await t.test('a plan takes the owner row before the workspace it names', async () => {
    const w = await seed('barrier-rank');
    await barrier.query('BEGIN');
    // Rank 10, at the strongest mode — what `lockPlanExecutionIdentity` asks for at FOR KEY SHARE
    // conflicts with this, so a create that reaches rank 10 first parks here.
    await barrier.query('SELECT 1 FROM "user" WHERE "id" = $1::uuid FOR UPDATE', [w.ownerId]);
    const creating = tasks.create(w.ownerId, {
      title: 'assigned work', projectId: w.projectA, assigneeId: w.workspaceId,
    } as never, AGENT(w.ownerId), w.sessionA);
    creating.catch(() => undefined);
    await awaitBlockedBy(barrierPid, 'the create parking behind the owner row');
    // The order proof, and the reason a plain "it blocked" would not be one: while it waits at rank
    // 10 it must NOT already hold the rank-15 row. If it took the workspace first, this would
    // block instead of answering — which is exactly the inversion this ordering was added to fix.
    await observer.query('BEGIN');
    await observer.query('SET LOCAL lock_timeout = \'500ms\'');
    await observer.query('SELECT 1 FROM "workspace" WHERE "id" = $1::uuid FOR UPDATE', [w.workspaceId]);
    await observer.query('COMMIT');
    await barrier.query('COMMIT');
    const landed = await creating;
    assert.equal(landed.projectId, w.projectA);
  });

  await t.test('a reopen that commits between the preflight and the write no longer refuses it', async () => {
    const w = await seed('barrier-epoch');
    await barrier.query('BEGIN');
    await reopen(w.projectA);
    // The negative control for what 0229 took: this is the exact interleaving the epoch existed to
    // refuse, run against a fence that no longer has one. The plan still parks behind the project
    // row, still re-reads it after the reopen commits, and finds nothing it claimed has moved.
    const creating = tasks.create(w.ownerId, {
      title: 'planned across a reopen', projectId: w.projectA,
    } as never, AGENT(w.ownerId), w.sessionA);
    creating.catch(() => undefined);
    await awaitBlockedBy(barrierPid, 'the create parking behind the project row');
    await barrier.query('COMMIT');
    const landed = await creating;
    assert.equal(landed.projectId, w.projectA);
    assert.equal((await tasksIn(w.projectA)).length, 2, 'the fixture task and the one it planned');
  });
});

/**
 * [LV] Independent adversarial verification of unit L on real PostgreSQL.
 *
 * Written from scratch by the verification session — it deliberately does NOT import, extend or
 * re-run any of the development units' own specs. Every assertion below is about an observable
 * fact in the database or in the response, never about a log line or a comment.
 *
 * Run:
 *   COORDINATOR_PG_URL=… COORDINATOR_PG_EXPECTED_DATABASE=… COORDINATOR_PG_EXPECTED_USER=… \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=… \
 *   node --test --test-concurrency=1 build/tasks/lv-scope-adversarial.pg.spec.js
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { derivedScopeToken } from '../projects/project-scope-admission';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { ProjectsService } from '../projects/projects.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Two projects, one owner: A is the scope every coordinator write below is authored under. */
interface World {
  ownerId: string;
  projectA: string;
  projectB: string;
  workspaceId: string;
  /** Coordinates A. */
  sessionA: string;
  /** Coordinates B. */
  sessionB: string;
  /** Coordinates nothing and executes nothing — a WORKER with no scope. */
  looseSession: string;
  /** Executes a task filed under A. */
  workerSession: string;
  workerTaskId: string;
}

test('[LV] unit L, adversarially', { skip, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const { prismaClientFor } = await import('../prisma/prisma-client.js');

  const connect = async (): Promise<Client> => {
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await c.connect();
    await verifyCoordinatorPgIdentity(c);
    return c;
  };
  const admin = await connect();
  const prisma: PrismaClient = prismaClientFor(url);

  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  /** A fresh service, as a restarted process would build one: no cached anything. */
  const tasksSvc = (): TasksService =>
    new TasksService(prisma as never, {} as never, { publishTaskChanged: () => undefined } as never);
  const projectsSvc = (): ProjectsService =>
    new ProjectsService(prisma as never, {} as never);

  async function seed(label: string, opts: { policyB?: string } = {}): Promise<World> {
    const w: World = {
      ownerId: randomUUID(),
      projectA: randomUUID(),
      projectB: randomUUID(),
      workspaceId: randomUUID(),
      sessionA: randomUUID(),
      sessionB: randomUUID(),
      looseSession: randomUUID(),
      workerSession: randomUUID(),
      workerTaskId: randomUUID(),
    };
    const runnerId = randomUUID();
    await admin.query(
      `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
      [w.ownerId, `${label}-${w.ownerId}@lv.invalid`, label],
    );
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
    for (const [id, title, policy] of [
      [w.projectA, `${label}-A`, 'GUARDED_AUTO'],
      [w.projectB, `${label}-B`, opts.policyB ?? 'GUARDED_AUTO'],
    ] as const) {
      await admin.query(
        `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","automation_policy","updated_at")
         VALUES ($1,$2,$3,true,$4::"project_automation_policy",now())`,
        [id, w.ownerId, title, policy],
      );
      await admin.query(
        `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
           ON CONFLICT ("project_id") DO NOTHING`,
        [id],
      );
    }
    for (const id of [w.sessionA, w.sessionB, w.looseSession, w.workerSession]) {
      await admin.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
           "provider","status","dispatch_origin","updated_at")
         VALUES ($1,$2,$3,$4,'fixture',$2,'claude','RUNNING'::"run_status",
           'USER'::"session_dispatch_origin",now())`,
        [id, w.ownerId, w.workspaceId, `${label}-session`],
      );
    }
    // The bindings: A's coordinator is sessionA, B's is sessionB.
    await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.projectA, w.sessionA]);
    await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.projectB, w.sessionB]);
    // A task filed under A, executed by workerSession — a WORKER whose derived scope is A.
    await admin.query(
      `INSERT INTO "task" ("id","owner_id","project_id","title","creator_type","creator_id","updated_at")
       VALUES ($1,$2,$3,$4,'USER'::"creator_type",$2,now())`,
      [w.workerTaskId, w.ownerId, w.projectA, `${label}-worker-task`],
    );
    await admin.query('UPDATE "session" SET "task_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.workerSession, w.workerTaskId]);
    return w;
  }

  /** Every task row in a project, by title — the "zero side effects" probe. */
  async function titlesIn(projectId: string): Promise<string[]> {
    const { rows } = await admin.query<{ title: string }>(
      'SELECT "title" FROM "task" WHERE "project_id" = $1::uuid ORDER BY "title"', [projectId]);
    return rows.map((r) => r.title);
  }
  async function taskCount(projectId: string): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM "task" WHERE "project_id" = $1::uuid', [projectId]);
    return Number(rows[0].n);
  }
  /** Tasks that belong to no project at all — the other way a refused write could leak. */
  async function orphanCount(ownerId: string): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM "task" WHERE "owner_id" = $1::uuid AND "project_id" IS NULL',
      [ownerId]);
    return Number(rows[0].n);
  }
  async function handoffRows(ownerId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await admin.query(
      `SELECT "id","state","from_project_id","to_project_id","applied_task_id","decided_by"
         FROM "project_handoff_approval" WHERE "owner_id" = $1::uuid ORDER BY "created_at"`,
      [ownerId]);
    return rows;
  }
  /**
   * Put a project into DONE the way the database insists on: a PASSED acceptance run at this
   * project's current epoch, digested at version 2, bound as `accepted_run_id`. Setting the status
   * by hand is refused by `project_acceptance_done_gate`, which is itself worth knowing.
   */
  async function settle(projectId: string): Promise<string> {
    const runId = randomUUID();
    await admin.query(
      `INSERT INTO "project_acceptance_run"
         ("id","project_id","attempt","criteria_snapshot","criteria_revision","input_digest",
          "result_digest","verdict","decided_by","started_at","completed_at","digest_version",
          "acceptance_epoch")
       SELECT $1::uuid, $2::uuid, 1, '[]'::jsonb, 1, 'lv-input', 'lv-result',
              'PASS'::"project_acceptance_verdict", 'COORDINATOR_AGENT', now(), now(), 2, p."acceptance_epoch"
         FROM "project" p WHERE p."id" = $2::uuid`,
      [runId, projectId]);
    await admin.query(
      `UPDATE "project" SET "status" = 'DONE'::"project_status", "accepted_run_id" = $2::uuid
        WHERE "id" = $1::uuid`, [projectId, runId]);
    const { rows } = await admin.query<{ s: string }>(
      `SELECT "status"::text AS s FROM "project" WHERE "id" = $1::uuid`, [projectId]);
    assert.equal(rows[0].s, 'DONE', 'fixture failed to settle the project');
    return runId;
  }

  async function epochOf(projectId: string): Promise<string> {
    const { rows } = await admin.query<{ e: string }>(
      'SELECT "acceptance_epoch"::text AS e FROM "project" WHERE "id" = $1::uuid', [projectId]);
    return rows[0].e;
  }
  async function generationOf(projectId: string): Promise<string> {
    const { rows } = await admin.query<{ g: string }>(
      'SELECT "coordinator_generation"::text AS g FROM "project_runtime" WHERE "project_id" = $1::uuid',
      [projectId]);
    return rows[0].g;
  }
  /** Refusal body of a thrown Nest exception, whatever shape it carries. */
  function bodyOf(err: unknown): Record<string, unknown> {
    const r = (err as { response?: unknown }).response;
    return (typeof r === 'object' && r !== null ? r : { message: String(err) }) as Record<string, unknown>;
  }
  async function refusal(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      const value = await fn();
      assert.fail(`expected a refusal, got: ${JSON.stringify(value)?.slice(0, 300)}`);
    } catch (err) {
      if (err instanceof assert.AssertionError) throw err;
      assert.ok(
        err instanceof ForbiddenException || err instanceof ConflictException,
        `expected Forbidden/Conflict, got ${(err as Error).name}: ${(err as Error).message}`,
      );
      return bodyOf(err);
    }
  }

  // ===========================================================================================
  // S1  A prompt telling the agent to write into another project.
  // ===========================================================================================
  await t.test('S1 a coordinator told to file into another project is refused, with nothing written',
    async () => {
      const w = await seed('s1');
      const before = { a: await taskCount(w.projectA), b: await taskCount(w.projectB) };

      // (a) create naming B, from A's coordinator — the incident, verbatim.
      const r1 = await refusal(() => tasksSvc().create(
        w.ownerId, { title: 's1-into-B', projectId: w.projectB } as never, undefined, w.sessionA));
      assert.equal(r1.code, 'PROJECT_SCOPE_MISMATCH');
      assert.equal(r1.rule, 'R7_UNDECLARED_CROSSING');
      assert.equal(r1.requiredAction, 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF');
      assert.equal(r1.responsible, 'COORDINATOR');

      // (b) the same write with no project named must NOT silently become B either — it is bound
      //     to A, the scope the server derived. This is the "binding" half of the gate.
      const ok = await tasksSvc().create(
        w.ownerId, { title: 's1-unnamed' } as never, undefined, w.sessionA);
      const { rows } = await admin.query<{ p: string }>(
        'SELECT "project_id"::text AS p FROM "task" WHERE "id" = $1::uuid', [(ok as { id: string }).id]);
      assert.equal(rows[0].p, w.projectA, 'an unnamed coordinator create must bind to its own project');

      // (c) moving an existing task A → B by update.
      const r2 = await refusal(() => tasksSvc().update(
        w.ownerId, w.workerTaskId, { projectId: w.projectB } as never, w.sessionA));
      assert.equal(r2.code, 'PROJECT_SCOPE_MISMATCH');
      assert.equal(r2.rule, 'R7_UNDECLARED_CROSSING');

      // (d) editing a task that lives inside B, without moving it (R6 — the plain trespass).
      const bTask = randomUUID();
      await admin.query(
        `INSERT INTO "task" ("id","owner_id","project_id","title","creator_type","creator_id","updated_at")
         VALUES ($1,$2,$3,'s1-b-native','USER'::"creator_type",$2,now())`,
        [bTask, w.ownerId, w.projectB]);
      const r3 = await refusal(() => tasksSvc().update(
        w.ownerId, bTask, { title: 's1-renamed-by-A' } as never, w.sessionA));
      assert.equal(r3.code, 'PROJECT_SCOPE_MISMATCH');
      assert.equal(r3.rule, 'R6_OUT_OF_SCOPE');
      const { rows: t3 } = await admin.query<{ title: string }>(
        'SELECT "title" FROM "task" WHERE "id" = $1::uuid', [bTask]);
      assert.equal(t3[0].title, 's1-b-native', 'a refused update must not have written the title');

      // Zero side effects: B gained exactly the one row this test inserted by hand, A gained the
      // one legal create, and nothing leaked into "no project".
      assert.equal(await taskCount(w.projectB), before.b + 1);
      assert.equal(await taskCount(w.projectA), before.a + 1);
      assert.equal(await orphanCount(w.ownerId), 0);
      assert.deepEqual(await handoffRows(w.ownerId), [], 'a refusal must not file a crossing');
    });

  // ===========================================================================================
  // S2  Nothing the client says about its own scope is believed; provenance grants nothing.
  // ===========================================================================================
  await t.test('S2 a client cannot name its own scope, and provenance grants no authority', async () => {
    const w = await seed('s2');

    // (a) A forged token naming B's project, presented by A's coordinator.
    const forged = derivedScopeToken({ projectId: w.projectB, generation: '0' });
    const r1 = await refusal(() => tasksSvc().create(
      w.ownerId, { title: 's2-forged', projectId: w.projectB, scopeToken: forged } as never,
      undefined, w.sessionA));
    assert.equal(r1.code, 'COORDINATOR_GENERATION_MOVED', 'a token naming another project is R3');
    assert.equal(r1.rule, 'R3_SCOPE_MOVED');
    assert.equal(r1.requiredAction, 'YIELD_TO_CURRENT_SCOPE');

    // (b) A forged token naming B, aimed at A: still refused. The token is compared, not obeyed —
    //     so it cannot be used to widen OR to redirect.
    const r1b = await refusal(() => tasksSvc().create(
      w.ownerId, { title: 's2-forged-home', scopeToken: forged } as never, undefined, w.sessionA));
    assert.equal(r1b.rule, 'R3_SCOPE_MOVED');

    // (c) A structurally broken token is R2 (retryable), not R3 and not an allow.
    const r2 = await refusal(() => tasksSvc().create(
      w.ownerId, { title: 's2-mangled', scopeToken: `psc:v1:${w.projectA}:not-a-number` } as never,
      undefined, w.sessionA));
    assert.equal(r2.code, 'PROJECT_SCOPE_MISMATCH');
    assert.equal(r2.rule, 'R2_TOKEN_INCONSISTENT');
    assert.equal(r2.requiredAction, 'RE_DERIVE_SCOPE');

    // (d) A WORKER executing a task filed under A may not write into B either — the scope of a
    //     task-bound run is the task's project, not whatever the caller names.
    const r3 = await refusal(() => tasksSvc().create(
      w.ownerId, { title: 's2-worker-into-B', projectId: w.projectB } as never,
      undefined, w.workerSession));
    assert.equal(r3.code, 'PROJECT_SCOPE_MISMATCH');

    // (e) A session that coordinates nothing and executes nothing holds NO scope: it may not pick
    //     a project at all (R5), and it may not file unattributed work under one by accident.
    const r4 = await refusal(() => tasksSvc().create(
      w.ownerId, { title: 's2-loose-into-A', projectId: w.projectA } as never,
      undefined, w.looseSession));
    assert.equal(r4.rule, 'R5_NO_SCOPE');
    assert.equal(r4.code, 'PROJECT_SCOPE_MISMATCH');

    // (f) SC7: provenance is evidence, not authority. The loose session's own create records
    //     discoveredFromProjectId=null; give a session provenance pointing at B by binding it to a
    //     task in B, and the DECISION must still be about the derived scope — here the scope
    //     becomes B legitimately, so instead assert the converse: A's coordinator whose session
    //     row also carries a task in B still writes under A.
    const bTask = randomUUID();
    await admin.query(
      `INSERT INTO "task" ("id","owner_id","project_id","title","creator_type","creator_id","updated_at")
       VALUES ($1,$2,$3,'s2-b-task','USER'::"creator_type",$2,now())`,
      [bTask, w.ownerId, w.projectB]);
    await admin.query('UPDATE "session" SET "task_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.sessionA, bTask]);
    const bound = await tasksSvc().create(
      w.ownerId, { title: 's2-coordinator-wins' } as never, undefined, w.sessionA);
    const { rows } = await admin.query<{ p: string; d: string | null }>(
      `SELECT "project_id"::text AS p, "discovered_from_project_id"::text AS d
         FROM "task" WHERE "id" = $1::uuid`, [(bound as { id: string }).id]);
    assert.equal(rows[0].p, w.projectA, 'coordination binding outranks the executed task');
    // And the write into B this session could now "point at" is still refused.
    const r5 = await refusal(() => tasksSvc().create(
      w.ownerId, { title: 's2-provenance-abuse', projectId: w.projectB } as never,
      undefined, w.sessionA));
    assert.equal(r5.code, 'PROJECT_SCOPE_MISMATCH');

    assert.equal(await taskCount(w.projectB), 1, 'only the hand-inserted row is in B');
    assert.equal(await orphanCount(w.ownerId), 0);
  });

  // ===========================================================================================
  // S3  Concurrent and mixed batches.
  // ===========================================================================================
  await t.test('S3 a batch is all-or-nothing across the boundary, and a replay is one batch',
    async () => {
      const w = await seed('s3');

      // (a) One bad item poisons the whole batch: nothing is written, not even the good items.
      const mixed = {
        tasks: [
          { title: 's3-good-1' },
          { title: 's3-good-2' },
          { title: 's3-bad', projectId: w.projectB },
        ],
      };
      const r = await refusal(() => tasksSvc().createMany(w.ownerId, mixed as never, undefined, w.sessionA));
      assert.equal(r.code, 'PROJECT_SCOPE_MISMATCH');
      assert.deepEqual((await titlesIn(w.projectA)).filter((t) => t.startsWith('s3-good')), [],
        'a refused batch wrote a partial batch');
      assert.equal(await taskCount(w.projectB), 0);
      assert.equal(await orphanCount(w.ownerId), 0);

      // (b) The same batch minus the bad item is written whole, into A.
      const good = { tasks: [{ title: 's3-good-1' }, { title: 's3-good-2' }] };
      const wrote = await tasksSvc().createMany(w.ownerId, good as never, undefined, w.sessionA);
      assert.equal((wrote as unknown[]).length, 2);
      assert.deepEqual((await titlesIn(w.projectA)).filter((t) => t.startsWith('s3-good')),
        ['s3-good-1', 's3-good-2']);

      // (c) Two concurrent identical batches inside one live turn: the idempotency winner makes it
      //     one set of tasks, not two. Without a turn there is no key, so open one.
      const w2 = await seed('s3b');
      const turnId = randomUUID();
      await admin.query(
        `INSERT INTO "conversation_turn" ("id","session_id","seq","client_turn_id","kind","status")
         VALUES ($1,$2,1,$3,'message','IN_FLIGHT')`,
        [turnId, w2.sessionA, `lv-${turnId}`]);
      const dto = { tasks: [{ title: 's3-replayed' }] };
      const [x, y] = await Promise.all([
        tasksSvc().createMany(w2.ownerId, dto as never, undefined, w2.sessionA),
        tasksSvc().createMany(w2.ownerId, dto as never, undefined, w2.sessionA),
      ]);
      assert.deepEqual((await titlesIn(w2.projectA)).filter((t) => t === 's3-replayed'),
        ['s3-replayed'], 'a concurrent replay of one batch created two tasks');
      const idX = (x as Array<{ id: string }>)[0].id;
      const idY = (y as Array<{ id: string }>)[0].id;
      assert.equal(idX, idY, 'the two replays returned different rows');
    });

  // ===========================================================================================
  // S4  Coordinator rotation.
  // ===========================================================================================
  await t.test('S4 a rotated-away scope cannot write, and the successor can', async () => {
    const w = await seed('s4');
    assert.equal(await generationOf(w.projectA), '0');

    // Rotate A's coordination to a brand new session and bump the generation, exactly as a
    // rotation does.
    const successor = randomUUID();
    await admin.query(
      `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
         "provider","status","dispatch_origin","updated_at")
       VALUES ($1,$2,$3,'s4-successor','fixture',$2,'claude','RUNNING'::"run_status",
         'USER'::"session_dispatch_origin",now())`,
      [successor, w.ownerId, w.workspaceId]);
    await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
      [w.projectA, successor]);
    // Rebinding the coordinator IS the rotation: the generation is advanced by the database, not
    // by this fixture. Asserting that it moved at all is part of what S4 is checking.
    const gen1 = await generationOf(w.projectA);
    assert.notEqual(gen1, '0', 'rebinding the coordinator did not advance the generation');

    // The old session holds no binding any more: it is a WORKER with no scope, refused by R5.
    const r = await refusal(() => tasksSvc().create(
      w.ownerId, { title: 's4-from-rotated-away', projectId: w.projectA } as never, undefined, w.sessionA));
    assert.equal(r.code, 'PROJECT_SCOPE_MISMATCH');
    assert.equal(r.rule, 'R5_NO_SCOPE');
    assert.equal(r.requiredAction, 'YIELD_TO_CURRENT_SCOPE');

    // A token minted before the rotation is refused as a takeover, not as a mismatch.
    const stale = derivedScopeToken({ projectId: w.projectA, generation: '0' });
    const r3 = await refusal(() => tasksSvc().create(
      w.ownerId, { title: 's4-stale-token-2', projectId: w.projectA, scopeToken: stale } as never,
      undefined, successor));
    assert.equal(r3.code, 'COORDINATOR_GENERATION_MOVED');
    assert.equal(r3.rule, 'R3_SCOPE_MOVED');

    // The successor, presenting the CURRENT token, writes normally.
    const fresh = derivedScopeToken({ projectId: w.projectA, generation: gen1 });
    const ok = await tasksSvc().create(
      w.ownerId, { title: 's4-successor-writes', scopeToken: fresh } as never, undefined, successor);
    assert.ok((ok as { id: string }).id);
    assert.deepEqual(await titlesIn(w.projectA), ['s4-successor-writes', 's4-worker-task'].sort());
    assert.equal(await generationOf(w.projectA), gen1, 'a write moved the generation');
  });

  // ===========================================================================================
  // S5  A restart re-derives; nothing is cached across it.
  // ===========================================================================================
  await t.test('S5 a fresh process derives the same answer, and a rotation during downtime is seen',
    async () => {
      const w = await seed('s5');
      // "Before the restart": this service instance has already decided one write.
      const svcBefore = tasksSvc();
      await svcBefore.create(w.ownerId, { title: 's5-before' } as never, undefined, w.sessionA);

      // Rotate while "the service is down".
      const successor = randomUUID();
      await admin.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
           "provider","status","dispatch_origin","updated_at")
         VALUES ($1,$2,$3,'s5-successor','fixture',$2,'claude','RUNNING'::"run_status",
           'USER'::"session_dispatch_origin",now())`,
        [successor, w.ownerId, w.workspaceId]);
      await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
        [w.projectA, successor]);

      // The SAME long-lived instance must already refuse — nothing is cached even without a restart.
      const rLive = await refusal(() => svcBefore.create(
        w.ownerId, { title: 's5-after-live', projectId: w.projectA } as never, undefined, w.sessionA));
      assert.equal(rLive.rule, 'R5_NO_SCOPE');

      // And a brand new instance, as a restarted process builds one, agrees.
      const rFresh = await refusal(() => tasksSvc().create(
        w.ownerId, { title: 's5-after-fresh', projectId: w.projectA } as never, undefined, w.sessionA));
      assert.equal(rFresh.rule, 'R5_NO_SCOPE');
      assert.deepEqual(await titlesIn(w.projectA), ['s5-before', 's5-worker-task'].sort());

      // Pinned deliberately, because it is the one write a scope-less session still makes: a create
      // that names NO project is off the ownership surface entirely (§2), so it lands as a task
      // belonging to no goal rather than being refused. It attributes nothing to anybody, which is
      // why the contract leaves it alone — but it is a behaviour a reader should not have to guess.
      const orphan = await tasksSvc().create(
        w.ownerId, { title: 's5-unattributed' } as never, undefined, w.sessionA);
      const { rows: o } = await admin.query<{ p: string | null }>(
        'SELECT "project_id"::text AS p FROM "task" WHERE "id" = $1::uuid',
        [(orphan as { id: string }).id]);
      assert.equal(o[0].p, null, 'a scope-less create silently acquired a project');
    });

  // ===========================================================================================
  // S6  Old clients (§8 CM1): absent token buys nothing and is refused, not waved through.
  // ===========================================================================================
  await t.test('S6 a client too old to carry a token is refused, not admitted', async () => {
    const w = await seed('s6');
    // No scopeToken at all, aiming at B.
    const r = await refusal(() => tasksSvc().create(
      w.ownerId, { title: 's6-old-client', projectId: w.projectB } as never, undefined, w.sessionA));
    assert.equal(r.code, 'PROJECT_SCOPE_MISMATCH');
    assert.equal(r.rule, 'R7_UNDECLARED_CROSSING');
    assert.equal(await taskCount(w.projectB), 0);

    // An old client's write INSIDE its own scope is untouched — the compatibility half.
    const ok = await tasksSvc().create(w.ownerId, { title: 's6-old-at-home' } as never, undefined, w.sessionA);
    assert.ok((ok as { id: string }).id);

    // A declared crossing from a client with no scope is not a way in either.
    const r2 = await refusal(() => tasksSvc().create(
      w.ownerId, { title: 's6-loose-declares', projectId: w.projectB, handoff: { reason: 'x' } } as never,
      undefined, w.looseSession));
    assert.equal(r2.rule, 'R5_NO_SCOPE');
    assert.deepEqual(await handoffRows(w.ownerId), [], 'a scope-less declaration filed a question');
  });

  // ===========================================================================================
  // S7  Declared crossings, and their replay.
  // ===========================================================================================
  await t.test('S7 a declared crossing asks once, is spent once, and cannot be re-aimed', async () => {
    const w = await seed('s7');
    const svc = tasksSvc();

    // (a) Declaring files exactly one question and writes no task.
    const r1 = await refusal(() => svc.create(
      w.ownerId, { title: 's7-crossing', projectId: w.projectB, handoff: { reason: 'needs B' } } as never,
      undefined, w.sessionA));
    // R10 files the question and the decision is then re-run against it, so what the caller is
    // told is R11 — there IS an answer pending now, which is a different fact from "nobody asked".
    assert.equal(r1.code, 'APPROVAL_PENDING');
    assert.equal(r1.rule, 'R11_APPROVAL_PENDING');
    assert.equal(r1.requiredAction, 'AWAIT_HANDOFF_APPROVAL');
    let rows = await handoffRows(w.ownerId);
    assert.equal(rows.length, 1, 'a declaration must file exactly one question');
    assert.equal(rows[0].state, 'PENDING');
    assert.equal(await taskCount(w.projectB), 0, 'a pending crossing wrote a task');

    // (b) Declaring the identical crossing again does not file a second question.
    await refusal(() => svc.create(
      w.ownerId, { title: 's7-crossing', projectId: w.projectB, handoff: { reason: 'needs B' } } as never,
      undefined, w.sessionA));
    rows = await handoffRows(w.ownerId);
    assert.equal(rows.length, 1, 'a re-declaration filed a duplicate question');
    const handoffId = rows[0].id as string;

    // (c) A PENDING yes is not a yes.
    const r2 = await refusal(() => svc.create(
      w.ownerId, { title: 's7-crossing', projectId: w.projectB, handoff: { reason: 'needs B' } } as never,
      undefined, w.sessionA));
    assert.equal(r2.code, 'APPROVAL_PENDING', 'a PENDING answer was treated as a yes');

    // (d) The user approves. Now the identical write lands — in B, once.
    const handoffs = new ProjectHandoffService(prisma as never);
    await handoffs.decide(w.ownerId, w.ownerId, handoffId, 'APPROVE', new Date());
    const landed = await svc.create(
      w.ownerId, { title: 's7-crossing', projectId: w.projectB, handoff: { reason: 'needs B' } } as never,
      undefined, w.sessionA);
    const landedId = (landed as { id: string }).id;
    assert.equal(await taskCount(w.projectB), 1);
    rows = await handoffRows(w.ownerId);
    assert.equal(rows[0].state, 'APPLIED');
    assert.equal(rows[0].applied_task_id, landedId, 'the yes was not stamped with the task it bought');

    // (e) REPLAY: the same approved crossing spent a second time must not buy a second task.
    let replayed: unknown;
    let replayError: unknown;
    try { replayed = await svc.create(
      w.ownerId, { title: 's7-crossing', projectId: w.projectB, handoff: { reason: 'needs B' } } as never,
      undefined, w.sessionA); } catch (e) { replayError = e; }
    assert.equal(await taskCount(w.projectB), 1,
      `a replayed approved crossing wrote a second task (returned ${JSON.stringify(replayed)?.slice(0, 200)}, threw ${(replayError as Error)?.message})`);

    // (f) The same yes re-aimed at a DIFFERENT plan must not be spendable.
    const r3 = await refusal(() => svc.create(
      w.ownerId, { title: 's7-different-plan', projectId: w.projectB, handoff: { reason: 'needs B' } } as never,
      undefined, w.sessionA));
    assert.ok(r3.code === 'CROSS_PROJECT_APPROVAL_REQUIRED' || r3.code === 'APPROVAL_PENDING',
      `a different plan reused the first yes: ${JSON.stringify(r3).slice(0, 300)}`);
    assert.equal(await taskCount(w.projectB), 1);

    // (g) Directly re-spending the APPLIED row on another task is refused at the CAS.
    const otherTask = randomUUID();
    await admin.query(
      `INSERT INTO "task" ("id","owner_id","project_id","title","creator_type","creator_id","updated_at")
       VALUES ($1,$2,$3,'s7-victim','USER'::"creator_type",$2,now())`,
      [otherTask, w.ownerId, w.projectA]);
    const authority = handoffs.authorityOf(w.ownerId, {
      fromProjectId: w.projectA, toProjectId: w.projectB, kind: 'FILE_TASK', subjectTaskId: null,
      identity: { plan: {}, source: {} } as never, title: 's7-crossing', reason: 'needs B',
      requestedBySessionId: w.sessionA,
    } as never);
    await assert.rejects(
      () => (prisma as never as { $transaction: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown> })
        .$transaction((tx) => handoffs.spend(tx as never, authority, handoffId, otherTask, new Date())),
      'an APPLIED yes was re-spent on another task');
  });

  // ===========================================================================================
  // S8  A settled project, and the reopen that has to be acknowledged.
  // ===========================================================================================
  await t.test('S8 a settled project refuses new work; the reopen is a compare-and-set', async () => {
    const w = await seed('s8');
    await settle(w.projectA);
    const epoch0 = await epochOf(w.projectA);

    // (a) Its own coordinator may not file new work into it.
    const r = await refusal(() => tasksSvc().create(
      w.ownerId, { title: 's8-into-done' } as never, undefined, w.sessionA));
    assert.equal(r.code, 'PROJECT_REOPEN_REQUIRED');
    assert.equal(r.rule, 'R8_SETTLED_PROJECT');
    assert.equal(r.requiredAction, 'REOPEN_PROJECT_FIRST');
    assert.equal(await taskCount(w.projectA), 1, 'only the seeded worker task');

    // (b) A stale acknowledgement is refused and moves nothing.
    const projects = projectsSvc();
    const stale = String(BigInt(epoch0) + 7n);
    const bad = await refusal(() => projects.reopen(w.ownerId, w.projectA,
      { acknowledgedAcceptanceEpoch: stale } as never));
    assert.equal(bad.code, 'REOPEN_ACKNOWLEDGEMENT_STALE');
    assert.equal(await epochOf(w.projectA), epoch0, 'a refused reopen advanced the epoch');
    const { rows: st } = await admin.query<{ s: string }>(
      `SELECT "status"::text AS s FROM "project" WHERE "id" = $1::uuid`, [w.projectA]);
    assert.equal(st[0].s, 'DONE', 'a refused reopen changed the status');

    // (c) The acknowledgement the preview hands back is accepted, and the epoch advances.
    const preview = await projects.reopenPreview(w.ownerId, w.projectA);
    assert.equal((preview as { fromEpoch: string }).fromEpoch, epoch0);
    await projects.reopen(w.ownerId, w.projectA,
      { acknowledgedAcceptanceEpoch: (preview as { fromEpoch: string }).fromEpoch } as never);
    const epoch1 = await epochOf(w.projectA);
    assert.equal(epoch1, String(BigInt(epoch0) + 1n), 'a reopen did not start a new acceptance epoch');

    // (d) Replaying the SAME acknowledgement must not reopen twice.
    const again = await refusal(() => projects.reopen(w.ownerId, w.projectA,
      { acknowledgedAcceptanceEpoch: epoch0 } as never));
    assert.ok(['PROJECT_NOT_SETTLED', 'REOPEN_ACKNOWLEDGEMENT_STALE'].includes(again.code as string),
      `unexpected replay code ${String(again.code)}`);
    assert.equal(await epochOf(w.projectA), epoch1, 'a replayed reopen advanced the epoch again');

    // (e) After the reopen, the coordinator's ordinary write works again.
    const ok = await tasksSvc().create(w.ownerId, { title: 's8-after-reopen' } as never, undefined, w.sessionA);
    assert.ok((ok as { id: string }).id);

    // (f) The PASS the project was DONE against is retired, not rewritten: its verdict still says
    //     PASS and the epoch it passed in is still the old one — what changed is that it is
    //     superseded and the project has moved past it. Both are what stops it being reused.
    const { rows: run } = await admin.query<{
      verdict: string; epoch: string; superseded: string | null; reason: string | null;
    }>(`SELECT "verdict"::text AS verdict, "acceptance_epoch"::text AS epoch,
               "superseded_at"::text AS superseded, "superseded_reason" AS reason
          FROM "project_acceptance_run" WHERE "project_id" = $1::uuid`, [w.projectA]);
    assert.equal(run[0].verdict, 'PASS', 'the historical verdict was rewritten');
    assert.equal(run[0].epoch, epoch0, 'the epoch the run passed in was rewritten');
    assert.ok(run[0].superseded, 'a reopen left the old acceptance run current');
    assert.equal(run[0].reason, 'reopened_by_user');

    // (g) And it can no longer carry the project back to DONE: the database itself refuses.
    await assert.rejects(
      () => admin.query(
        `UPDATE "project" SET "status" = 'DONE'::"project_status" WHERE "id" = $1::uuid`,
        [w.projectA]),
      /ACCEPTANCE_/,
      'a reopened project went back to DONE on a retired PASS');
  });

  await t.test('S8b two concurrent reopens produce one epoch advance', async () => {
    const w = await seed('s8b');
    await settle(w.projectA);
    const epoch0 = await epochOf(w.projectA);
    const results = await Promise.allSettled([
      projectsSvc().reopen(w.ownerId, w.projectA, { acknowledgedAcceptanceEpoch: epoch0 } as never),
      projectsSvc().reopen(w.ownerId, w.projectA, { acknowledgedAcceptanceEpoch: epoch0 } as never),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(await epochOf(w.projectA), String(BigInt(epoch0) + 1n),
      `two concurrent reopens advanced the epoch more than once (${won} succeeded)`);
  });

  // ===========================================================================================
  // S9  Acceptance history and session outcomes are never rewritten by any of the above.
  // ===========================================================================================
  await t.test('S9 a refusal rewrites no acceptance record and no session outcome', async () => {
    const w = await seed('s9');
    // Give A a settled acceptance run and a finished session, then attack it.
    const runId = await settle(w.projectA);
    const before = await admin.query(
      `SELECT * FROM "project_acceptance_run" WHERE "id" = $1::uuid`, [runId]);
    await admin.query(
      `UPDATE "session" SET "status" = 'SUCCEEDED'::"run_status", "end_reason" = 'task_done'
        WHERE "id" = $1::uuid`, [w.workerSession]);

    // Every refusal shape, one after another, from the wrong scope.
    for (const dto of [
      { title: 's9-a', projectId: w.projectB },
      { title: 's9-b', projectId: w.projectB, handoff: { reason: 'r' } },
      { title: 's9-c', scopeToken: 'psc:v1:bogus' },
    ]) {
      await refusal(() => tasksSvc().create(w.ownerId, dto as never, undefined, w.sessionA))
        .catch(() => undefined);
    }
    const after = await admin.query(
      `SELECT * FROM "project_acceptance_run" WHERE "id" = $1::uuid`, [runId]);
    assert.deepEqual(after.rows[0], before.rows[0], 'an acceptance record was rewritten');
    const { rows: s } = await admin.query<{ status: string; end_reason: string | null }>(
      `SELECT "status"::text AS status, "end_reason" FROM "session" WHERE "id" = $1::uuid`,
      [w.workerSession]);
    assert.equal(s[0].status, 'SUCCEEDED', 'a session outcome was rewritten');
    assert.equal(s[0].end_reason, 'task_done');
  });


  // ===========================================================================================
  // S11  The window between deciding and writing: a rotation that commits inside it.
  // ===========================================================================================
  await t.test('S11 a rotation that commits between admission and INSERT is not written past',
    async () => {
      const w = await seed('s11');
      // A second connection holds the project row so the write parks behind it, and the rotation
      // is committed while it waits. Two linearizations are legal and both are asserted.
      const rotator = await connect();
      const successor = randomUUID();
      await admin.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
           "provider","status","dispatch_origin","updated_at")
         VALUES ($1,$2,$3,'s11-successor','fixture',$2,'claude','RUNNING'::"run_status",
           'USER'::"session_dispatch_origin",now())`,
        [successor, w.ownerId, w.workspaceId]);

      await rotator.query('BEGIN');
      await rotator.query(
        'SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE', [w.projectA]);

      // Start the write. Its admission reads an unlocked world (scope = A, generation 0) and
      // allows; its transaction then parks on the project row the rotator is holding.
      const writing = tasksSvc().create(
        w.ownerId, { title: 's11-raced' } as never, undefined, w.sessionA)
        .then(() => 'wrote' as const)
        .catch((e) => (e instanceof ForbiddenException || e instanceof ConflictException
          ? bodyOf(e) : Promise.reject(e)));

      // Wait until it is actually blocked on that row, then rotate and commit.
      const deadline = Date.now() + 30_000;
      for (;;) {
        const { rows } = await admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active' AND datname = current_database()`);
        if (Number(rows[0].n) > 0) break;
        assert.ok(Date.now() < deadline, 'the write never parked on the project row');
        await new Promise((r) => setTimeout(r, 5));
      }
      await rotator.query(
        'UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
        [w.projectA, successor]);
      await rotator.query('COMMIT');
      await rotator.end();

      const result = await writing;
      const landed = (await titlesIn(w.projectA)).includes('s11-raced');
      if (result === 'wrote') {
        assert.ok(landed, 'the write reported success and left no row');
      } else {
        assert.equal((result as Record<string, unknown>).code, 'COORDINATOR_GENERATION_MOVED',
          `a rotation-losing write refused with the wrong code: ${JSON.stringify(result)}`);
        assert.equal((result as Record<string, unknown>).requiredAction, 'YIELD_TO_CURRENT_SCOPE');
        assert.equal(landed, false, 'a refused write left a row behind');
      }
    });

  // ===========================================================================================
  // S12  The approval is a compare-and-set, exercised on the real row with the real digest.
  // ===========================================================================================
  await t.test('S12 an approved crossing is spendable exactly once', async () => {
    const w = await seed('s12');
    const handoffs = new ProjectHandoffService(prisma as never);
    const now = new Date();
    // The declaration a coordinator of A would make. Its source evidence has to be exactly what
    // the server would derive, or `declare` refuses it — which is itself the point of this shape.
    const declaration = {
      fromProjectId: w.projectA,
      toProjectId: w.projectB,
      kind: 'FILE_TASK',
      subjectTaskId: null,
      identity: {
        plan: { title: 's12-plan' },
        source: {
          projectId: w.projectA, taskId: null, sessionId: w.sessionA,
          triggerEvent: 'coordinator.session_filed',
        },
      },
      title: 's12-plan',
      reason: 'lv',
      requestedBySessionId: w.sessionA,
    };
    const authority = handoffs.authorityOf(w.ownerId, declaration as never);
    const filed = await handoffs.declare(
      w.ownerId, declaration as never, { projectId: w.projectA, generation: '0' } as never, now);
    const handoffId = (filed as { row: { id: string } }).row.id;
    await handoffs.decide(w.ownerId, w.ownerId, handoffId, 'APPROVE', new Date());

    const first = randomUUID();
    const second = randomUUID();
    for (const [id, title] of [[first, 's12-first'], [second, 's12-second']] as const) {
      await admin.query(
        `INSERT INTO "task" ("id","owner_id","project_id","title","creator_type","creator_id","updated_at")
         VALUES ($1,$2,$3,$4,'USER'::"creator_type",$2,now())`,
        [id, w.ownerId, w.projectB, title]);
    }
    const tx = prisma as never as {
      $transaction: <T>(f: (tx: unknown) => Promise<T>) => Promise<T>;
    };
    // First spend: the yes is stamped with the task it bought.
    await tx.$transaction((c) => handoffs.spend(c as never, authority, handoffId, first, new Date()));
    const { rows: after1 } = await admin.query<{ state: string; applied: string | null }>(
      `SELECT "state", "applied_task_id"::text AS applied FROM "project_handoff_approval"
        WHERE "id" = $1::uuid`, [handoffId]);
    assert.equal(after1[0].state, 'APPLIED');
    assert.equal(after1[0].applied, first);

    // Replay of the SAME spend is a no-op that succeeds — a lost response must not be an error.
    await tx.$transaction((c) => handoffs.spend(c as never, authority, handoffId, first, new Date()));

    // The same yes spent on ANOTHER task is refused, and the stamp does not move.
    await assert.rejects(
      () => tx.$transaction((c) => handoffs.spend(c as never, authority, handoffId, second, new Date())),
      (e: unknown) => e instanceof ConflictException,
      'a spent approval bought a second task');
    const { rows: after2 } = await admin.query<{ applied: string | null }>(
      `SELECT "applied_task_id"::text AS applied FROM "project_handoff_approval"
        WHERE "id" = $1::uuid`, [handoffId]);
    assert.equal(after2[0].applied, first, 'the spent stamp was moved to another task');
  });


  // ===========================================================================================
  // S13  A task that slipped past creation: does anything refuse to RUN it?
  //
  // The third of unit L's three layers ("创建、恢复、调度"). A task filed into project B by a
  // coordinator of A — written straight to the row, exactly as one written before this unit
  // existed would be — and then started through the ordinary run door.
  // ===========================================================================================
  await t.test('S13 a mis-attributed task is refused at the moment it is started', {
    // Red on `main` as of 0a3cb3c8, and deliberately not red by default: unit L6 — the run-time
    // attribution gate — lives on `orbit/l6-c5efc9` and has not landed. Run with
    // LV_EXPECT_DISPATCH_GATE=1 to see exactly what the run door does with a mis-filed task
    // today. It should be switched on (this skip removed) by whatever lands L6.
    skip: process.env.LV_EXPECT_DISPATCH_GATE
      ? false
      : 'the run-time attribution gate (unit L6) is not on this branch — set '
        + 'LV_EXPECT_DISPATCH_GATE=1 to assert it',
  }, async () => {
    const w = await seed('s13');
    // The mis-filed row: it lives in B, and the session that authored it coordinates A.
    const bad = randomUUID();
    await admin.query(
      `INSERT INTO "task" ("id","owner_id","project_id","title","creator_type","creator_id",
         "creator_session_id","assignee_id","discovered_from_project_id","source_session_id",
         "trigger_event","provider","updated_at")
       VALUES ($1,$2,$3,'s13-misfiled','AGENT'::"creator_type",$4,$5,$4,$6,$5,
         'coordinator.session_filed','claude',now())`,
      [bad, w.ownerId, w.projectB, w.workspaceId, w.sessionA, w.projectA]);
    const { rows: check } = await admin.query<{ p: string; d: string }>(
      `SELECT "project_id"::text AS p, "discovered_from_project_id"::text AS d
         FROM "task" WHERE "id" = $1::uuid`, [bad]);
    assert.equal(check[0].p, w.projectB, 'fixture: the task must be filed in B');
    assert.equal(check[0].d, w.projectA, 'fixture: it must record that it was authored from A');

    let answer: string;
    try {
      await tasksSvc().execute(w.ownerId, bad);
      answer = 'the run door started it';
    } catch (err) {
      answer = `${(err as Error).name}: ${(err as Error).message}`.slice(0, 160);
    }
    // Corroboration, so the verdict does not rest on one exception message: nothing filed an
    // attribution blocker about this task either, and the run got far enough to reach the lease.
    const { rows: blockers } = await admin.query<{ kind: string }>(
      `SELECT "kind" FROM "project_blocker"
        WHERE "project_id" IN ($1::uuid, $2::uuid) AND "resolved_at" IS NULL`,
      [w.projectA, w.projectB]);
    const { rows: attempt } = await admin.query<{ n: string }>(
      `SELECT "dispatch_attempt"::text AS n FROM "task" WHERE "id" = $1::uuid`, [bad]);

    // A run refused on ATTRIBUTION grounds is what unit L's third layer promises. Any other
    // outcome — including one stopped only by this test's stubbed session factory, which is what
    // `TypeError: this.sessions.create is not a function` means — is the gate not being there.
    assert.ok(
      /scope|attribut|ownership|belongs|PROJECT_/i.test(answer),
      'the run door did not refuse a task whose authoring scope (project A) and owning project '
      + `(project B) disagree.\n  run door answered : ${answer}`
      + `\n  open blockers     : ${blockers.map((b) => b.kind).join(',') || 'none'}`
      + `\n  dispatch_attempt  : ${attempt[0]?.n}`,
    );
  });

  // ===========================================================================================
  // S10  The user is never refused (§4 R1) — the "no false positives" half.
  // ===========================================================================================
  await t.test('S10 the owner acting directly is exempt, in both projects', async () => {
    const w = await seed('s10');
    const svc = tasksSvc();
    // No acting session at all = the user API.
    const a = await svc.create(w.ownerId, { title: 's10-user-A', projectId: w.projectA } as never);
    const b = await svc.create(w.ownerId, { title: 's10-user-B', projectId: w.projectB } as never);
    assert.ok((a as { id: string }).id && (b as { id: string }).id);
    // And the user may move work across projects with no approval at all.
    const moved = await svc.update(w.ownerId, (a as { id: string }).id, { projectId: w.projectB } as never);
    assert.ok(moved);
    const { rows } = await admin.query<{ p: string }>(
      'SELECT "project_id"::text AS p FROM "task" WHERE "id" = $1::uuid', [(a as { id: string }).id]);
    assert.equal(rows[0].p, w.projectB, 'the owner was refused a move they are entitled to');
    // A settled project still refuses the coordinator but not the owner.
    await settle(w.projectB);
    const c = await svc.create(w.ownerId, { title: 's10-user-into-done', projectId: w.projectB } as never);
    assert.ok((c as { id: string }).id, 'the owner was refused a write into their own settled project');
  });
});

/**
 * The barriers behind §8.6 LO1, each run TWICE against TWO databases: once in the lock order the
 * code took before this change, against a schema WITHOUT migration 0134 (which must deadlock, or
 * the barrier is proving nothing), and once in LO1's order — sorted project → the whole task
 * closure in id order → the affected sessions — against the migrated schema, which must not.
 *
 * A one-sided fixture is the failure mode this shape exists to avoid, and it has two halves that
 * both had to be closed here:
 *
 *   * running the "old order" against a database that already has 0134's guards proves only that
 *     the guards fire — the deadlock it was meant to reproduce has already been converted into a
 *     typed refusal. So `PG_URL_BASELINE` points at a schema with the three 0134 triggers dropped;
 *   * driving both sides to the end of their statements and only THEN committing makes the harness
 *     itself the deadlock: whichever side finishes first keeps its locks until the other is done,
 *     so an ordinary blocking wait reads as a `57014`. Each side now commits as soon as its own
 *     statements are through, which is what a request does.
 *
 *   PG_URL=... PG_URL_BASELINE=... SEED_SQL=/path/seed.sql node tools/lock-order/barriers.mjs [--only <name>]
 *
 * Exit status is the verdict: 0 when every barrier deadlocked on the baseline and came out clean
 * under LO1, 1 otherwise, with the offending line marked FAIL.
 */
import { Client } from 'pg';
import { readFileSync } from 'node:fs';

const URL = process.env.PG_URL;
const BASELINE = process.env.PG_URL_BASELINE ?? URL;
const SEED = readFileSync(process.env.SEED_SQL, 'utf8');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

const OWNER = '00000000-0000-4000-8000-000000000001';
const COORD = '00000000-0000-4000-8000-0000000000c1';
const P     = '00000000-0000-4000-8000-000000000003';
const L1    = '00000000-0000-4000-8000-0000000000a1';
const H2    = '00000000-0000-4000-8000-0000000000a2';
const H3X   = '00000000-0000-4000-8000-0000000000a3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const conn = async (name, url = URL) => {
  const c = new Client({ connectionString: url, application_name: name });
  await c.connect();
  // Long enough that a genuine wait is not mistaken for a deadlock, short enough that a mutual wait
  // PostgreSQL's detector cannot see (two waiters on different resources) still ends the run.
  await c.query(`SET statement_timeout = '8s'`);
  return c;
};
const code = (e) => (e ? (e.code ?? '?') : null);
const fmt = (e) => (e ? `${e.code ?? '?'} ${String(e.message).split('\n')[0].slice(0, 90)}` : 'ok');

/** LO1, as the statements a caller following it actually emits. */
const lockProject = (id) => [`SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE`, [id]];
const lockTasks = (ids) => [
  `SELECT "id" FROM "task" WHERE "id" = ANY($1::uuid[]) AND "owner_id" = $2::uuid
    ORDER BY "id" FOR UPDATE`, [ids.slice().sort(), OWNER]];
const lockSessions = (taskIds) => [
  `SELECT s."id" FROM "session" s
    WHERE s."owner_id" = $2::uuid
      AND (s."task_id" = ANY($1::uuid[]) OR s."context_task_id" = ANY($1::uuid[]))
    ORDER BY s."id" FOR UPDATE`, [taskIds.slice().sort(), OWNER]];

async function reseed(setup, url) {
  const s = await conn('h3-setup', url);
  await s.query(`TRUNCATE "user", "workspace", "project", "task", "session", "task_dependency",
                          "project_event", "project_acceptance_run", "project_acceptance_audit"
                 RESTART IDENTITY CASCADE`);
  await s.query(SEED);
  if (setup) await s.query(setup);
  await s.end();
}

async function race(name, setup, aSteps, bSteps, url) {
  await reseed(setup, url);
  const a = await conn(`h3-A-${name}`, url), b = await conn(`h3-B-${name}`, url);
  const errs = {};
  // BEGIN, the steps, and COMMIT are ONE unit per side. Holding a finished transaction open until
  // the other side is also finished is not what a request does, and it turns every ordinary
  // blocking wait into a mutual one — the harness manufacturing the outcome it is measuring.
  const drive = async (c, steps, key) => {
    try {
      await c.query('BEGIN');
      for (const [sql, params, pause] of steps) {
        if (pause) await sleep(pause);
        await c.query(sql, params ?? []);
      }
      await c.query('COMMIT');
    } catch (e) {
      errs[key] = e;
      await c.query('ROLLBACK').catch(() => {});
    }
  };
  await Promise.all([drive(a, aSteps, 'a'), drive(b, bSteps, 'b')]);
  await a.end(); await b.end();
  return errs;
}

/**
 * A barrier is only evidence if BOTH sides of it were checked. `legacy` must produce a real
 * contention outcome — `40P01` (a deadlock PostgreSQL detected) or `57014` (a mutual wait it could
 * not see, broken by the statement timeout). `lo1` must produce either two clean commits or one of
 * the TYPED refusals the guards raise, which is a legal serialization and not a 500.
 */
const CONTENDED = new Set(['40P01', '57014']);
const TYPED = /TASK_FACT_PROJECT_BUSY|TASK_DEPENDENCY_PROJECT_BUSY|TASK_DEPENDENCY_TASK_BUSY|TASK_SUPERSESSION_PROJECT_BUSY|TASK_AGGREGATE_[A-Z_]*BUSY|SESSION_[A-Z_]*BUSY/;
const acceptable = (e) => !e || (e.code === '55P03' || TYPED.test(String(e.message)));

let failures = 0;
async function barrier({ name, setup, legacy, lo1 }) {
  if (only && !name.includes(only)) return;
  const bad = await race(`${name}-legacy`, setup, legacy.a, legacy.b, BASELINE);
  const good = await race(`${name}-lo1`, setup, lo1.a, lo1.b, URL);
  const reproduced = CONTENDED.has(code(bad.a)) || CONTENDED.has(code(bad.b));
  const repaired = acceptable(good.a) && acceptable(good.b);
  const verdict = reproduced && repaired ? 'PASS' : 'FAIL';
  if (verdict === 'FAIL') failures += 1;
  console.log(`${verdict} ${name}`);
  console.log(`       legacy: A=${fmt(bad.a)} | B=${fmt(bad.b)}`);
  console.log(`       lo1   : A=${fmt(good.a)} | B=${fmt(good.b)}`);
}

// -------------------------------------------------------------------------------------------
// 1. A pure status PATCH takes NO project lock in the old code; its AFTER trigger reaches for one
//    while it already holds the task. The Coordinator holds project-then-task. That is the cycle.
// -------------------------------------------------------------------------------------------
await barrier({
  name: 'status-PATCH vs coordinator',
  legacy: {
    a: [[`SELECT 1 FROM "task" WHERE "id" = $1::uuid FOR UPDATE`, [L1]],
        [`UPDATE "task" SET "status" = 'DONE', "updated_at" = now() WHERE "id" = $1::uuid`, [L1], 300]],
    b: [lockProject(P), [...lockTasks([L1]), 150]],
  },
  lo1: {
    a: [lockProject(P), lockTasks([L1]),
        [`UPDATE "task" SET "status" = 'DONE', "updated_at" = now() WHERE "id" = $1::uuid`, [L1], 300]],
    b: [lockProject(P), [...lockTasks([L1]), 150]],
  },
});

// -------------------------------------------------------------------------------------------
// 2. Deleting a SUBJECT cascades its verifiers away; every cascaded row reaches for its project
//    from an AFTER DELETE with the task already held. Authorization holds project-then-task.
//    LO1's answer is the CLOSURE: the verifier is locked too, not just the named subject.
// -------------------------------------------------------------------------------------------
const verifierSetup = `UPDATE "task" SET "verifies_task_id" = '${H2}' WHERE id = '${H3X}'`;
await barrier({
  name: 'delete subject vs authorize',
  setup: verifierSetup,
  legacy: {
    a: [lockTasks([H2]), [`DELETE FROM "task" WHERE id = $1::uuid`, [H2], 300]],
    b: [lockProject(P), [`SELECT 1 FROM "task" WHERE "id" = $1::uuid FOR SHARE`, [H2], 150]],
  },
  lo1: {
    a: [lockProject(P), lockTasks([H2, H3X]), lockSessions([H2, H3X]),
        [`DELETE FROM "task" WHERE id = $1::uuid`, [H2], 300]],
    b: [lockProject(P), [`SELECT 1 FROM "task" WHERE "id" = $1::uuid FOR SHARE`, [H2], 150]],
  },
});

// -------------------------------------------------------------------------------------------
// 3. The production shape, twice over: a whole-`dependsOn` replacement (owner row → dependent task
//    → the FK's `FOR KEY SHARE` on each prerequisite) against a Coordinator holding
//    project → prerequisite. LO1 takes the owner row, then the project, then BOTH tasks sorted.
// -------------------------------------------------------------------------------------------
const lockOwner = [`SELECT "id" FROM "user" WHERE "id" = $1::uuid FOR UPDATE`, [OWNER]];
const noEdges = `DELETE FROM "task_dependency"`;
const insertEdge = [`INSERT INTO "task_dependency"("id","task_id","depends_on_task_id")
                     VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`, [L1, H2], 300];
await barrier({
  name: 'deps replace vs coordinator',
  setup: noEdges,
  legacy: {
    a: [lockOwner, [`UPDATE "task" SET "updated_at" = now(), "title" = 'L1' WHERE "id" = $1::uuid`, [L1]],
        insertEdge],
    b: [lockProject(P), lockTasks([H2]), [...lockTasks([L1]), 150]],
  },
  lo1: {
    a: [lockOwner, lockProject(P), lockTasks([L1, H2]),
        [`UPDATE "task" SET "updated_at" = now(), "title" = 'L1' WHERE "id" = $1::uuid`, [L1]],
        insertEdge],
    b: [lockProject(P), lockTasks([H2]), [...lockTasks([L1]), 150]],
  },
});

// -------------------------------------------------------------------------------------------
// 4. Two ordinary user writes with no Coordinator anywhere: a dependency replacement, and a PATCH
//    that takes its own task row before touching the graph — which is what every hierarchy,
//    supersession and delete path already does. B holds the prerequisite `FOR UPDATE` and reaches
//    for the owner row; A holds the owner row and reaches the prerequisite through the new edge's
//    foreign key. Neither side is privileged, which is why this one matters.
//
//    The mode is the whole barrier: a plain `UPDATE ... SET status` takes `FOR NO KEY UPDATE`,
//    which an FK's `FOR KEY SHARE` does not conflict with — so the version of this fixture that
//    only PATCHed a status never met the other side at all and reported a `57014` that was the
//    harness holding its own transaction open. `FOR UPDATE` is what an ordinary PATCH takes as soon
//    as it has any reason to lock its row, and it is what the FK actually collides with.
// -------------------------------------------------------------------------------------------
await barrier({
  name: 'deps replace vs task-locking PATCH',
  setup: noEdges,
  legacy: {
    a: [lockOwner, [`UPDATE "task" SET "updated_at" = now() WHERE "id" = $1::uuid`, [L1]], insertEdge],
    b: [lockTasks([H2]),
        [`UPDATE "task" SET "status" = 'DONE', "updated_at" = now() WHERE "id" = $1::uuid`, [H2]],
        [...lockOwner, 150]],
  },
  // Both sides take the owner row FIRST when they take it at all. It sits above LO1's published
  // chain — one row per tenant — so a transaction holding anything below it must never reach back
  // up for it; that is the inversion, spelled with the one lock LO1 does not itself take.
  lo1: {
    a: [lockOwner, lockProject(P), lockTasks([L1, H2]),
        [`UPDATE "task" SET "updated_at" = now() WHERE "id" = $1::uuid`, [L1]], insertEdge],
    b: [lockOwner, lockProject(P), lockTasks([H2]),
        [`UPDATE "task" SET "status" = 'DONE', "updated_at" = now() WHERE "id" = $1::uuid`, [H2], 150]],
  },
});

// -------------------------------------------------------------------------------------------
// 5. The production pair the incident report names and the four above do NOT cover: a dependency
//    replacement against the COORDINATOR SESSION'S OWN METADATA WRITE. Process B holds the session
//    row (`last_tool_use`/`engine_turn_active`/`last_user_text`) and reaches into the task/project
//    path; process A holds the tasks and reaches the session through the dependent task's
//    `creator_session_id` — which is why LO1 puts sessions BELOW tasks rather than beside them.
// -------------------------------------------------------------------------------------------
const sessionMetadata = [`UPDATE "session"
     SET "last_tool_use" = 'task_update', "engine_turn_active" = true,
         "last_user_text" = 'coordinator turn', "updated_at" = now()
   WHERE "id" = $1::uuid`, [COORD]];
await barrier({
  name: 'deps replace vs session metadata',
  setup: noEdges,
  legacy: {
    a: [lockOwner, [`UPDATE "task" SET "updated_at" = now() WHERE "id" = $1::uuid`, [L1]],
        [`SELECT 1 FROM "session" WHERE "id" = $1::uuid FOR UPDATE`, [COORD], 300],
        insertEdge],
    b: [sessionMetadata, [...lockTasks([L1]), 150]],
  },
  lo1: {
    a: [lockOwner, lockProject(P), lockTasks([L1, H2]), lockSessions([L1, H2]),
        [`SELECT 1 FROM "session" WHERE "id" = $1::uuid FOR UPDATE`, [COORD], 300],
        [`UPDATE "task" SET "updated_at" = now() WHERE "id" = $1::uuid`, [L1]],
        insertEdge],
    b: [lockProject(P), lockTasks([L1]), [...[`SELECT 1 FROM "session" WHERE "id" = $1::uuid FOR UPDATE`, [COORD]], 150],
        sessionMetadata],
  },
});

console.log(failures === 0 ? '\nall barriers: reproduced under the old order, clean under LO1'
                           : `\n${failures} barrier(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

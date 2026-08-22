/**
 * The acceptance-fact side of the same question: does a write that REOPENS a project stay atomic
 * with the project scope it reopens, and does it stay that way when two of them race?
 *
 * Two fixture bugs the earlier version of this file had, both of which made it report success on
 * nothing:
 *
 *   * `UPDATE "project" SET "status"='DONE'` is refused by 0127's `project_acceptance_done_gate`
 *     with `ACCEPTANCE_MISSING` — a project may only be DONE against an acceptance run that belongs
 *     to it and concluded PASS. So the fixture never produced a DONE project, and every "reopen"
 *     assertion below it was measuring a project that was already OPEN. It now seeds a PASS run and
 *     binds it, which is the only shape the gate admits;
 *   * both connections ran all their statements and only then committed, so the winner held its
 *     locks until the loser was finished. That is not what a request does, and it turns an ordinary
 *     blocking wait into a mutual one. Each side now commits as soon as its own statements are
 *     through.
 *
 *   PG_URL=postgresql://... SEED_SQL=/path/seed.sql node tools/lock-order/acceptance-facts.mjs
 */
import { Client } from 'pg';
import { readFileSync } from 'node:fs';

const URL = process.env.PG_URL;
const SEED = readFileSync(process.env.SEED_SQL, 'utf8');
const OWNER = '00000000-0000-4000-8000-000000000001';
const P     = '00000000-0000-4000-8000-000000000003';
const L1    = '00000000-0000-4000-8000-0000000000a1';
const RUN   = '00000000-0000-4000-8000-0000000000f1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const conn = async (n) => {
  const c = new Client({ connectionString: URL, application_name: n });
  await c.connect();
  await c.query(`SET statement_timeout = '8s'`);
  return c;
};
const fmt = (e) => (e ? `${e.code ?? '?'} ${String(e.message).split('\n')[0].slice(0, 80)}` : 'ok');

/**
 * A project that is genuinely DONE, which is the only state in which an acceptance fact reopens
 * anything. `project_acceptance_reopen` returns early on a project that is not DONE and on a legacy
 * DONE with no bound run — so without all three writes below, every assertion here is vacuous.
 */
const ACCEPTED = `
  INSERT INTO "project_acceptance_run"
    ("id","project_id","attempt","criteria_snapshot","criteria_revision","input_digest",
     "decided_by","result_digest","verdict","completed_at","digest_version")
  VALUES ('${RUN}','${P}',1,'c','1','d','USER','r','PASS',now(),2);
  UPDATE "project" SET "status"='DONE', "accepted_run_id"='${RUN}' WHERE "id"='${P}';`;

async function reseed(extra) {
  const s = await conn('setup');
  await s.query(`TRUNCATE "user","workspace","project","task","session","task_dependency",
                          "project_event","project_acceptance_run","project_acceptance_audit"
                 RESTART IDENTITY CASCADE`);
  await s.query(SEED);
  if (extra) await s.query(extra);
  await s.end();
}

const read = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// -------------------------------------------------------------------------------------------
// 1. The fixture itself. Asserted rather than assumed, because its silent failure is what made the
//    previous version of this file green on nothing.
// -------------------------------------------------------------------------------------------
{
  await reseed(ACCEPTED);
  const c = await conn('fixture');
  const row = await read(c, `SELECT "status"::text AS s, "accepted_run_id" AS r FROM "project" WHERE id=$1`, [P]);
  check('fixture: the project really is DONE against a PASS run',
    row.s === 'DONE' && row.r === RUN, `status=${row.s} run=${row.r ?? 'null'}`);
  await c.end();
}

// -------------------------------------------------------------------------------------------
// 2. Every acceptance-fact column reopens, and does it ATOMICALLY with the project scope: one
//    statement, one committed transaction, and the project comes out OPEN with its run retired.
//    `terminal_reason`/`superseded_by_task_id` need a retired status to satisfy 0130's CHECK, so
//    they are written in the one statement that also moves the status — which is the point: the
//    fact and its scope are never two transactions.
// -------------------------------------------------------------------------------------------
const FACTS = [
  ['status', `UPDATE "task" SET "status"='DONE' WHERE id='${L1}'`],
  ['completion_policy', `UPDATE "task" SET "completion_policy"='ALL_CHILDREN_DONE' WHERE id='${L1}'`],
  // One statement, both columns: `task_verdict_requires_subject` is a cross-column CHECK, so a
  // verdict written on its own is refused before any trigger runs. The same reason the service
  // writes a verdict and its subject together rather than as two updates.
  ['verdict', `UPDATE "task" SET "verdict"='PASS',
     "verifies_task_id"='00000000-0000-4000-8000-0000000000a2' WHERE id='${L1}'`],
  ['verifies_task_id',
    `UPDATE "task" SET "verifies_task_id"='00000000-0000-4000-8000-0000000000a2' WHERE id='${L1}'`],
  ['terminal_reason',
    `UPDATE "task" SET "status"='CANCELLED', "terminal_reason"='ABANDONED' WHERE id='${L1}'`],
  // Four columns in one statement, for the same reason: `task_retirement_status_check` wants a
  // retired status beside the pointer, and `task_superseded_link_check` wants
  // `terminal_reason = 'SUPERSEDED'` and a `superseded_at` beside it. Any subset is refused.
  ['superseded_by_task_id',
    `UPDATE "task" SET "status"='CANCELLED', "terminal_reason"='SUPERSEDED', "superseded_at"=now(),
       "superseded_by_task_id"='00000000-0000-4000-8000-0000000000a2' WHERE id='${L1}'`],
  ['project_id (move out)', `UPDATE "task" SET "project_id"=NULL WHERE id='${L1}'`],
  ['task.created',
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","project_id")
     VALUES (gen_random_uuid(),'new','${OWNER}','USER','${OWNER}',now(),'${P}')`],
  ['task.deleted', `DELETE FROM "task" WHERE id='${L1}'`],
];
for (const [label, sql] of FACTS) {
  await reseed(ACCEPTED);
  const c = await conn(`fact-${label}`);
  let err = null;
  try { await c.query('BEGIN'); await c.query(sql); await c.query('COMMIT'); }
  catch (e) { err = e; await c.query('ROLLBACK').catch(() => {}); }
  const p = await read(c, `SELECT "status"::text AS s, "accepted_run_id" AS r FROM "project" WHERE id=$1`, [P]);
  const run = await read(c, `SELECT "superseded_at" IS NOT NULL AS retired FROM "project_acceptance_run" WHERE id=$1`, [RUN]);
  check(`acceptance fact reopens atomically: ${label}`,
    !err && p.s === 'OPEN' && p.r === null && run.retired === true,
    err ? fmt(err) : `project=${p.s} boundRun=${p.r ?? 'null'} runRetired=${run.retired}`);
  await c.end();
}

// -------------------------------------------------------------------------------------------
// 3. Two concurrent acceptance facts on one DONE project. Either order is legal; what is not legal
//    is a deadlock, a half-reopened project, or a bound run surviving the reopen.
// -------------------------------------------------------------------------------------------
{
  await reseed(ACCEPTED);
  const a = await conn('reopen-A'), b = await conn('reopen-B');
  const errs = {};
  const drive = async (c, key, delay, sql) => {
    try {
      await c.query('BEGIN');
      if (delay) await sleep(delay);
      await c.query(sql);
      await c.query('COMMIT');
    } catch (e) { errs[key] = e; await c.query('ROLLBACK').catch(() => {}); }
  };
  await Promise.all([
    drive(a, 'a', 0, `UPDATE "task" SET "status"='DONE' WHERE id='${L1}'`),
    drive(b, 'b', 60,
      `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","project_id")
       VALUES (gen_random_uuid(),'concurrent','${OWNER}','USER','${OWNER}',now(),'${P}')`),
  ]);
  const p = await read(a, `SELECT "status"::text AS s, "accepted_run_id" AS r FROM "project" WHERE id=$1`, [P]);
  const audits = await read(a, `SELECT count(*)::int AS n FROM "project_acceptance_audit" WHERE "project_id"=$1`, [P]);
  check('two concurrent acceptance facts serialize without a deadlock',
    !errs.a && !errs.b && p.s === 'OPEN' && p.r === null && audits.n >= 1,
    `A=${fmt(errs.a)} B=${fmt(errs.b)} project=${p.s} audits=${audits.n}`);
  await a.end(); await b.end();
}

console.log(failures === 0 ? '\nacceptance-fact PATCH: atomic with its project scope'
                           : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

import { Client } from 'pg';
import { readFileSync } from 'node:fs';
const URL = process.env.PG_URL, SEED = readFileSync(process.env.SEED_SQL, 'utf8');
const P = '00000000-0000-4000-8000-000000000003';
const O = '00000000-0000-4000-8000-000000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const conn = async (n) => { const c = new Client({ connectionString: URL, application_name: n }); await c.connect(); await c.query(`SET statement_timeout='8s'`); return c; };
const fmt = (e) => e ? `${e.code ?? '?'} ${String(e.message).split('\n')[0]}` : 'ok';
const ins = `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","project_id")
  VALUES (gen_random_uuid(), $1, '${O}', 'USER', '${O}', now(), '${P}')`;

async function reseed(done) {
  const s = await conn('setup');
  await s.query(`TRUNCATE "user","workspace","project","task","session","task_dependency","project_event","project_acceptance_run","project_acceptance_audit" RESTART IDENTITY CASCADE`);
  await s.query(SEED);
  if (done) await s.query(`UPDATE "project" SET "status"='DONE' WHERE id='${P}'`);
  await s.end();
}
for (const done of [false, true]) {
  await reseed(done);
  const a = await conn('ins-A'), b = await conn('ins-B');
  const errs = {};
  await a.query('BEGIN'); await b.query('BEGIN');
  const pa = a.query(ins, ['A']).catch((e) => { errs.a = e; });
  const pb = (async () => { await sleep(120); return b.query(ins, ['B']).catch((e) => { errs.b = e; }); })();
  await Promise.all([pa, pb]);
  await a.query('COMMIT').catch((e) => { errs.a ??= e; });
  await b.query('COMMIT').catch((e) => { errs.b ??= e; });
  await a.end(); await b.end();
  console.log(`two concurrent task INSERTs (project DONE=${done}): A=${fmt(errs.a)} | B=${fmt(errs.b)}`);
}

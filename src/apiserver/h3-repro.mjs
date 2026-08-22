import { Client } from 'pg';
const URL = process.env.PG_URL;
const P  = '00000000-0000-4000-8000-000000000003';
const L1 = '00000000-0000-4000-8000-0000000000a1';
const H2 = '00000000-0000-4000-8000-0000000000a2';
const H3X= '00000000-0000-4000-8000-0000000000a3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const conn = async (n) => {
  const c = new Client({ connectionString: URL, application_name: n });
  await c.connect();
  await c.query(`SET statement_timeout = '8s'`);
  return c;
};
const fmt = (e) => e ? `${e.code ?? '?'} ${String(e.message).split('\n')[0]}` : 'ok';

import { readFileSync } from 'node:fs';
const SEED = readFileSync(process.env.SEED_SQL, 'utf8');
async function barrier(name, setup, aSteps, bSteps) {
  const s = await conn('h3-setup');
  await s.query(`TRUNCATE "user", "workspace", "project", "task", "session", "task_dependency",
                          "project_event" RESTART IDENTITY CASCADE`);
  await s.query(SEED);
  if (setup) await s.query(setup);
  await s.end();
  const a = await conn(`h3-A-${name}`), b = await conn(`h3-B-${name}`);
  const errs = {};
  const drive = async (c, steps, key) => {
    try { for (const [sql, params, pause] of steps) { if (pause) await sleep(pause); await c.query(sql, params); } }
    catch (e) { errs[key] = e; }
  };
  await a.query('BEGIN'); await b.query('BEGIN');
  const pa = drive(a, aSteps, 'a'), pb = drive(b, bSteps, 'b');
  await Promise.all([pa, pb]);
  await a.query('COMMIT').catch((e) => { errs.a ??= e; });
  await b.query('COMMIT').catch((e) => { errs.b ??= e; });
  await a.end(); await b.end();
  console.log(`${name.padEnd(34)}: A=${fmt(errs.a)} | B=${fmt(errs.b)}`);
  return errs;
}

// 1. A pure status PATCH takes NO project lock today; its AFTER trigger reaches for one while it
//    already holds the task. The coordinator holds project-then-task. That is the cycle.
await barrier('status-PATCH vs coordinator', null,
  [ [`SELECT 1 FROM "task" WHERE "id" = $1::uuid FOR UPDATE`, [L1]],
    [`UPDATE "task" SET "status" = 'DONE', "updated_at" = now() WHERE "id" = $1::uuid`, [L1], 300] ],
  [ [`SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE`, [P]],
    [`SELECT 1 FROM "task" WHERE "id" = $1::uuid FOR UPDATE`, [L1], 150] ]);

// 2. Deleting a SUBJECT cascades its verifiers away; every cascaded row reaches for its project
//    from an AFTER DELETE, with the task already held. Authorization holds project-then-task.
await barrier('delete subject vs authorize',
  `UPDATE "task" SET "verifies_task_id" = '${H2}' WHERE id = '${H3X}'`,
  [ [`SELECT id FROM "task" WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [[H2]]],
    [`DELETE FROM "task" WHERE id = $1::uuid`, [H2], 300] ],
  [ [`SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE`, [P]],
    [`SELECT 1 FROM "task" WHERE "id" = $1::uuid FOR SHARE`, [H2], 150] ]);

// 3. The fresh production shape: a full dependsOn replacement (user -> dependent task -> FK
//    FOR KEY SHARE on each prerequisite) against a coordinator holding project -> prerequisite.
await barrier('deps replace vs coordinator',
  `DELETE FROM "task_dependency"`,
  [ [`SELECT "id" FROM "user" WHERE "id" = '00000000-0000-4000-8000-000000000001'::uuid FOR UPDATE`],
    [`UPDATE "task" SET "updated_at" = now(), "title" = 'L1' WHERE "id" = $1::uuid`, [L1]],
    [`INSERT INTO "task_dependency"("id","task_id","depends_on_task_id")
        VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`, [L1, H2], 300] ],
  [ [`SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE`, [P]],
    [`SELECT 1 FROM "task" WHERE "id" = $1::uuid FOR UPDATE`, [H2]],
    [`SELECT 1 FROM "task" WHERE "id" = $1::uuid FOR UPDATE`, [L1], 150] ]);

// 4. Two ordinary user writes: a dependency replacement and a status PATCH on the prerequisite.
await barrier('deps replace vs status PATCH',
  `DELETE FROM "task_dependency"`,
  [ [`SELECT "id" FROM "user" WHERE "id" = '00000000-0000-4000-8000-000000000001'::uuid FOR UPDATE`],
    [`UPDATE "task" SET "updated_at" = now() WHERE "id" = $1::uuid`, [L1]],
    [`INSERT INTO "task_dependency"("id","task_id","depends_on_task_id")
        VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`, [L1, H2], 300] ],
  [ [`UPDATE "task" SET "status" = 'DONE', "updated_at" = now() WHERE "id" = $1::uuid`, [H2]],
    [`SELECT "id" FROM "user" WHERE "id" = '00000000-0000-4000-8000-000000000001'::uuid FOR UPDATE`, [], 150] ]);

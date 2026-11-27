// The rehearsal's writer loop (plan §7.2: "a writer loop updating sessions the way event ingestion does, to see the
// lock tries work"). By default (WRITER_CODE=d1) it writes as code before deploy D2 does, the word only, never
// turn_state or phase; WRITER_CODE=d3 writes as D3 and D4 code does, turn_state and never the word, which is the loop
// for the D3 to D4 hand-over (a D4 database has no word column):
//   ingest   every 100 ms, one held session of the seeded runners gets its running background jobs, background shells
//            and engine flag moved, as event ingestion moves them (each write fires session_zz_phase once D1 is in);
//   cycle    every 500 ms, one of ten held seeded sessions moves AWAITING_INPUT -> PENDING -> RUNNING -> AWAITING_INPUT,
//            the word alone, as a D1 replica's enqueue, claim and turn-complete write it;
//   beat     every 15 s, the seeded runners' heartbeat and presence, so the reaper treats them as online and their
//            held rows keep their shape.
// WRITER_CYCLE=parked cycles AWAITING_INPUT <-> PENDING only: a cycled session left RUNNING on a seeded runner, whose
// turn no runner takes, is released by the reaper within about five minutes, after which the cycle matches no row.
// No lock_timeout: a writer queues behind a migration's lock as a server's does, and how long it queued is the point.
// Every statement is timed; one that takes over 100 ms is logged with its time, and a summary line is printed every
// 10 s. Stops on SIGTERM and prints a last summary.
//   docker run -d --network <net> -e DATABASE_URL=... [-e WRITER_CODE=d3] [-e WRITER_CYCLE=parked] -v <this dir>:/kit:ro <project>-apiserver:d2 node /kit/writer-loop.cjs
'use strict';
const path = require('node:path');

const { prismaClientFor } = require(path.join(process.env.API_DIST ?? '/app/src/apiserver/dist', 'prisma/prisma-client.js'));
const CODE = process.env.WRITER_CODE ?? 'd1';
if (!['d1', 'd3'].includes(CODE)) throw new Error(`WRITER_CODE is d1 or d3, not ${CODE}`);
const TURN_STATE = { AWAITING_INPUT: null, PENDING: 'QUEUED', RUNNING: 'IN_FLIGHT' };
/** Move one held session to the state `to` names, as this code's enqueue, claim and turn-complete write it. */
const move = (op, id, to) => (CODE === 'd1'
  ? timed(op, `UPDATE "session" SET "status" = $2::run_status, "updated_at" = now() WHERE "id" = $1::uuid AND "finished_at" IS NULL`, id, to)
  : timed(op, `UPDATE "session" SET "turn_state" = $2, "updated_at" = now() WHERE "id" = $1::uuid AND "finished_at" IS NULL`, id, TURN_STATE[to]));
const db = prismaClientFor(process.env.DATABASE_URL);
const SLOW_MS = 100;

const stats = {};
function note(op, ms, rows, err) {
  const s = (stats[op] ??= { n: 0, errors: 0, slow: 0, maxMs: 0, totalMs: 0, rows: 0, all: [] });
  s.n++; s.totalMs += ms; s.rows += rows ?? 0; s.maxMs = Math.max(s.maxMs, ms); s.all.push(ms);
  if (err) s.errors++;
  if (ms > SLOW_MS || err) {
    if (ms > SLOW_MS) s.slow++;
    console.log(JSON.stringify({ t: new Date().toISOString(), slow: op, ms: Math.round(ms), rows, error: err ? String(err.message ?? err).slice(0, 200) : undefined }));
  }
}
async function timed(op, sql, ...args) {
  const t0 = process.hrtime.bigint();
  try {
    const rows = await db.$executeRawUnsafe(sql, ...args);
    note(op, Number(process.hrtime.bigint() - t0) / 1e6, rows);
  } catch (err) {
    note(op, Number(process.hrtime.bigint() - t0) / 1e6, 0, err);
  }
}
function summary(final) {
  const out = {};
  for (const [op, s] of Object.entries(stats)) {
    const sorted = [...s.all].sort((a, b) => a - b);
    const p = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
    out[op] = { n: s.n, rows: s.rows, errors: s.errors, slowOver100ms: s.slow, p50: p(0.5), p99: p(0.99), maxMs: Math.round(s.maxMs) };
  }
  console.log(JSON.stringify({ t: new Date().toISOString(), [final ? 'final' : 'summary']: out }));
}

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // The held sessions of the seeded runners 2-20 (session-status-query-plans-seed.sql names them 'runner <n>').
  const parked = await db.$queryRawUnsafe(`
    SELECT s."id"::text AS id FROM "session" s JOIN "runner" r ON r."id" = s."assigned_runner_id"
     WHERE r."name" ~ '^runner ([2-9]|1[0-9]|20)$' AND s."finished_at" IS NULL
       AND ${CODE === 'd1' ? `s."status" = 'AWAITING_INPUT'` : 's."turn_state" IS NULL'}
     ORDER BY s."id"`);
  if (parked.length < 20) throw new Error(`only ${parked.length} parked seeded sessions`);
  const cyclers = parked.slice(0, 10).map((r) => r.id);
  const ingested = parked.slice(10).map((r) => r.id);
  console.log(JSON.stringify({ t: new Date().toISOString(), start: { cyclers: cyclers.length, ingested: ingested.length } }));
  const word = new Map(cyclers.map((id) => [id, 'AWAITING_INPUT']));
  const NEXT = process.env.WRITER_CYCLE === 'parked'
    ? { AWAITING_INPUT: 'PENDING', PENDING: 'AWAITING_INPUT' }
    : { AWAITING_INPUT: 'PENDING', PENDING: 'RUNNING', RUNNING: 'AWAITING_INPUT' };
  let tick = 0;
  let lastSummary = Date.now();
  while (!stopping) {
    tick++;
    const id = ingested[tick % ingested.length];
    const on = tick % 2 === 0;
    await timed('ingest',
      `UPDATE "session" SET "running_bg_jobs" = $2::text[], "running_bg_shells" = $2::text[], "engine_turn_active" = $3,
              "updated_at" = now() WHERE "id" = $1::uuid AND "finished_at" IS NULL`,
      id, on ? ['bgj_writer_loop'] : [], on && tick % 6 === 0);
    if (tick % 5 === 0) {
      const c = cyclers[(tick / 5) % cyclers.length];
      const to = NEXT[word.get(c)];
      await move(`cycle:${to}`, c, to);
      word.set(c, to);
    }
    if (tick % 150 === 1) {
      await timed('beat', `UPDATE "runner" SET "last_heartbeat_at" = now() WHERE "name" ~ '^runner [0-9]+$'`);
      await timed('presence', `UPDATE "runner_presence" p SET "last_beat_at" = now() FROM "runner" r WHERE r."id" = p."runner_id" AND r."name" ~ '^runner [0-9]+$'`);
    }
    if (Date.now() - lastSummary > 10_000) { summary(false); lastSummary = Date.now(); }
    await sleep(100);
  }
  // Leave the cycled sessions parked, as they started.
  for (const c of cyclers) await move('park', c, 'AWAITING_INPUT');
  summary(true);
}

main().then(() => db.$disconnect(), async (err) => { console.error(err); await db.$disconnect(); process.exit(1); });

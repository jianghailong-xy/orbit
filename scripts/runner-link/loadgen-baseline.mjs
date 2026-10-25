#!/usr/bin/env node
// What one heartbeat and one event batch cost the apiserver and the database, from two load test runs on the same
// fleet: one with heartbeats only (-event-rate 0) and one with events besides (README.md, "Per-operation baseline").
// The optimisation tasks re-run the same pair and compare with the baseline README.md records.
//
//   node scripts/runner-link/loadgen-baseline.mjs <heartbeats-only run> <heartbeats-and-events run> [--json out.json]
//     [--target-events 2000]
//
// Per heartbeat: the first run's apiserver and database CPU (mean cores over the steady window, loadgen-report.mjs)
// over its heartbeats a second, and its statements and commits over its heartbeats. Per batch: what the second run adds
// to the first, the heartbeats' share scaled to the second run's heartbeat rate, over its batches. A statement counts
// for an operation when it ran between 0.5 and 4 times per operation over the run (pg_stat_statements is reset when a
// run starts, so it also holds the ramp's link-token requests and the reaper's sweeps, which fall outside that band).
//
// Per event is a batch's cost over its events. The ingest's own rate is what the run adds to the heartbeats: its commits
// and statements a second, and, with --target-events, the same per event at that many events a second, linear in events
// (an upper bound for merged calls, which carry more batches a call as the rate grows). When the gateway merged the
// batches (src/link-gateway/events_merge.go), its calls are reported beside them: batches a call, and how long each
// call's transaction held its sessions.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
const targetAt = args.indexOf('--target-events');
const targetEvents = targetAt >= 0 ? Number(args.splice(targetAt, 2)[1]) : null;
if (args.length !== 2 || (targetEvents !== null && !(targetEvents > 0))) {
  console.error('usage: loadgen-baseline.mjs <heartbeats-only run> <heartbeats-and-events run> [--json out.json] [--target-events N]');
  process.exit(2);
}
const load = (dir) => {
  const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const report = read('report.json');
  const summary = read('summary.json');
  const before = read('db-before.json');
  const after = read('db-after.json');
  const statements = read('pgss.json');
  return {
    dir, report, summary, statements,
    commits: after.xactCommit - before.xactCommit,
    calls: statements.reduce((n, q) => n + q.calls, 0),
    steady: summary.steady,
    whole: summary.whole.counters,
  };
};
const [hb, ev] = args.map(load);
for (const r of [hb, ev]) {
  if (!r.steady) throw new Error(`${r.dir} has no steady window`);
  if (r.report.loadgen.config.runners !== hb.report.loadgen.config.runners) throw new Error('the two runs played different fleets');
}
if (hb.steady.counters.batchesAcked !== 0) throw new Error(`${hb.dir} sent events: run it with -event-rate 0`);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const cores = (r, svc) => r.report.components[svc]?.meanCores ?? 0;
// A host swapping during a run inflates its CPU figures: on 2026-10-25 a heartbeats-only run swapping in about 1,100
// pages/s measured 12% more database CPU than its repeat at 2 pages/s. Each run's swap-in over its steady window is
// reported, and a run past HEAVY_SWAP_IN pages/s is to be run again rather than compared.
const HEAVY_SWAP_IN = 100;
const swapInPerSec = (r) => {
  const secs = (Number(new Date(r.report.steadyTo)) - Number(new Date(r.report.steadyFrom))) / 1000;
  return r.report.host?.swapInPages == null || !(secs > 0) ? null : round(r.report.host.swapInPages / secs, 0);
};

// Per heartbeat, from the heartbeats-only run.
const beatsPerSec = hb.steady.heartbeatAcksPerSecond;
const perBeat = {
  apiserverCpuMs: round((cores(hb, 'apiserver') * 1000) / beatsPerSec),
  databaseCpuMs: round((cores(hb, 'postgres') * 1000) / beatsPerSec),
  gatewayCpuMs: round((cores(hb, 'link-gateway') * 1000) / beatsPerSec, 3),
  sqlStatements: round(hb.calls / hb.whole.heartbeatAcks, 1),
  commits: round(hb.commits / hb.whole.heartbeatAcks, 1),
};
// Per batch: what the second run adds, its heartbeats' share taken out at the first run's cost per beat.
const evBeatsPerSec = ev.steady.heartbeatAcksPerSecond;
const batchesPerSec = ev.steady.batchesAckedPerSecond;
const scale = ev.whole.heartbeatAcks / hb.whole.heartbeatAcks;
const perBatch = {
  eventsPerBatch: round(ev.steady.counters.eventsAcked / ev.steady.counters.batchesAcked),
  apiserverCpuMs: round(((cores(ev, 'apiserver') - (perBeat.apiserverCpuMs * evBeatsPerSec) / 1000) * 1000) / batchesPerSec),
  databaseCpuMs: round(((cores(ev, 'postgres') - (perBeat.databaseCpuMs * evBeatsPerSec) / 1000) * 1000) / batchesPerSec),
  gatewayCpuMs: round(((cores(ev, 'link-gateway') - (perBeat.gatewayCpuMs * evBeatsPerSec) / 1000) * 1000) / batchesPerSec, 3),
  sqlStatements: round((ev.calls - hb.calls * scale) / ev.whole.batchesAcked, 1),
  commits: round((ev.commits - hb.commits * scale) / ev.whole.batchesAcked, 1),
};
// Per event, and the ingest's own rate: the run's commits and statements over its batches, at its batch rate.
const eventsPerBatch = perBatch.eventsPerBatch;
const perEvent = {
  apiserverCpuMs: round(perBatch.apiserverCpuMs / eventsPerBatch, 3),
  databaseCpuMs: round(perBatch.databaseCpuMs / eventsPerBatch, 3),
  sqlStatements: round(perBatch.sqlStatements / eventsPerBatch, 2),
  commits: round(perBatch.commits / eventsPerBatch, 3),
};
const ingest = {
  eventsPerSec: ev.steady.eventsAckedPerSecond,
  commitsPerSec: round(perBatch.commits * batchesPerSec, 1),
  sqlStatementsPerSec: round(perBatch.sqlStatements * batchesPerSec, 0),
  apiserverCores: round((perBatch.apiserverCpuMs * batchesPerSec) / 1000, 3),
  databaseCores: round((perBatch.databaseCpuMs * batchesPerSec) / 1000, 3),
};
const projected = targetEvents === null ? null : {
  eventsPerSec: targetEvents,
  commitsPerSec: round(perEvent.commits * targetEvents, 0),
  sqlStatementsPerSec: round(perEvent.sqlStatements * targetEvents, 0),
  apiserverCores: round((perEvent.apiserverCpuMs * targetEvents) / 1000, 2),
  databaseCores: round((perEvent.databaseCpuMs * targetEvents) / 1000, 2),
};
const gwOf = ev.report.gateway ?? {};
const merged = gwOf.mergeCalls > 0 ? {
  callsPerSec: round(gwOf.mergeCalls / ev.steady.seconds, 1),
  batchesPerCall: gwOf.mergeBatchesPerCall,
  heldMs: gwOf.mergeHeld,
  callMs: gwOf.mergeCall,
} : null;

// The statements each operation runs, by how often per operation.
const per = (r, ops) => r.statements
  .map((q) => ({ perOp: q.calls / ops, meanMs: q.mean_ms, query: q.query }))
  .filter((q) => q.perOp >= 0.5 && q.perOp <= 4)
  .sort((a, b) => b.perOp * b.meanMs - a.perOp * a.meanMs);
const hbQueries = per(hb, hb.whole.heartbeatAcks);
const hbSet = new Set(hbQueries.map((q) => q.query));
const batchQueries = per(ev, ev.whole.batchesAcked).filter((q) => !hbSet.has(q.query));

const run = hb.report;
const baseline = {
  commit: run.sha, runs: [hb.report.run, ev.report.run], fleet: { runners: run.loadgen.config.runners,
    activeSessions: ev.report.loadgen.config.activeSessions, perSessionEventsPerSecond: ev.report.loadgen.config.perSessionRate },
  rates: { heartbeatsOnly: { beatsPerSec }, withEvents: { beatsPerSec: evBeatsPerSec, batchesPerSec, eventsPerSec: ev.steady.eventsAckedPerSecond } },
  hostOtherCores: [hb.report.host.otherCgroupCores, ev.report.host.otherCgroupCores],
  swapInPagesPerSec: [swapInPerSec(hb), swapInPerSec(ev)],
  perHeartbeat: perBeat, perBatch, perEvent, ingest, projected, merged,
  eventAck: { runnerBatch: ev.steady.ackBatch, gateway: gwOf.eventAck },
  heartbeatStatements: hbQueries.map((q) => ({ perOp: round(q.perOp, 2), meanMs: q.meanMs, query: q.query.slice(0, 200) })),
  batchStatements: batchQueries.map((q) => ({ perOp: round(q.perOp, 2), meanMs: q.meanMs, query: q.query.slice(0, 200) })),
};
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(baseline, null, 2) + '\n');

const out = [];
out.push(`Commit \`${run.sha.slice(0, 12)}\`, runs ${baseline.runs.join(' and ')}: ${baseline.fleet.runners} runners, ${baseline.fleet.activeSessions} running sessions.`);
out.push(`Heartbeats only: ${beatsPerSec} beats/s. With events: ${evBeatsPerSec} beats/s, ${batchesPerSec} batches/s (${perBatch.eventsPerBatch} events each, ${ev.steady.eventsAckedPerSecond} events/s).`);
const heavy = [hb, ev].filter((r, i) => baseline.swapInPagesPerSec[i] > HEAVY_SWAP_IN).map((r) => r.report.run);
out.push(`Host swap-in over the steady windows: ${baseline.swapInPagesPerSec.join(' and ')} pages/s`
  + (heavy.length ? `: **${heavy.join(' and ')} swapped past ${HEAVY_SWAP_IN} pages/s, which inflates CPU; run it again**.` : '.'), '');
out.push('| Per operation | apiserver CPU ms | database CPU ms | gateway CPU ms | SQL statements | commits |');
out.push('| --- | --- | --- | --- | --- | --- |');
out.push(`| heartbeat | ${perBeat.apiserverCpuMs} | ${perBeat.databaseCpuMs} | ${perBeat.gatewayCpuMs} | ${perBeat.sqlStatements} | ${perBeat.commits} |`);
out.push(`| event batch (${perBatch.eventsPerBatch} events) | ${perBatch.apiserverCpuMs} | ${perBatch.databaseCpuMs} | ${perBatch.gatewayCpuMs} | ${perBatch.sqlStatements} | ${perBatch.commits} |`);
out.push('', '| Per event | apiserver CPU ms | database CPU ms | SQL statements | commits |');
out.push('| --- | --- | --- | --- | --- |');
out.push(`| event | ${perEvent.apiserverCpuMs} | ${perEvent.databaseCpuMs} | ${perEvent.sqlStatements} | ${perEvent.commits} |`);
out.push('', `The ingest at ${ingest.eventsPerSec} events/s: ${ingest.commitsPerSec} commits/s, ${ingest.sqlStatementsPerSec} statements/s, `
  + `${ingest.apiserverCores} apiserver cores, ${ingest.databaseCores} database cores.`);
if (projected) {
  out.push(`At ${projected.eventsPerSec} events/s, linear in events: ${projected.commitsPerSec} commits/s, ${projected.sqlStatementsPerSec} statements/s, `
    + `${projected.apiserverCores} apiserver cores, ${projected.databaseCores} database cores.`);
}
out.push(`EventAck: per batch at the runner p50 ${ev.steady.ackBatch.p50Ms} ms, p99 ${ev.steady.ackBatch.p99Ms} ms; `
  + `at the gateway p99 ≈ ${gwOf.eventAck?.p99Ms} ms.`);
if (merged) {
  out.push(`Merged calls: ${merged.callsPerSec}/s, ${merged.batchesPerCall} batches each; their transaction held its sessions `
    + `p50 ≈ ${merged.heldMs.p50Ms} ms, p99 ≈ ${merged.heldMs.p99Ms} ms (mean ${merged.heldMs.meanMs} ms); a call took `
    + `p50 ≈ ${merged.callMs.p50Ms} ms, p99 ≈ ${merged.callMs.p99Ms} ms.`);
}
for (const [name, list] of [['heartbeat', hbQueries], ['event batch', batchQueries]]) {
  out.push('', `Statements per ${name}, most database time first (times per ${name}, mean ms):`, '');
  for (const q of list.slice(0, 40)) out.push(`- ${round(q.perOp, 2)} × ${q.meanMs} ms: \`${q.query.slice(0, 140).replace(/`/g, "'")}\``);
}
console.log(out.join('\n'));

#!/usr/bin/env node
// What one heartbeat and one event batch cost the apiserver and the database, from two load test runs on the same
// fleet: one with heartbeats only (-event-rate 0) and one with events besides (README.md, "Per-operation baseline").
// The optimisation tasks re-run the same pair and compare with the baseline README.md records.
//
//   node scripts/runner-link/loadgen-baseline.mjs <heartbeats-only run> <heartbeats-and-events run> [--full <run>] [--json out.json]
//
// Per heartbeat: the first run's apiserver and database CPU (mean cores over the steady window, loadgen-report.mjs)
// over its heartbeats a second, and its statements and commits over its heartbeats. Per batch: what the second run adds
// to the first, the heartbeats' share scaled to the second run's heartbeat rate, over its batches. A statement counts
// for an operation when it ran between 0.5 and 4 times per operation over the run (pg_stat_statements is reset when a
// run starts, so it also holds the ramp's link-token requests and the reaper's sweeps, which fall outside that band).
//
// With --full, a third heartbeats-only run on the same fleet in which every beat reconciled in full (loadgen-run.sh
// --mark-every): a beat is either unflagged or reconciled in full (task O1), and each of the two runs' figures over its
// steady window is its two kinds of beat at their shares, so the two runs give each kind's cost.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : null;
};
const jsonOut = option('--json');
const fullDir = option('--full');
if (args.length !== 2) {
  console.error('usage: loadgen-baseline.mjs <heartbeats-only run> <heartbeats-and-events run> [--full <run>] [--json out.json]');
  process.exit(2);
}
const load = (dir) => {
  const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  // The database's counters every 15 s (loadgen-run.sh), for what the steady window alone committed.
  const samples = readFileSync(join(dir, 'db.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
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
    samples,
    steadyFrom: Date.parse(summary.steadyStartedAt),
    steadyTo: Date.parse(summary.steadyEndedAt),
  };
};
/** A database counter (xactCommit, statements) at `at`, read off the samples either side of it. */
const counterAt = (r, key, at) => {
  const after = r.samples.findIndex((s) => s.t >= at);
  if (after <= 0) return r.samples[Math.max(after, 0)]?.[key] ?? NaN;
  const [a, b] = [r.samples[after - 1], r.samples[after]];
  return Number(a[key]) + ((Number(b[key]) - Number(a[key])) * (at - a.t)) / (b.t - a.t);
};
const [hb, ev] = args.map(load);
const full = fullDir ? load(fullDir) : null;
for (const r of [hb, ev, full].filter(Boolean)) {
  if (!r.steady) throw new Error(`${r.dir} has no steady window`);
  if (r.report.loadgen.config.runners !== hb.report.loadgen.config.runners) throw new Error('the runs played different fleets');
}
for (const r of [hb, full].filter(Boolean)) {
  if (r.steady.counters.batchesAcked !== 0) throw new Error(`${r.dir} sent events: run it with -event-rate 0`);
}
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const cores = (r, svc) => r.report.components[svc]?.meanCores ?? 0;
/** A heartbeats-only run's figures per beat over its steady window, unrounded; the statements need loadgen-run.sh's
 *  `statements` samples (null before task O1), the reconciled share the loadgen's heartbeatsReconciled. */
const steadyPerBeat = (r) => {
  const beats = r.steady.counters.heartbeatAcks;
  const over = (key) => (counterAt(r, key, r.steadyTo) - counterAt(r, key, r.steadyFrom)) / beats;
  return {
    apiserverCpuMs: (cores(r, 'apiserver') * 1000) / r.steady.heartbeatAcksPerSecond,
    databaseCpuMs: (cores(r, 'postgres') * 1000) / r.steady.heartbeatAcksPerSecond,
    commits: over('xactCommit'),
    statements: r.samples[0]?.statements == null ? null : over('statements'),
    reconciledShare: r.steady.counters.heartbeatsReconciled === undefined ? null : r.steady.counters.heartbeatsReconciled / beats,
  };
};

// Per heartbeat, from the heartbeats-only run.
const beatsPerSec = hb.steady.heartbeatAcksPerSecond;
const perBeat = {
  apiserverCpuMs: round((cores(hb, 'apiserver') * 1000) / beatsPerSec),
  databaseCpuMs: round((cores(hb, 'postgres') * 1000) / beatsPerSec),
  gatewayCpuMs: round((cores(hb, 'link-gateway') * 1000) / beatsPerSec, 3),
  sqlStatements: round(hb.calls / hb.whole.heartbeatAcks, 1),
  commits: round(hb.commits / hb.whole.heartbeatAcks, 1),
  // Over the steady window alone: no ramp, so no first connect, no first beat of a connection; renewals and the
  // reaper's sweeps are in it. And how many beats were answered with a full reconcile (task O1; null before it).
  steadyCommits: round(steadyPerBeat(hb).commits, 2),
  steadyStatements: steadyPerBeat(hb).statements === null ? null : round(steadyPerBeat(hb).statements, 2),
  reconciledShare: steadyPerBeat(hb).reconciledShare === null ? null : round(steadyPerBeat(hb).reconciledShare, 3),
};
// With --full: each figure f of a run is (1 - s) × u + s × r, s its reconciled share, u an unflagged beat's cost and
// r a full reconcile's; the two runs' shares differ, so the pair of equations gives u and r. Renewals and the
// reaper's sweeps over the window fall into both, as they fall into perBeat.
let split = null;
if (full) {
  const [a, b] = [steadyPerBeat(hb), steadyPerBeat(full)];
  if (a.reconciledShare === null || b.reconciledShare === null || b.reconciledShare - a.reconciledShare < 0.5) {
    throw new Error(`${full.dir} reconciled ${b.reconciledShare} of its beats and ${hb.dir} ${a.reconciledShare}: ` +
      'the full run needs nearly every beat reconciled (loadgen-run.sh --mark-every)');
  }
  const each = (key, d) => {
    if (a[key] === null || b[key] === null) return [null, null];
    const [s, t] = [a.reconciledShare, b.reconciledShare];
    return [round((a[key] * t - b[key] * s) / (t - s), d), round((b[key] * (1 - s) - a[key] * (1 - t)) / (t - s), d)];
  };
  const kinds = ['apiserverCpuMs', 'databaseCpuMs', 'statements', 'commits'].map((key) => [key, each(key, 2)]);
  split = {
    fullRun: full.report.run,
    reconciledShares: [round(a.reconciledShare, 3), round(b.reconciledShare, 3)],
    unflagged: Object.fromEntries(kinds.map(([key, [u]]) => [key, u])),
    reconciled: Object.fromEntries(kinds.map(([key, [, r]]) => [key, r])),
  };
}
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
  commit: run.sha, runs: [hb.report.run, ev.report.run], loadTestLock: [hb, ev].map((r) => r.report.loadTestLock ?? null), fleet: { runners: run.loadgen.config.runners,
    activeSessions: ev.report.loadgen.config.activeSessions, perSessionEventsPerSecond: ev.report.loadgen.config.perSessionRate },
  rates: { heartbeatsOnly: { beatsPerSec }, withEvents: { beatsPerSec: evBeatsPerSec, batchesPerSec, eventsPerSec: ev.steady.eventsAckedPerSecond } },
  hostOtherCores: [hb.report.host.otherCgroupCores, ev.report.host.otherCgroupCores],
  perHeartbeat: perBeat, perBatch, ...(split ? { perHeartbeatByKind: split } : {}),
  heartbeatStatements: hbQueries.map((q) => ({ perOp: round(q.perOp, 2), meanMs: q.meanMs, query: q.query.slice(0, 200) })),
  batchStatements: batchQueries.map((q) => ({ perOp: round(q.perOp, 2), meanMs: q.meanMs, query: q.query.slice(0, 200) })),
};
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(baseline, null, 2) + '\n');

const out = [];
out.push(`Commit \`${run.sha.slice(0, 12)}\`, runs ${baseline.runs.join(' and ')}: ${baseline.fleet.runners} runners, ${baseline.fleet.activeSessions} running sessions.`);
const unlocked = [hb, ev, full].filter(Boolean).filter((r) => r.report.loadTestLock !== true).map((r) => r.report.run);
out.push(unlocked.length === 0 ? "Every run held the host's load test lock." : `Not under the host's load test lock: ${unlocked.join(', ')}.`);
out.push(`Heartbeats only: ${beatsPerSec} beats/s. With events: ${evBeatsPerSec} beats/s, ${batchesPerSec} batches/s (${perBatch.eventsPerBatch} events each, ${ev.steady.eventsAckedPerSecond} events/s).`, '');
out.push('| Per operation | apiserver CPU ms | database CPU ms | gateway CPU ms | SQL statements | commits |');
out.push('| --- | --- | --- | --- | --- | --- |');
out.push(`| heartbeat | ${perBeat.apiserverCpuMs} | ${perBeat.databaseCpuMs} | ${perBeat.gatewayCpuMs} | ${perBeat.sqlStatements} | ${perBeat.commits} |`);
out.push(`| event batch (${perBatch.eventsPerBatch} events) | ${perBatch.apiserverCpuMs} | ${perBatch.databaseCpuMs} | ${perBatch.gatewayCpuMs} | ${perBatch.sqlStatements} | ${perBatch.commits} |`);
out.push('', `Over the heartbeats-only run's steady window: ${perBeat.steadyCommits} commits a beat, renewals and the reaper included` +
  (perBeat.reconciledShare === null ? '.' : `; ${round(perBeat.reconciledShare * 100, 1)}% of the beats were answered with a full reconcile.`) +
  (perBeat.steadyStatements === null ? '' : ` ${perBeat.steadyStatements} statements a beat.`) +
  (hb.report.loadgen.config.volatile ? ` The runners moved their reports as production does (-volatile, edits ${hb.report.loadgen.config.volatileEdits}).` : ''));
if (split) {
  out.push('', `Split by the full run ${split.fullRun}, whose beats reconciled in full (${round(split.reconciledShares[1] * 100, 1)}% of them, ` +
    `against ${round(split.reconciledShares[0] * 100, 1)}%), each over its steady window:`, '');
  out.push('| Per heartbeat | apiserver CPU ms | database CPU ms | SQL statements | commits |', '| --- | --- | --- | --- | --- |');
  for (const [label, k] of [['unflagged', split.unflagged], ['reconciled in full', split.reconciled]]) {
    out.push(`| ${label} | ${k.apiserverCpuMs} | ${k.databaseCpuMs} | ${k.statements ?? 'n/a'} | ${k.commits} |`);
  }
}
for (const [name, list] of [['heartbeat', hbQueries], ['event batch', batchQueries]]) {
  out.push('', `Statements per ${name}, most database time first (times per ${name}, mean ms):`, '');
  for (const q of list.slice(0, 40)) out.push(`- ${round(q.perOp, 2)} × ${q.meanMs} ms: \`${q.query.slice(0, 140).replace(/`/g, "'")}\``);
}
console.log(out.join('\n'));

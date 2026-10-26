#!/usr/bin/env node
// What one heartbeat and one event batch cost the apiserver and the database, from two load test runs on the same
// fleet: one with heartbeats only (-event-rate 0) and one with events besides (README.md, "Per-operation baseline").
// The optimisation tasks re-run the same pair and compare with the baseline README.md records.
//
//   node scripts/runner-link/loadgen-baseline.mjs <heartbeats-only run> <heartbeats-and-events run> [--full <run>] [--json out.json]
//     [--target-events 2000] [--live <run>]
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
//
// Per event is a batch's cost over its events. The ingest's own rate is what the run adds to the heartbeats: its commits
// and statements a second, and, with --target-events, the same per event at that many events a second, linear in events
// (an upper bound for merged calls, which carry more batches a call as the rate grows). When the gateway merged the
// batches (src/link-gateway/events_merge.go), its calls are reported beside them: batches a call, and how long each
// call's transaction held its sessions.
//
// With --live, a run like the second (the same fleet and event rate) with watchers and live deltas besides
// (loadgen-run.sh --watch N, loadgen -live-rate; task O3): what one forwarded delta costs, as what that run adds to the
// second over the deltas the watchers received a second. The watchers' streams themselves (their pings, and the durable
// events they are sent too) are in it, so it is an upper bound per delta. On a stack of two apiservers, "apiserver" is
// the two together.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : null;
};
const jsonOut = option('--json');
const fullDir = option('--full');
const liveDir = option('--live');
const target = option('--target-events');
const targetEvents = target === null ? null : Number(target);
if (args.length !== 2 || (targetEvents !== null && !(targetEvents > 0))) {
  console.error('usage: loadgen-baseline.mjs <heartbeats-only run> <heartbeats-and-events run> [--full <run>] [--json out.json] '
    + '[--target-events N] [--live <run>]');
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
  // Every statement's calls (pgss-totals.json); a run recorded before loadgen-run.sh kept them has the 60 listed alone,
  // which miss whatever a varying statement text pushes off the list.
  const totals = existsSync(join(dir, 'pgss-totals.json')) ? read('pgss-totals.json') : null;
  return {
    dir, report, summary, statements, totals, run: read('run.json'),
    commits: after.xactCommit - before.xactCommit,
    calls: totals ? Number(totals.calls) : statements.reduce((n, q) => n + q.calls, 0),
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
const liveRun = liveDir ? load(liveDir) : null;
for (const r of [hb, ev, full, liveRun].filter(Boolean)) {
  if (!r.steady) throw new Error(`${r.dir} has no steady window`);
  if (r.report.loadgen.config.runners !== hb.report.loadgen.config.runners) throw new Error('the runs played different fleets');
}
for (const r of [hb, full].filter(Boolean)) {
  if (r.steady.counters.batchesAcked !== 0) throw new Error(`${r.dir} sent events: run it with -event-rate 0`);
}
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
// A stack of two apiservers (ORBIT_LINK_STAGING_BACKENDS=2) is one apiserver's worth of work in two processes.
const cores = (r, svc) => (r.report.components[svc]?.meanCores ?? 0) + (svc === 'apiserver' ? r.report.components['apiserver-b']?.meanCores ?? 0 : 0);
// A host swapping during a run inflates its CPU figures: on 2026-10-25 a heartbeats-only run swapping in about 1,100
// pages/s measured 12% more database CPU than its repeat at 2 pages/s. Each run's swap-in over its steady window is
// reported, and a run past HEAVY_SWAP_IN pages/s is to be run again rather than compared.
const HEAVY_SWAP_IN = 100;
const swapInPerSec = (r) => {
  const secs = (Number(new Date(r.report.steadyTo)) - Number(new Date(r.report.steadyFrom))) / 1000;
  return r.report.host?.swapInPages == null || !(secs > 0) ? null : round(r.report.host.swapInPages / secs, 0);
};
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

// Per forwarded live delta (--live): what the live run adds to the events run, over the deltas the watchers received.
let perLiveDelta = null;
if (liveRun) {
  const lv = liveRun.report.live;
  if (!lv?.watchers?.deltasPerSecond) throw new Error(`${liveRun.dir} has no live deltas received by watchers (loadgen-run.sh --watch, loadgen -live-rate)`);
  if (liveRun.report.loadgen.config.eventRate !== ev.report.loadgen.config.eventRate) throw new Error('the live run and the events run sent events at different rates');
  const rate = lv.watchers.deltasPerSecond;
  const per = (svc) => round(((cores(liveRun, svc) - cores(ev, svc)) * 1000) / rate, 4);
  perLiveDelta = {
    run: liveRun.report.run, deltasPerSecond: rate, watchedSessions: lv.watchers.sessions, receivedShare: lv.watchers.receivedShare,
    deltasPerLiveBatch: lv.loadgen.eventsPerBatch, deltasPerSseMessage: lv.watchers.deltasPerTextMessage,
    apiserverCpuMs: per('apiserver'), gatewayCpuMs: per('link-gateway'), natsCpuMs: per('nats'), webGatewayCpuMs: per('gateway'),
    databaseCpuMs: per('postgres'), delayMs: lv.watchers.delayMs, swapInPagesPerSec: swapInPerSec(liveRun),
  };
}

const run = hb.report;
const baseline = {
  commit: run.sha, runs: [hb.report.run, ev.report.run], loadTestLock: [hb, ev].map((r) => r.report.loadTestLock ?? null), fleet: { runners: run.loadgen.config.runners,
    activeSessions: ev.report.loadgen.config.activeSessions, perSessionEventsPerSecond: ev.report.loadgen.config.perSessionRate },
  rates: { heartbeatsOnly: { beatsPerSec }, withEvents: { beatsPerSec: evBeatsPerSec, batchesPerSec, eventsPerSec: ev.steady.eventsAckedPerSecond } },
  hostOtherCores: [hb.report.host.otherCgroupCores, ev.report.host.otherCgroupCores],
  swapInPagesPerSec: [swapInPerSec(hb), swapInPerSec(ev)],
  perHeartbeat: perBeat, perBatch, perEvent, ingest, projected, merged, ...(split ? { perHeartbeatByKind: split } : {}),
  ...(perLiveDelta ? { perLiveDelta } : {}),
  eventAck: { runnerBatch: ev.steady.ackBatch, gateway: gwOf.eventAck },
  heartbeatStatements: hbQueries.map((q) => ({ perOp: round(q.perOp, 2), meanMs: q.meanMs, query: q.query.slice(0, 200) })),
  batchStatements: batchQueries.map((q) => ({ perOp: round(q.perOp, 2), meanMs: q.meanMs, query: q.query.slice(0, 200) })),
};
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(baseline, null, 2) + '\n');

const out = [];
out.push(`Commit \`${run.sha.slice(0, 12)}\`, runs ${baseline.runs.join(' and ')}: ${baseline.fleet.runners} runners, ${baseline.fleet.activeSessions} running sessions.`);
const unlocked = [hb, ev, full].filter(Boolean).filter((r) => r.report.loadTestLock !== true).map((r) => r.report.run);
out.push(unlocked.length === 0 ? "Every run held the host's load test lock." : `Not under the host's load test lock: ${unlocked.join(', ')}.`);
// The CPUs the stack's containers were confined to, run by run: a light run's CPU time depends on the kind of core.
const cpusets = [hb, ev, full].filter(Boolean).map((r) => [...new Set(Object.values(r.run.containers ?? {}).map((c) => c.cpuset || 'any'))].join('/'));
out.push(new Set(cpusets).size === 1 ? `The containers ran on CPUs ${cpusets[0]} in every run.` : `The containers ran on CPUs ${cpusets.join(', ')}, run by run.`);
out.push(`Heartbeats only: ${beatsPerSec} beats/s. With events: ${evBeatsPerSec} beats/s, ${batchesPerSec} batches/s (${perBatch.eventsPerBatch} events each, ${ev.steady.eventsAckedPerSecond} events/s).`);
const heavy = [hb, ev].filter((r, i) => baseline.swapInPagesPerSec[i] > HEAVY_SWAP_IN).map((r) => r.report.run);
out.push(`Host swap-in over the steady windows: ${baseline.swapInPagesPerSec.join(' and ')} pages/s`
  + (heavy.length ? `: **${heavy.join(' and ')} swapped past ${HEAVY_SWAP_IN} pages/s, which inflates CPU; run it again**.` : '.'));
const listedOnly = [hb, ev].filter((r) => !r.totals).map((r) => r.report.run);
if (listedOnly.length) out.push(`Statements of ${listedOnly.join(' and ')} are the 60 listed alone (no pgss-totals.json): a lower bound.`);
out.push('');
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
if (perLiveDelta) {
  const d = perLiveDelta;
  out.push('', `Per forwarded live delta, from ${d.run} against ${ev.report.run}: ${d.deltasPerSecond} deltas/s reached ${d.watchedSessions} watched sessions `
    + `(${d.receivedShare} of those sent; ${d.deltasPerLiveBatch} a LiveBatch, ${d.deltasPerSseMessage} an SSE message); swap-in ${d.swapInPagesPerSec} pages/s.`, '');
  out.push('| Per live delta | apiserver CPU ms | link gateway CPU ms | NATS CPU ms | web gateway CPU ms | database CPU ms |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  out.push(`| delta | ${d.apiserverCpuMs} | ${d.gatewayCpuMs} | ${d.natsCpuMs} | ${d.webGatewayCpuMs} | ${d.databaseCpuMs} |`);
  out.push('', `Delay from production to the watcher: p50 ${d.delayMs.p50} ms, p99 ${d.delayMs.p99} ms, max ${d.delayMs.max} ms.`);
}
for (const [name, list] of [['heartbeat', hbQueries], ['event batch', batchQueries]]) {
  out.push('', `Statements per ${name}, most database time first (times per ${name}, mean ms):`, '');
  for (const q of list.slice(0, 40)) out.push(`- ${round(q.perOp, 2)} × ${q.meanMs} ms: \`${q.query.slice(0, 140).replace(/`/g, "'")}\``);
}
console.log(out.join('\n'));

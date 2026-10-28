#!/usr/bin/env node
// Where a load test's session streams were held, apiserver by apiserver (task 34nb3xgCijTDzQJVXDVT7): loadgen-run.sh
// writes it beside report.md, as streams.md, and the figures as streams.json.
//
//   node scripts/runner-link/loadgen-streams.mjs <run dir> > streams.md
//
// It reads nats.jsonl, NATS's clients every 5 s. An apiserver subscribes to a session's live stream (ses.<id>.live,
// src/apiserver/src/realtime/runner-hints.ts) while it has a stream of that session open, and the gateway publishes a
// session's deltas there alone, so each apiserver's subscriptions are the sessions whose streams it holds, and what
// NATS delivered to it is what it relayed. With them: each apiserver's main thread (threads.jsonl), the watchers' view
// of each session (watch.json, loadgen-watch.mjs), and the run's settings (run.json). Over the steady window when the
// run had one (summary.json), else the whole run.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: loadgen-streams.mjs <run dir>');
  process.exit(2);
}
const read = (name) => readFileSync(join(dir, name), 'utf8');
const has = (name) => existsSync(join(dir, name));
const jsonl = (name) => (has(name) ? read(name).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const round = (v, d = 1) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

const run = JSON.parse(read('run.json'));
const summary = has('summary.json') ? JSON.parse(read('summary.json')) : {};
const from = Date.parse(summary.steadyStartedAt ?? summary.startedAt ?? 0) || 0;
const to = Date.parse(summary.steadyEndedAt ?? summary.endedAt ?? 0) || Number.MAX_SAFE_INTEGER;
const steady = Boolean(summary.steadyStartedAt);
const samples = jsonl('nats.jsonl');
if (samples.length === 0) {
  console.log(`# Session streams of ${run.name}\n\nNo NATS samples (nats.jsonl): this run did not record them.`);
  process.exit(0);
}

/** Each sample as the apiservers saw it: name -> { outMsgs, sessions: Map(sessionId -> live messages delivered) }. */
const views = samples.map((s) => {
  const byName = new Map();
  for (const c of s.clients ?? []) {
    const name = s.apiservers?.[c.ip];
    if (!name) continue;
    const v = byName.get(name) ?? { outMsgs: 0, sessions: new Map() };
    v.outMsgs += c.outMsgs ?? 0;
    for (const l of c.live ?? []) v.sessions.set(l.s, (v.sessions.get(l.s) ?? 0) + (l.m ?? 0));
    byName.set(name, v);
  }
  return { t: s.t, byName };
});
const names = [...new Set(views.flatMap((v) => [...v.byName.keys()]))].sort((a, b) =>
  (a === 'apiserver' ? '' : a).localeCompare(b === 'apiserver' ? '' : b));
const inWindow = views.filter((v) => v.t >= from && v.t <= to);
const window = inWindow.length >= 2 ? inWindow : views;
const secs = (window.at(-1).t - window[0].t) / 1000;

// What NATS delivered to each, summed sample to sample: a count that went down is a new connection (the apiserver was
// started again), which counts from zero.
const delivered = (name) => {
  let n = 0;
  for (let i = 1; i < window.length; i += 1) {
    const [a, b] = [window[i - 1].byName.get(name)?.outMsgs ?? 0, window[i].byName.get(name)?.outMsgs ?? 0];
    n += b >= a ? b - a : b;
  }
  return n;
};
// Each apiserver's main thread over the window, as report.md has it.
const threads = jsonl('threads.jsonl').filter((s) => s.t >= window[0].t && s.t <= window.at(-1).t);
const mainThread = (name) => {
  const pts = threads.filter((s) => s[name]);
  const [a, b] = [pts[0], pts.at(-1)];
  if (!a || !b || a === b || a[name].pid !== b[name].pid) return null;
  const s = (b.t - a.t) / 1000;
  return { busy: round((b[name].mainTicks - a[name].mainTicks) / b.clkTck / s, 3), process: round((b[name].processTicks - a[name].processTicks) / b.clkTck / s, 3) };
};

const perApiserver = names.map((name) => {
  const counts = window.map((v) => v.byName.get(name)?.sessions.size ?? 0);
  return {
    name,
    sessions: { min: Math.min(...counts), max: Math.max(...counts), atEnd: counts.at(-1) },
    deliveredPerSecond: secs > 0 ? round(delivered(name) / secs, 1) : null,
    mainThread: mainThread(name),
  };
});

// A session held by two apiservers at once, in any sample, and each session's moves from one to another.
const twice = new Map();
const moves = [];
const last = new Map();
for (const v of views) {
  const holders = new Map();
  for (const [name, view] of v.byName) {
    for (const id of view.sessions.keys()) holders.set(id, [...(holders.get(id) ?? []), name]);
  }
  for (const [id, hs] of holders) {
    if (hs.length > 1 && !twice.has(id)) twice.set(id, { at: new Date(v.t).toISOString(), apiservers: hs });
    const was = last.get(id);
    if (hs.length === 1 && was && was !== hs[0]) moves.push({ session: id, from: was, to: hs[0], at: new Date(v.t).toISOString() });
    if (hs.length === 1) last.set(id, hs[0]);
  }
}
const movesByPair = {};
for (const m of moves) movesByPair[`${m.from} -> ${m.to}`] = (movesByPair[`${m.from} -> ${m.to}`] ?? 0) + 1;

// What the watchers saw, session by session (loadgen-watch.mjs).
let watchers = null;
if (has('watch.json')) {
  const w = JSON.parse(read('watch.json'));
  const sessions = Object.values(w.bySession ?? {});
  const after = sessions.flatMap((s) => s.resumes.map((r) => r.deltaAfterMs)).sort((a, b) => a - b);
  const q = (p) => (after.length ? after[Math.min(after.length - 1, Math.floor(p * after.length))] : null);
  watchers = {
    sessions: sessions.length, streamsPerSession: w.streamsPerSession ?? 1,
    opened: sessions.reduce((n, s) => n + s.opened, 0), ended: sessions.reduce((n, s) => n + s.ended, 0),
    storedEvents: sessions.reduce((n, s) => n + s.stored, 0), late: sessions.reduce((n, s) => n + (s.late ?? 0), 0),
    gaps: sessions.reduce((n, s) => n + s.gaps, 0), sessionsWithGaps: sessions.filter((s) => s.gaps > 0).length,
    openAtStop: sessions.reduce((n, s) => n + (s.openAtStop ?? 0), 0),
    resumes: { count: after.length, deltaAfterMs: { p50: q(0.5), p99: q(0.99), max: after.at(-1) ?? null } },
  };
}

const out = {
  run: run.name, backends: Number(run.backends) || null, spread: run.spread ?? null,
  window: { steady, from: new Date(window[0].t).toISOString(), to: new Date(window.at(-1).t).toISOString(), seconds: round(secs, 1) },
  perApiserver, heldTwice: { sessions: twice.size, first: [...twice].slice(0, 10).map(([id, x]) => ({ session: id, ...x })) },
  moves: { count: moves.length, byPair: movesByPair, first: moves.slice(0, 20) }, watchers,
};
writeFileSync(join(dir, 'streams.json'), JSON.stringify(out, null, 2) + '\n');

const lines = [];
lines.push(`# Session streams of ${run.name}`, '');
lines.push(`${out.backends ?? '?'} apiserver(s); the web gateway sent session streams ${run.spread === true ? 'to every apiserver, by session (gateway/several-apiservers/)' : run.spread === false ? 'to the first apiserver' : 'as this run did not record'}.`);
lines.push(`Over the ${steady ? 'steady window' : 'whole run'}, ${out.window.from} → ${out.window.to} (${out.window.seconds} s), from NATS's clients every 5 s.`, '');
lines.push('| apiserver | sessions it held streams of (min, max, at the end) | NATS messages delivered to it per second | main thread busy (cores) | process (cores) |');
lines.push('| --- | --- | --- | --- | --- |');
for (const a of perApiserver) {
  lines.push(`| ${a.name} | ${a.sessions.min}, ${a.sessions.max}, ${a.sessions.atEnd} | ${a.deliveredPerSecond} | ${a.mainThread?.busy ?? '—'} | ${a.mainThread?.process ?? '—'} |`);
}
lines.push('', `Sessions held by two apiservers at once, in any sample of the run: ${twice.size}.`);
for (const x of out.heldTwice.first) lines.push(`- ${x.session} at ${x.at}: ${x.apiservers.join(', ')}`);
lines.push('', `Sessions whose streams moved to another apiserver during the run: ${moves.length}.`);
for (const [pair, n] of Object.entries(movesByPair)) lines.push(`- ${pair}: ${n}`);
if (watchers) {
  lines.push('', `Watchers (loadgen-watch.mjs): ${watchers.sessions} sessions, ${watchers.streamsPerSession} stream(s) each; streams opened ${watchers.opened}, ended ${watchers.ended}.`);
  lines.push(`- Stored events received ${watchers.storedEvents}, ${watchers.late} of them after a later one; missed (a gap in a stream's seqs) ${watchers.gaps}, in ${watchers.sessionsWithGaps} session(s); still on their way as the watchers stopped ${watchers.openAtStop}.`);
  lines.push(`- A stream that ended had its next delta, once open again, after (ms): p50 ${watchers.resumes.deltaAfterMs.p50}, p99 ${watchers.resumes.deltaAfterMs.p99}, max ${watchers.resumes.deltaAfterMs.max} (${watchers.resumes.count} times).`);
}
console.log(lines.join('\n'));

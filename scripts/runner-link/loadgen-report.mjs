#!/usr/bin/env node
// The report of one load test run (loadgen-run.sh, task C2): reads what the run collected and writes report.json beside
// it and report.md to standard output. Every figure is taken over the steady window, the span loadgen held the whole
// fleet connected for (summary.json steadyStartedAt..steadyEndedAt), unless it says otherwise.
//
//   node scripts/runner-link/loadgen-report.mjs <run directory> > report.md
//
// The criteria are the task's: the fleet connected, about 500 heartbeats and 2,000 durable events a second, for the
// window; no error anywhere; the EventAck latency's p99 under 1 s; the database's CPU peak under 60% of its allocation.
// "Anywhere" is what each part can report:
//   - the runners (loadgen): every connection ended unasked, refusal, failed, refused or late acknowledgement;
//   - the link gateway: its counters of refused handshakes, abnormal disconnects, calls without an answer, beats and
//     batches not stored, full queues, and its own WARN and ERROR log lines;
//   - the apiserver: ERROR log lines, and any 5xx the web gateway served (the link tokens come through it);
//   - the database: ERROR, FATAL and PANIC log lines, and deadlocks;
//   - NATS: [ERR] log lines.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: loadgen-report.mjs <run directory>');
  process.exit(2);
}
const read = (name) => readFileSync(join(dir, name), 'utf8');
const json = (name) => JSON.parse(read(name));
// A systemd unit name escapes its dashes as \x2d, which an older sampler wrote into the JSON unescaped.
const jsonl = (name) => (existsSync(join(dir, name))
  ? read(name).split('\n').filter(Boolean).map((l) => JSON.parse(l.replace(/(?<!\\)\\x([0-9a-fA-F]{2})/g, '\\\\x$1')))
  : []);

const run = json('run.json');
const summary = json('summary.json');
const series = jsonl('series.jsonl');
const samples = jsonl('samples.jsonl');
const slices = jsonl('slices.jsonl');
const dbSamples = jsonl('db.jsonl');
const steadyFrom = Date.parse(summary.steadyStartedAt ?? summary.startedAt);
const steadyTo = Date.parse(summary.steadyEndedAt ?? summary.endedAt);
const inSteady = (t) => t >= steadyFrom && t <= steadyTo;
const round = (v, d = 1) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
// The other apiservers the run sampled come after apiserver-b: apiserver-c and on (ORBIT_LINK_STAGING_BACKENDS of 3 or
// more), or a deployment override's replicas, apiserver-2 and on.
const moreApiservers = [...new Set(samples.flatMap((s) => Object.keys(s)).filter((k) => /^apiserver-[a-z0-9]+$/.test(k) && k !== 'apiserver-b'))].sort();
const STACK = ['postgres', 'apiserver', 'apiserver-b', ...moreApiservers, 'link-gateway', 'gateway', 'nats'];

// --- CPU from the 5 s samples. -----------------------------------------------------------------------------------------
// Samples at the window's edges are included one interval out, so every second of the window is covered. A mean counts
// each interval for the part of it inside the window (`w`): counted whole, the interval after the window's end, in which
// the loadgen stops, took up to 5% off a run's mean cores, by how the samples happened to fall (O2, 2026-10-26).
const covering = samples.filter((s) => s.t >= steadyFrom - 6000 && s.t <= steadyTo + 6000);
const insideUs = (from, to) => Math.max(0, Math.min(to, steadyTo) - Math.max(from, steadyFrom)) * 1000;
// What a cgroup's counter added from one sample to the next. A container that restarted in between (an OOM kill, or a
// kill and `docker start`) counts again from zero in a new cgroup of the same name: a value lower than the one before it
// is what the new one counted, the old one's last moments unseen, as Prometheus' increase() takes a reset.
const added = (from, to) => (to >= from ? to - from : to);
function cpuSeries(key, field = 'cpuUsec') {
  const out = [];
  for (let i = 1; i < covering.length; i++) {
    const a = covering[i - 1][key];
    const b = covering[i][key];
    if (!a || !b) continue;
    const dt = (covering[i].t - covering[i - 1].t) * 1000;
    if (dt <= 0) continue;
    out.push({ t: covering[i].t, dt, w: insideUs(covering[i - 1].t, covering[i].t), v: added(a[field], b[field]) / dt, mem: b.memBytes });
  }
  return out;
}
// The highest average over any span of at least `spanMs` (a point's dt is in microseconds).
function peak(points, spanMs) {
  const span = spanMs * 1000;
  let best = 0;
  for (let i = 0; i < points.length; i++) {
    let used = 0;
    let time = 0;
    for (let j = i; j < points.length && time < span; j++) {
      used += points[j].v * points[j].dt;
      time += points[j].dt;
    }
    if (time >= span * 0.9) best = Math.max(best, used / time);
  }
  return best;
}
function mean(points) {
  const used = points.reduce((n, p) => n + p.v * (p.w ?? p.dt), 0);
  const time = points.reduce((n, p) => n + (p.w ?? p.dt), 0);
  return time > 0 ? used / time : null;
}
const components = {};
for (const key of [...STACK, 'loadgen']) {
  const cpu = cpuSeries(key);
  if (cpu.length === 0) continue;
  const psi = cpuSeries(key, 'psiSomeUsec');
  const thr = cpuSeries(key, 'throttledUsec');
  components[key] = {
    meanCores: round(mean(cpu), 3),
    peak10sCores: round(peak(cpu, 10_000), 2),
    peak60sCores: round(peak(cpu, 60_000), 2),
    peakMemMiB: round(Math.max(...cpu.map((p) => p.mem ?? 0)) / 2 ** 20, 0),
    // Share of the window some task of the container was ready to run and waited for a CPU (PSI "some").
    cpuPressurePct: round(100 * mean(psi), 1),
    cpuPressurePeak60sPct: round(100 * peak(psi, 60_000), 1),
    throttledPct: round(100 * mean(thr), 1),
  };
}

// Each apiserver's main thread over the window (threads.jsonl, task O3): how busy it was, in cores, and its share of its
// process's CPU. A Node process's main thread is what fills, so it is what a process carries. Only for a run that
// recorded it: the report of an older run is what it was.
const threads = jsonl('threads.jsonl').filter((s) => s.t >= steadyFrom && s.t <= steadyTo);
if (threads.length >= 2) {
  const [a, b] = [threads[0], threads.at(-1)];
  const secs = (b.t - a.t) / 1000;
  for (const key of Object.keys(b)) {
    if (!components[key] || !a[key] || a[key].pid !== b[key].pid || !(secs > 0)) continue;
    const main = (b[key].mainTicks - a[key].mainTicks) / b.clkTck;
    const all = (b[key].processTicks - a[key].processTicks) / b.clkTck;
    components[key].mainThreadBusy = round(main / secs, 3);
    components[key].mainThreadShare = all > 0 ? round(main / all, 3) : null;
  }
}

// The host: busy CPUs from /proc/stat, and what of that was not this test.
const host = { cpus: run.hostCpus };
{
  const busy = [];
  for (let i = 1; i < covering.length; i++) {
    const a = covering[i - 1].host.cpu;
    const b = covering[i].host.cpu;
    const total = b.reduce((n, v, k) => n + v - a[k], 0);
    const idle = b[3] - a[3] + (b[4] - a[4]);
    if (total <= 0) continue;
    busy.push({ t: covering[i].t, dt: (covering[i].t - covering[i - 1].t) * 1000, v: ((total - idle) / total) * run.hostCpus });
  }
  host.meanBusyCores = round(mean(busy), 1);
  host.peak60sBusyCores = round(peak(busy, 60_000), 1);
  const ours = Object.values(components).reduce((n, c) => n + (c.meanCores ?? 0), 0);
  host.testMeanCores = round(ours, 1);
  host.otherMeanCores = round(host.meanBusyCores - ours, 1);
  const loads = covering.map((s) => s.host.load[0]);
  host.load1 = { min: round(Math.min(...loads), 1), mean: round(loads.reduce((n, v) => n + v, 0) / loads.length, 1), max: round(Math.max(...loads), 1) };
  const psi = [];
  for (let i = 1; i < covering.length; i++) {
    psi.push({ dt: (covering[i].t - covering[i - 1].t) * 1000, v: (covering[i].host.psiSomeUsec - covering[i - 1].host.psiSomeUsec) / ((covering[i].t - covering[i - 1].t) * 1000) });
  }
  host.cpuPressurePct = round(100 * mean(psi), 1);
  host.memAvailMinMiB = round(Math.min(...covering.map((s) => s.host.memAvailKb)) / 1024, 0);
  host.swapFreeMinMiB = round(Math.min(...covering.map((s) => s.host.swapFreeKb)) / 1024, 0);
  const first = covering[0]?.host;
  const last = covering.at(-1)?.host;
  host.swapInPages = last && first ? last.pswpin - first.pswpin : null;
  host.swapOutPages = last && first ? last.pswpout - first.pswpout : null;
}
// The host's memory over the whole run, ramp included: when it started to swap, and with how many runners connected.
const runFrom = Date.parse(summary.startedAt);
const connectedAt = (t) => {
  let n = 0;
  for (const l of series) if (Date.parse(l.at) <= t + 5000) n = l.connected;
  return n;
};
const memory = [];
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1];
  const b = samples[i];
  const secs = (b.t - a.t) / 1000;
  if (secs <= 0) continue;
  memory.push({ t: b.t, elapsedS: round((b.t - runFrom) / 1000, 0), connected: connectedAt(b.t), memAvailMiB: Math.round(b.host.memAvailKb / 1024),
    swapOutPagesPerS: Math.round((b.host.pswpout - a.host.pswpout) / secs), swapInPagesPerS: Math.round((b.host.pswpin - a.host.pswpin) / secs) });
}
// A page is 4 KiB: 256 pages a second is 1 MiB/s, 2,560 is 10 MiB/s.
const swapOnset = (pages) => {
  const m = memory.find((x) => x.t >= runFrom && x.swapOutPagesPerS >= pages);
  return m ? { at: new Date(m.t).toISOString(), elapsedS: m.elapsedS, connected: m.connected, memAvailMiB: m.memAvailMiB, swapOutPagesPerS: m.swapOutPagesPerS } : null;
};
host.swapFrom1MiBs = swapOnset(256);
host.swapFrom10MiBs = swapOnset(2560);
host.swapOutPeak = memory.reduce((best, m) => (m.swapOutPagesPerS > (best?.swapOutPagesPerS ?? -1) ? m : best), null);

// What else used the host's CPUs, by service and container, from slices.jsonl.
const others = [];
{
  const within = slices.filter((s) => s.t >= steadyFrom - 16000 && s.t <= steadyTo + 16000);
  if (within.length >= 2) {
    const a = within[0];
    const b = within.at(-1);
    const span = (b.t - a.t) * 1000;
    // This test's own containers and its loadgen are named as such; everything else is what shared the host.
    const ours = new Map(Object.entries(run.containers ?? {}).map(([svc, c]) => [c.cgroup, svc]));
    ours.set(`c2-loadgen-${run.name}.scope`, 'loadgen');
    // One of this test's containers that restarted in the window counts again from zero, so what it used is added up over
    // each 15 s, as its 5 s samples are. What else ran on the host is read from the window's two ends.
    const usedOver = (name) => {
      let used = 0;
      let prev = a[name];
      for (const s of within) {
        if (typeof s[name] !== 'number') continue;
        used += added(prev, s[name]);
        prev = s[name];
      }
      return used;
    };
    let elsewhere = 0;
    for (const [name, end] of Object.entries(b)) {
      if (name === 't' || typeof a[name] !== 'number') continue;
      const svc = ours.get(name);
      const cores = (svc ? usedOver(name) : end - a[name]) / span;
      if (!svc) elsewhere += cores;
      others.push({ name: svc ? `${name} (this test: ${svc})` : name, meanCores: round(cores, 2), ours: !!svc });
    }
    others.sort((x, y) => y.meanCores - x.meanCores);
    host.otherCgroupCores = round(elsewhere, 1);
  }
}

// --- The gateway's counters over the window. ---------------------------------------------------------------------------
function parseScrapes() {
  if (!existsSync(join(dir, 'metrics.prom'))) return [];
  const scrapes = [];
  let cur = null;
  for (const line of read('metrics.prom').split('\n')) {
    const m = /^# scrape (\d+)$/.exec(line);
    if (m) {
      cur = { t: Number(m[1]), values: new Map() };
      scrapes.push(cur);
      continue;
    }
    if (!cur || line === '' || line.startsWith('#')) continue;
    const sp = line.lastIndexOf(' ');
    cur.values.set(line.slice(0, sp), Number(line.slice(sp + 1)));
  }
  return scrapes;
}
const scrapes = parseScrapes();
const firstScrape = scrapes.filter((s) => s.t <= steadyFrom + 15_000).at(-1) ?? scrapes[0];
const lastScrape = scrapes.filter((s) => s.t <= steadyTo + 15_000).at(-1) ?? scrapes.at(-1);
// A counter's increase from the first scrape to the last. A gateway that restarted in between (an OOM kill, a kill and
// `docker start`) counts again from zero: a scrape whose link_gateway_start_time_seconds differs from the one before it
// is a new process, and all it counted is added, as Prometheus' increase() takes a reset. Without a restart this is
// the last value less the first, as before.
const between = scrapes.slice(scrapes.indexOf(firstScrape), scrapes.indexOf(lastScrape) + 1);
const startOf = (s) => s.values.get('link_gateway_start_time_seconds');
const restarted = between.some((s, i) => i > 0 && startOf(s) !== startOf(between[i - 1]));
const delta = (key) => {
  if (!restarted) return (lastScrape?.values.get(key) ?? 0) - (firstScrape?.values.get(key) ?? 0);
  let total = 0;
  for (let i = 1; i < between.length; i++) {
    const b = between[i].values.get(key) ?? 0;
    total += startOf(between[i]) !== startOf(between[i - 1]) ? b : b - (between[i - 1].values.get(key) ?? 0);
  }
  return total;
};
// The series counted: the last scrape's, and after a restart those of the earlier processes too. A series appears at its
// first count, so one that only an earlier process counted is not in the last scrape.
const seriesKeys = new Set(lastScrape?.values.keys() ?? []);
if (restarted) for (const s of between) for (const key of s.values.keys()) seriesKeys.add(key);
const counterFamily = (family) => {
  const out = {};
  for (const key of seriesKeys) {
    if (key.startsWith(family + '{') || key === family) {
      const d = delta(key);
      if (d !== 0) out[key.slice(family.length) || '_'] = d;
    }
  }
  return out;
};
const gw = {};
for (const family of ['link_handshakes_total', 'link_token_refusals_total', 'link_disconnects_total', 'link_rpc_results_total',
  'link_backend_calls_total', 'link_backend_retries_total', 'link_heartbeat_forwards_total', 'link_heartbeat_facts_total',
  'link_event_batches_total', 'link_events_stored_total', 'link_queue_full_total', 'link_credit_changes_total',
  'link_hints_total', 'link_hints_slow_total', 'link_frame_decode_errors_total', 'link_tls_handshake_errors_total',
  'link_nats_reconnects_total', 'link_revocation_fetches_total', 'link_turn_prefix_requests_total',
  'link_event_merge_calls_total', 'link_event_merge_flushes_total', 'link_event_merge_alone_total']) {
  gw[family] = counterFamily(family);
}
const steadyScrapes = scrapes.filter((s) => inSteady(s.t));
gw.connections = {
  min: steadyScrapes.length ? Math.min(...steadyScrapes.map((s) => s.values.get('link_connections') ?? 0)) : null,
  max: steadyScrapes.length ? Math.max(...steadyScrapes.map((s) => s.values.get('link_connections') ?? 0)) : null,
};
gw.ingestQueueEventsMax = steadyScrapes.length ? Math.max(...steadyScrapes.map((s) => s.values.get('link_ingest_queue_events') ?? 0)) : null;
gw.creditReducedEver = steadyScrapes.some((s) => (s.values.get('link_credit_reduced') ?? 0) > 0);
function histogram(name) {
  const buckets = [];
  for (const key of lastScrape?.values.keys() ?? []) {
    const m = new RegExp(`^${name}_bucket\\{le="([^"]+)"\\}$`).exec(key);
    if (m) buckets.push({ le: m[1] === '+Inf' ? Infinity : Number(m[1]), n: delta(key) });
  }
  buckets.sort((a, b) => a.le - b.le);
  const count = delta(`${name}_count`);
  const sum = delta(`${name}_sum`);
  const within = (bound) => {
    const b = buckets.find((x) => x.le >= bound);
    return count > 0 && b ? b.n / count : null;
  };
  // A quantile by linear interpolation inside its bucket: as precise as the buckets are.
  const quantile = (q) => {
    if (count === 0) return null;
    const target = q * count;
    let prevLe = 0;
    let prevN = 0;
    for (const b of buckets) {
      if (b.n >= target) {
        if (b.le === Infinity) return prevLe;
        return prevLe + ((target - prevN) / Math.max(b.n - prevN, 1)) * (b.le - prevLe);
      }
      prevLe = b.le;
      prevN = b.n;
    }
    return null;
  };
  return { count, meanMs: count ? round((sum / count) * 1000, 2) : null, p50Ms: round(quantile(0.5) * 1000, 1),
    p99Ms: round(quantile(0.99) * 1000, 1), withinOneSecondPct: round(100 * within(1), 3) };
}
gw.eventAck = histogram('link_event_ack_duration_seconds');
gw.heartbeatForward = histogram('link_heartbeat_forward_duration_seconds');
gw.backendCall = histogram('link_backend_call_duration_seconds');
// Merged ingest (src/link-gateway/events_merge.go): how many batches a call carried, how long its transaction held its
// sessions (the apiserver's heldMs), and the call's own duration. None of them moves when the gateway merges nothing.
gw.mergeCalls = delta('link_event_merge_batches_count');
gw.mergeBatchesPerCall = gw.mergeCalls > 0 ? round(delta('link_event_merge_batches_sum') / gw.mergeCalls, 1) : null;
gw.mergeHeld = histogram('link_event_merge_held_seconds');
gw.mergeCall = histogram('link_event_merge_call_duration_seconds');
// The live stream (task O3): the loadgen's deltas (-live-rate), what the gateway did with them, and what the watchers
// (loadgen-run.sh --watch, loadgen-watch.mjs) received and how late. Only for a run that had either: the report of a run
// without them is what it was before.
let live = null;
if ((summary.config.liveRate ?? 0) > 0 || existsSync(join(dir, 'watch.jsonl'))) {
  // A watch line covers its interval, from..t, every 10 s: the lines whose interval lies inside the window (to a second),
  // and not the last one, written as the watchers stopped.
  const lines = jsonl('watch.jsonl').filter((l) => !l.final && l.from >= steadyFrom - 1000 && l.t <= steadyTo + 1000);
  const secs = lines.reduce((n, l) => n + (l.t - l.from) / 1000, 0);
  const delay = {};
  const messages = {};
  const errors = {};
  let deltas = 0;
  for (const l of lines) {
    deltas += l.deltas;
    for (const [ms, n] of Object.entries(l.delayMs)) delay[ms] = (delay[ms] ?? 0) + n;
    for (const [type, n] of Object.entries(l.messages)) messages[type] = (messages[type] ?? 0) + n;
    for (const [kind, n] of Object.entries(l.errors)) errors[kind] = (errors[kind] ?? 0) + n;
  }
  const sorted = Object.entries(delay).map(([ms, n]) => [Number(ms), n]).sort((a, b) => a[0] - b[0]);
  const quantile = (q) => {
    let seen = 0;
    for (const [ms, n] of sorted) {
      seen += n;
      if (seen >= q * deltas) return ms;
    }
    return null;
  };
  const watch = existsSync(join(dir, 'watch.json')) ? json('watch.json') : null;
  const openMs = watch?.openMs ?? [];
  const steadyLines = series.filter((l) => l.phase === 'steady');
  const window = summary.steady ?? summary.whole;
  const c = window.counters;
  live = {
    loadgen: { liveRate: summary.config.liveRate ?? 0, sentPerSecond: window.liveEventsSentPerSecond ?? 0, produced: c.liveEventsProduced ?? 0,
      sent: c.liveEventsSent ?? 0, dropped: c.liveEventsDropped ?? 0, batches: c.liveBatchesSent ?? 0,
      eventsPerBatch: c.liveBatchesSent ? round(c.liveEventsSent / c.liveBatchesSent, 2) : null, turnPrefixAnswers: c.turnPrefixAnswers ?? 0,
      watched: { min: steadyLines.length ? Math.min(...steadyLines.map((l) => l.watched ?? 0)) : null,
        max: steadyLines.length ? Math.max(...steadyLines.map((l) => l.watched ?? 0)) : null } },
    gateway: { liveEvents: counterFamily('link_live_events_total'), turnPrefixRequests: counterFamily('link_turn_prefix_requests_total'),
      watchedSessions: { min: steadyScrapes.length ? Math.min(...steadyScrapes.map((x) => x.values.get('link_watched_sessions') ?? 0)) : null,
        max: steadyScrapes.length ? Math.max(...steadyScrapes.map((x) => x.values.get('link_watched_sessions') ?? 0)) : null } },
    watchers: { sessions: watch?.sessions ?? null, seconds: round(secs, 1), open: { min: lines.length ? Math.min(...lines.map((l) => l.open)) : null },
      deltas, deltasPerSecond: secs ? round(deltas / secs, 1) : null,
      messagesPerSecond: Object.fromEntries(Object.entries(messages).map(([k, n]) => [k, secs ? round(n / secs, 1) : null])),
      deltasPerTextMessage: messages.text_delta ? round(deltas / messages.text_delta, 2) : null,
      delayMs: { p50: quantile(0.5), p90: quantile(0.9), p99: quantile(0.99), p999: quantile(0.999), max: sorted.at(-1)?.[0] ?? null },
      errors, openMs: { count: openMs.length, p50: openMs[Math.floor(openMs.length * 0.5)] ?? null, p99: openMs[Math.floor(openMs.length * 0.99)] ?? null } },
  };
  // Of the deltas the loadgen sent a second over the window, the share the watchers received.
  live.watchers.receivedShare = live.loadgen.sentPerSecond && live.watchers.deltasPerSecond !== null
    ? round(live.watchers.deltasPerSecond / live.loadgen.sentPerSecond, 3) : null;
}

// The gateway counters that are errors when they move.
const gatewayErrors = {};
const flag = (label, n) => {
  if (n > 0) gatewayErrors[label] = n;
};
for (const [k, v] of Object.entries(gw.link_handshakes_total)) if (!k.includes('"ok"')) flag(`handshakes${k}`, v);
for (const [k, v] of Object.entries(gw.link_token_refusals_total)) flag(`token_refusals${k}`, v);
for (const [k, v] of Object.entries(gw.link_disconnects_total)) {
  if (!/"(client_closed|superseded)"/.test(k)) flag(`disconnects${k}`, v);
}
for (const [k, v] of Object.entries(gw.link_rpc_results_total)) if (!k.includes('"2xx"')) flag(`rpc_results${k}`, v);
for (const [k, v] of Object.entries(gw.link_backend_calls_total)) if (!k.includes('"answered"')) flag(`backend_calls${k}`, v);
for (const [k, v] of Object.entries(gw.link_backend_retries_total)) flag(`backend_retries${k}`, v);
for (const [k, v] of Object.entries(gw.link_heartbeat_forwards_total)) if (!k.includes('"forwarded"')) flag(`heartbeat_forwards${k}`, v);
for (const [k, v] of Object.entries(gw.link_event_batches_total)) if (!k.includes('"stored"')) flag(`event_batches${k}`, v);
for (const [k, v] of Object.entries(gw.link_queue_full_total)) flag(`queue_full${k}`, v);
for (const [k, v] of Object.entries(gw.link_frame_decode_errors_total)) flag(`frame_decode_errors${k}`, v);
for (const [k, v] of Object.entries(gw.link_tls_handshake_errors_total)) flag(`tls_handshake_errors${k}`, v);
if (gw.creditReducedEver) flag('credit_reduced', 1);

// --- Logs over the window. ---------------------------------------------------------------------------------------------
const logLines = (svc) => (existsSync(join(dir, 'logs', `${svc}.log`)) ? read(join('logs', `${svc}.log`)).split('\n') : []);
// eslint-disable-next-line no-control-regex
const ansi = /\x1b\[[0-9;]*m/g;
function nestTime(line) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)/.exec(line);
  if (!m) return null;
  let h = Number(m[4]) % 12;
  if (m[7] === 'PM') h += 12;
  return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5]), Number(m[6]));
}
function tally(lines, timeOf, levelOf) {
  const byLevel = {};
  const samplesBy = {};
  for (const raw of lines) {
    const line = raw.replace(ansi, '');
    const t = timeOf(line);
    if (t == null || t < steadyFrom - 1000 || t > steadyTo + 1000) continue;
    const level = levelOf(line);
    if (!level) continue;
    byLevel[level] = (byLevel[level] ?? 0) + 1;
    (samplesBy[level] ??= []).length < 10 && samplesBy[level].push(line.slice(0, 400));
  }
  return { byLevel, samples: samplesBy };
}
const logs = {};
for (const svc of ['apiserver', 'apiserver-b', ...moreApiservers]) {
  const lines = logLines(svc);
  if (lines.length === 0) continue;
  logs[svc] = tally(lines, nestTime, (l) => /\s(LOG|WARN|ERROR|FATAL|DEBUG|VERBOSE)\s\[/.exec(l)?.[1] ?? null);
}
logs['link-gateway'] = tally(logLines('link-gateway'), (l) => {
  const m = /^time=(\S+)/.exec(l);
  return m ? Date.parse(m[1]) : null;
}, (l) => /level=(\w+)/.exec(l)?.[1] ?? null);
logs.postgres = tally(logLines('postgres'), (l) => {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+) UTC/.exec(l);
  return m ? Date.parse(m[1].replace(' ', 'T') + 'Z') : null;
}, (l) => /\b(LOG|WARNING|ERROR|FATAL|PANIC|DETAIL|STATEMENT|HINT):/.exec(l)?.[1] ?? null);
logs.nats = tally(logLines('nats'), (l) => {
  const m = /(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2}\.\d+)/.exec(l);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}Z`) : null;
}, (l) => /\[(INF|WRN|ERR|FTL|DBG|TRC)\]/.exec(l)?.[1] ?? null);
// The web gateway's access log: the link tokens' route, by status.
const nginx = { byStatus: {}, linkToken: { count: 0, byStatus: {} }, samples5xx: [] };
const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
for (const line of logLines('gateway')) {
  const m = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\] "(\S+) (\S+) [^"]*" (\d{3})/.exec(line);
  if (!m) continue;
  const t = Date.UTC(Number(m[3]), months[m[2]], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (t < steadyFrom - 1000 || t > steadyTo + 1000) continue;
  const status = m[10];
  nginx.byStatus[status] = (nginx.byStatus[status] ?? 0) + 1;
  if (m[9].startsWith('/api/runner/link-token')) {
    nginx.linkToken.count++;
    nginx.linkToken.byStatus[status] = (nginx.linkToken.byStatus[status] ?? 0) + 1;
  }
  if (status.startsWith('5') && nginx.samples5xx.length < 10) nginx.samples5xx.push(line.slice(0, 300));
}
const server5xx = Object.entries(nginx.byStatus).filter(([s]) => s.startsWith('5')).reduce((n, [, v]) => n + v, 0);

// --- The database. -----------------------------------------------------------------------------------------------------
const db = {};
{
  const within = dbSamples.filter((s) => inSteady(s.t));
  if (within.length >= 2) {
    const a = within[0];
    const b = within.at(-1);
    const secs = (b.t - a.t) / 1000;
    db.seconds = round(secs, 0);
    db.commitsPerSecond = round((b.xactCommit - a.xactCommit) / secs, 0);
    db.rollbacks = b.xactRollback - a.xactRollback;
    db.rowsInsertedPerSecond = round((b.tupInserted - a.tupInserted) / secs, 0);
    db.rowsUpdatedPerSecond = round((b.tupUpdated - a.tupUpdated) / secs, 0);
    db.walMiBPerSecond = round((b.walBytes - a.walBytes) / secs / 2 ** 20, 2);
    db.deadlocks = b.deadlocks - a.deadlocks;
    db.tempBytes = b.tempBytes - a.tempBytes;
    db.cacheHitPct = round((100 * (b.blksHit - a.blksHit)) / Math.max(1, b.blksHit - a.blksHit + (b.blksRead - a.blksRead)), 2);
    const sessions = within.map((s) => Object.values(s.backends ?? {}).reduce((n, v) => n + v, 0));
    db.backendsMax = Math.max(...sessions);
    db.activeMax = Math.max(...within.map((s) => Object.entries(s.backends ?? {}).filter(([k]) => k.startsWith('active')).reduce((n, [, v]) => n + v, 0)));
    db.lockWaitsMax = Math.max(...within.map((s) => s.lockWaits ?? 0));
  }
  try {
    db.topStatements = json('pgss.json').slice(0, 12).map((q) => ({ calls: q.calls, totalS: round(q.total_ms / 1000, 1), meanMs: q.mean_ms,
      maxMs: q.max_ms, query: q.query.slice(0, 160) }));
  } catch {
    db.topStatements = [];
  }
}

// --- The criteria. -----------------------------------------------------------------------------------------------------
const steady = summary.steady ?? summary.whole;
const dbCpus = Number(run.dbCpus) || 0;
const pgc = components.postgres ?? {};
const allocation = dbCpus > 0 ? dbCpus : null;
const dbPeakPct = allocation ? round((100 * pgc.peak10sCores) / allocation, 1) : null;
const dbPeak60Pct = allocation ? round((100 * pgc.peak60sCores) / allocation, 1) : null;
const steadyLines = series.filter((l) => l.phase === 'steady');
const connectedMin = steadyLines.length ? Math.min(...steadyLines.map((l) => l.connected)) : 0;
const connectedMax = series.length ? Math.max(...series.map((l) => l.connected)) : 0;
const errorCounts = {
  loadgen: steady.errorTotal,
  gateway: Object.values(gatewayErrors).reduce((n, v) => n + v, 0),
  gatewayLogWarnError: (logs['link-gateway'].byLevel.WARN ?? 0) + (logs['link-gateway'].byLevel.ERROR ?? 0),
  apiserverErrorLines: Object.entries(logs).filter(([svc]) => svc.startsWith('apiserver')).reduce((n, [, l]) => n + (l.byLevel.ERROR ?? 0) + (l.byLevel.FATAL ?? 0), 0),
  http5xx: server5xx,
  postgresErrorLines: (logs.postgres.byLevel.ERROR ?? 0) + (logs.postgres.byLevel.FATAL ?? 0) + (logs.postgres.byLevel.PANIC ?? 0),
  deadlocks: db.deadlocks ?? 0,
  natsErrorLines: (logs.nats.byLevel.ERR ?? 0) + (logs.nats.byLevel.FTL ?? 0),
  // The watchers' streams: refused, failed or ended while the run lasted.
  ...(live ? { watchers: Object.values(live.watchers.errors).reduce((n, v) => n + v, 0) } : {}),
};
const totalErrors = Object.values(errorCounts).reduce((n, v) => n + v, 0);
const criteria = [
  { name: 'connections', target: `${summary.config.runners}`,
    measured: summary.steady ? `${connectedMin} (lowest in the window)` : `${connectedMax} at most: the fleet never all connected`,
    pass: summary.steady ? connectedMin >= summary.config.runners : false },
  { name: 'heartbeats per second', target: '≈ 500', measured: `${steady.heartbeatAcksPerSecond}`, pass: steady.heartbeatAcksPerSecond >= 450 },
  { name: 'durable events per second', target: '≈ 2000', measured: `${steady.eventsAckedPerSecond}`, pass: steady.eventsAckedPerSecond >= 1800 },
  { name: 'steady window', target: '1 h', measured: `${round(steady.seconds / 60, 1)} min`, pass: steady.seconds >= 3600 },
  { name: 'errors', target: '0', measured: `${totalErrors}`, pass: totalErrors === 0 },
  { name: 'EventAck p99 (runner side, per batch)', target: '< 1000 ms', measured: `${steady.ackBatch.p99Ms} ms`, pass: steady.ackBatch.p99Ms < 1000 },
  { name: 'EventAck p99 (runner side, per event)', target: '< 1000 ms', measured: `${steady.ackEvent.p99Ms} ms`, pass: steady.ackEvent.p99Ms < 1000 },
  { name: 'EventAck within 1 s (gateway histogram)', target: '≥ 99%', measured: `${gw.eventAck.withinOneSecondPct}%`, pass: gw.eventAck.withinOneSecondPct >= 99 },
  { name: 'database CPU peak (10 s)', target: '< 60%', measured: allocation ? `${dbPeakPct}% of ${allocation} CPUs (${pgc.peak10sCores} cores)` : `${pgc.peak10sCores} cores, no allocation set`, pass: allocation ? dbPeakPct < 60 : null },
];
const verdict = criteria.every((c) => c.pass === true);

const report = {
  run: run.name, sha: run.sha, dirty: run.dirty, loadTestLock: run.loadTestLock ?? null, verdict, criteria, errorCounts, gatewayErrors, steadyFrom: summary.steadyStartedAt,
  steadyTo: summary.steadyEndedAt, loadgen: { steady, whole: summary.whole, notes: summary.notes, unacknowledgedEvents: summary.unacknowledgedEvents,
    errorSamples: summary.errorSamples, config: summary.config }, components, host, others: others.slice(0, 15), gateway: gw, nginx, logs, db,
  dbAllocation: allocation, dbPeak10sPct: dbPeakPct, dbPeak60sPct: dbPeak60Pct, backends: run.backends, memory,
  ...(live ? { live } : {}),
};
writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

// --- report.md ---------------------------------------------------------------------------------------------------------
const md = [];
const row = (...cells) => md.push(`| ${cells.join(' | ')} |`);
md.push(`# Load test ${run.name}`, '');
// The CPUs a container was confined to (docker update --cpuset-cpus): on a host of two kinds of core, what decides a
// light run's CPU time per operation.
const pinned = Object.entries(run.containers ?? {}).filter(([, c]) => c.cpuset).map(([svc, c]) => `${svc} ${c.cpuset}`);
md.push(`Commit \`${run.sha.slice(0, 12)}\`${run.dirty ? ' (with uncommitted changes)' : ''}, ${run.backends} apiserver backend(s), database CPU allocation ${allocation ?? 'unlimited'}, host ${run.hostCpus} CPUs, the gateway's merge window ${run.mergeWindow ?? 'default'}` +
  (run.loadTestLock === undefined ? '.' : run.loadTestLock ? ", under the host's load test lock." : ", **not** under the host's load test lock.") +
  (pinned.length > 0 ? ` Containers pinned to CPUs: ${pinned.join(', ')}.` : ''));
md.push(summary.steady
  ? `Steady window ${summary.steadyStartedAt} → ${summary.steadyEndedAt} (${round(steady.seconds / 60, 1)} min), after a ramp of ${summary.rampSeconds} s.`
  : `No steady window: the run ended after ${summary.rampSeconds} s of ramp, before every runner was connected. Every figure is over the whole run (${summary.startedAt} → ${summary.endedAt}).`, '');
if (run.stoppedForMemory) md.push(`**Stopped early at ${run.stoppedForMemory}: the host ran short of memory.**`, '');
md.push(`**Verdict: ${verdict ? 'PASS' : 'FAIL'}**`, '');
row('Criterion', 'Target', 'Measured', 'Pass');
row('---', '---', '---', '---');
for (const c of criteria) row(c.name, c.target, c.measured, c.pass === null ? 'n/a' : c.pass ? 'yes' : '**no**');
md.push('', '## Errors', '');
row('Source', 'Count');
row('---', '---');
for (const [k, v] of Object.entries(errorCounts)) row(k, v);
if (Object.keys(gatewayErrors).length) {
  md.push('', 'Gateway counters that moved:', '');
  for (const [k, v] of Object.entries(gatewayErrors)) md.push(`- \`${k}\`: ${v}`);
}
if (steady.errorTotal > 0) {
  md.push('', 'Runner-side errors:', '');
  for (const [k, v] of Object.entries(steady.errors)) md.push(`- \`${k}\`: ${v}; first: ${(summary.errorSamples[k] ?? [])[0] ?? ''}`);
}
for (const [svc, l] of Object.entries(logs)) {
  const levels = Object.entries(l.byLevel).map(([k, v]) => `${k} ${v}`).join(', ');
  md.push('', `Log lines of ${svc} in the window: ${levels || 'none'}`);
  for (const level of ['ERROR', 'FATAL', 'PANIC', 'WARN', 'WARNING', 'ERR']) {
    for (const s of l.samples[level] ?? []) md.push(`    ${s.slice(0, 300)}`);
  }
}
md.push('', `Web gateway responses in the window: ${JSON.stringify(nginx.byStatus)}; link tokens ${JSON.stringify(nginx.linkToken.byStatus)}`);
md.push('', '## What the runners saw (loadgen, steady window)', '');
row('Measure', 'Value');
row('---', '---');
row('runners, active sessions', `${summary.config.runners}, ${summary.config.activeSessions} (${summary.config.perSessionRate.toFixed(3)} events/s each)`);
row('heartbeats acknowledged per second', steady.heartbeatAcksPerSecond);
row('events acknowledged per second', steady.eventsAckedPerSecond);
row('batches acknowledged per second', steady.batchesAckedPerSecond);
row('events per batch', round(steady.counters.eventsAcked / Math.max(1, steady.counters.batchesAcked), 2));
row('payload bytes per second', round(steady.counters.payloadBytes / steady.seconds, 0));
row('EventAck latency per batch (ms)', `p50 ${steady.ackBatch.p50Ms}, p90 ${steady.ackBatch.p90Ms}, p99 ${steady.ackBatch.p99Ms}, p99.9 ${steady.ackBatch.p999Ms}, max ${steady.ackBatch.maxMs}`);
row('EventAck latency per event (ms)', `p50 ${steady.ackEvent.p50Ms}, p90 ${steady.ackEvent.p90Ms}, p99 ${steady.ackEvent.p99Ms}, p99.9 ${steady.ackEvent.p999Ms}, max ${steady.ackEvent.maxMs}`);
row('HeartbeatAck latency (ms)', `p50 ${steady.heartbeatAck.p50Ms}, p99 ${steady.heartbeatAck.p99Ms}, max ${steady.heartbeatAck.maxMs}`);
row('renewals, reconnects, link tokens minted', `${steady.counters.renewals}, ${steady.counters.reconnects}, ${steady.counters.tokensMinted}`);
row('token mint latency (ms)', `p50 ${steady.tokenMint.p50Ms}, p99 ${steady.tokenMint.p99Ms}`);
row('dial to Welcome (ms)', `p50 ${steady.dialToWelcome.p50Ms}, p99 ${steady.dialToWelcome.p99Ms}`);
row('events resent', steady.counters.eventsResent);
row('notes', JSON.stringify(summary.notes));
row('unacknowledged at the end', summary.unacknowledgedEvents);
md.push('', '## The gateway (counters over the window)', '');
row('Measure', 'Value');
row('---', '---');
row('connections (min, max)', `${gw.connections.min}, ${gw.connections.max}`);
row('EventAck duration (gateway)', `${gw.eventAck.count} batches, mean ${gw.eventAck.meanMs} ms, p50 ≈ ${gw.eventAck.p50Ms} ms, p99 ≈ ${gw.eventAck.p99Ms} ms, ${gw.eventAck.withinOneSecondPct}% within 1 s`);
row('heartbeat forward duration', `mean ${gw.heartbeatForward.meanMs} ms, p99 ≈ ${gw.heartbeatForward.p99Ms} ms`);
row('ingest queue, most events', gw.ingestQueueEventsMax);
if (gw.mergeCalls > 0) {
  row('merged ingest calls', `${gw.mergeCalls} (${round(gw.mergeCalls / steady.seconds, 1)}/s), ${gw.mergeBatchesPerCall} batches each`);
  row('merged transaction held its sessions (apiserver)', `mean ${gw.mergeHeld.meanMs} ms, p50 ≈ ${gw.mergeHeld.p50Ms} ms, p99 ≈ ${gw.mergeHeld.p99Ms} ms`);
  row('merged call duration (gateway)', `mean ${gw.mergeCall.meanMs} ms, p50 ≈ ${gw.mergeCall.p50Ms} ms, p99 ≈ ${gw.mergeCall.p99Ms} ms`);
}
for (const family of ['link_handshakes_total', 'link_disconnects_total', 'link_backend_calls_total', 'link_heartbeat_forwards_total', 'link_event_batches_total', 'link_hints_total',
  'link_event_merge_calls_total', 'link_event_merge_flushes_total', 'link_event_merge_alone_total']) {
  row(family, Object.entries(gw[family]).map(([k, v]) => `${k} ${v}`).join(', ') || '—');
}
if (live) {
  const l = live;
  md.push('', '## The live stream (steady window)', '');
  row('Measure', 'Value');
  row('---', '---');
  row('loadgen: -live-rate, deltas sent per second', `${l.loadgen.liveRate}, ${l.loadgen.sentPerSecond}`);
  row('loadgen: deltas produced, sent, dropped; LiveBatch frames', `${l.loadgen.produced}, ${l.loadgen.sent}, ${l.loadgen.dropped}; ${l.loadgen.batches} (${l.loadgen.eventsPerBatch} deltas each)`);
  row('loadgen: sessions watched (min, max); turn prefixes answered', `${l.loadgen.watched.min}, ${l.loadgen.watched.max}; ${l.loadgen.turnPrefixAnswers}`);
  row('gateway: live events', Object.entries(l.gateway.liveEvents).map(([k, v]) => `${k} ${v}`).join(', ') || '—');
  row('gateway: watched sessions (min, max)', `${l.gateway.watchedSessions.min}, ${l.gateway.watchedSessions.max}`);
  row('gateway: turn prefix requests', Object.entries(l.gateway.turnPrefixRequests).map(([k, v]) => `${k} ${v}`).join(', ') || '—');
  row('watchers: sessions, streams open (lowest)', `${l.watchers.sessions}, ${l.watchers.open.min}`);
  row('watchers: deltas received per second, share of those sent', `${l.watchers.deltasPerSecond}, ${l.watchers.receivedShare}`);
  row('watchers: SSE messages per second by type', JSON.stringify(l.watchers.messagesPerSecond));
  row('watchers: deltas per text_delta message (merged in 50 ms)', l.watchers.deltasPerTextMessage);
  row('watchers: delay from production (ms)', `p50 ${l.watchers.delayMs.p50}, p90 ${l.watchers.delayMs.p90}, p99 ${l.watchers.delayMs.p99}, p99.9 ${l.watchers.delayMs.p999}, max ${l.watchers.delayMs.max}`);
  row('watchers: stream open (ms)', `p50 ${l.watchers.openMs.p50}, p99 ${l.watchers.openMs.p99} (${l.watchers.openMs.count} opens over the run)`);
  row('watchers: errors', JSON.stringify(l.watchers.errors));
}
md.push('', '## CPU and memory (steady window)', '');
row('Component', 'mean cores', 'peak 10 s', 'peak 60 s', 'peak MiB', 'CPU pressure (mean / peak 60 s)', 'throttled');
row('---', '---', '---', '---', '---', '---', '---');
for (const [k, c] of Object.entries(components)) {
  row(k, c.meanCores, c.peak10sCores, c.peak60sCores, c.peakMemMiB, `${c.cpuPressurePct}% / ${c.cpuPressurePeak60sPct}%`, `${c.throttledPct}%`);
}
const mainThreads = Object.entries(components).filter(([, c]) => c.mainThreadBusy != null);
if (mainThreads.length) {
  md.push('', 'Main thread of each apiserver (busy cores, share of its process): ' +
    mainThreads.map(([k, c]) => `${k} ${c.mainThreadBusy} (${c.mainThreadShare})`).join(', ') + '.');
}
md.push('', '## The host', '');
row('Measure', 'Value');
row('---', '---');
row('busy cores (mean, peak 60 s) of ' + run.hostCpus, `${host.meanBusyCores}, ${host.peak60sBusyCores}`);
row('of which this test (mean)', host.testMeanCores);
row('of which everything else (mean): busy minus this test, and by cgroup', `${host.otherMeanCores}, ${host.otherCgroupCores}`);
row('load average 1 min (min, mean, max)', `${host.load1.min}, ${host.load1.mean}, ${host.load1.max}`);
row('host CPU pressure (some)', `${host.cpuPressurePct}%`);
row('memory available, lowest', `${host.memAvailMinMiB} MiB`);
row('swap in / out (pages)', `${host.swapInPages} / ${host.swapOutPages}`);
const onset = (o) => (o ? `${o.at} (${o.elapsedS} s into the run), ${o.connected} runners connected, ${o.memAvailMiB} MiB available` : 'never');
md.push('', `Swapping out at 1 MiB/s or more began: ${onset(host.swapFrom1MiBs)}. At 10 MiB/s or more: ${onset(host.swapFrom10MiBs)}.`);
if (host.swapOutPeak) {
  md.push(`Peak swap-out: ${host.swapOutPeak.swapOutPagesPerS} pages/s (${round((host.swapOutPeak.swapOutPagesPerS * 4) / 1024, 0)} MiB/s) at ${host.swapOutPeak.elapsedS} s, ${host.swapOutPeak.connected} runners connected.`);
}
md.push('', 'Host memory over the run, every 15 s:', '');
row('elapsed', 'connected', 'available MiB', 'swap out pages/s', 'swap in pages/s');
row('---', '---', '---', '---', '---');
for (let i = 0; i < memory.length; i += 3) {
  const m = memory[i];
  row(`${m.elapsedS} s`, m.connected, m.memAvailMiB, m.swapOutPagesPerS, m.swapInPagesPerS);
}
md.push('', 'Biggest CPU users on the host over the window (cores):', '');
for (const o of others.slice(0, 12)) md.push(`- ${o.name}: ${o.meanCores}`);
md.push('', '## The database (steady window)', '');
row('Measure', 'Value');
row('---', '---');
for (const [k, v] of Object.entries(db)) if (k !== 'topStatements') row(k, v);
md.push('', 'Top statements by total time:', '');
row('calls', 'total s', 'mean ms', 'max ms', 'statement');
row('---', '---', '---', '---', '---');
for (const q of db.topStatements) row(q.calls, q.totalS, q.meanMs, q.maxMs, '`' + q.query.replace(/\|/g, '\\|') + '`');
md.push('', '## Per 5 minutes (loadgen series)', '');
row('elapsed', 'phase', 'connected', 'events/s', 'beats/s', 'ack p99 ms (max of intervals)', 'errors');
row('---', '---', '---', '---', '---', '---', '---');
for (let i = 0; i < series.length; i += 30) {
  const chunk = series.slice(i, i + 30);
  const secs = chunk.length * 10;
  const ev = chunk.reduce((n, l) => n + l.eventsAcked, 0);
  const hb = chunk.reduce((n, l) => n + l.heartbeatAcks, 0);
  const errs = chunk.reduce((n, l) => n + Object.values(l.errors ?? {}).reduce((m, v) => m + v, 0), 0);
  row(`${Math.round(chunk[0].elapsedS)} s`, chunk.at(-1).phase, chunk.at(-1).connected, round(ev / secs, 0), round(hb / secs, 0),
    Math.max(...chunk.map((l) => l.ackBatch.p99Ms)), errs);
}
console.log(md.join('\n'));

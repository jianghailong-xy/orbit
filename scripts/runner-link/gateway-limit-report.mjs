#!/usr/bin/env node
// The report of a gateway-limit.sh run: for each level, the gateway's CPU, memory, goroutines, GC pauses, file
// descriptors and handshake latency; what the runners saw (heartbeat and EventAck latency, errors, refusals, whether
// every heartbeat and event was answered); the kernel's listen overflows, conntrack, socket memory and softirqs; and the
// host, the loadgen shards', the stubs' and NATS's own CPU and memory, so a limit of the rig can be told from one of the
// gateway. Every figure is over the level's steady window, the part of it every shard was in, except the handshakes,
// which happen in the ramp, and the shards' end of run checks, which count the whole level.
//
//   node scripts/runner-link/gateway-limit-report.mjs <run dir> > <run dir>/report.md     # also writes report.json
//
// gateway-limit.sh writes it as it tears down. C2b's single-gateway figures, which each level is compared with, are
// 0.801 cores and 3,556 MiB at 15,000 connections (task 34m88i6i8CQeU4dSuw7HM, evidence 15): 0.053 cores per 1,000
// connections and about 243 KiB a connection.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const C2B = { connections: 15000, cores: 0.801, memMiB: 3556 };
C2B.coresPer1000 = (C2B.cores / C2B.connections) * 1000;
C2B.kibPerConnection = (C2B.memMiB * 1024) / C2B.connections;
const USER_HZ = 100; // /proc/stat's unit
const PAGE = 4096; // /proc/net/sockstat's and tcp_mem's unit

const dir = process.argv[2];
if (!dir) {
  console.error('usage: gateway-limit-report.mjs <run dir>');
  process.exit(2);
}
const has = (name) => existsSync(join(dir, name));
const read = (name) => readFileSync(join(dir, name), 'utf8');
const json = (name) => JSON.parse(read(name));
const jsonl = (name) => (has(name) ? read(name).split('\n').filter((l) => l.trim()).flatMap((l) => {
  try { return [JSON.parse(l)]; } catch { return []; }
}) : []);
const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const maxOf = (xs) => (xs.length ? Math.max(...xs) : null);
const minOf = (xs) => (xs.length ? Math.min(...xs) : null);
const meanOf = (xs) => (xs.length ? sum(xs) / xs.length : null);

const run = json('run.json');
const samples = jsonl('samples.jsonl');
const probe = jsonl('probe.jsonl');
const stubs = jsonl('stub.jsonl');
const sockets = jsonl('sockets.jsonl');

// --- The gateway's /metrics scrapes. ------------------------------------------------------------------------------------
const scrapes = [];
if (has('metrics.prom')) {
  let cur = null;
  for (const line of read('metrics.prom').split('\n')) {
    const m = /^# scrape (\d+)$/.exec(line);
    if (m) {
      cur = { t: Number(m[1]), values: new Map() };
      scrapes.push(cur);
    } else if (cur && line && !line.startsWith('#')) {
      const sp = line.lastIndexOf(' ');
      cur.values.set(line.slice(0, sp), Number(line.slice(sp + 1)));
    }
  }
}
// The scrapes that bracket a window: the last at or before its start, the last at or before its end.
function bracket(points, from, to) {
  const before = points.filter((p) => p.t <= from).at(-1) ?? points.find((p) => p.t >= from);
  const last = points.filter((p) => p.t <= to).at(-1);
  return before && last && last.t > before.t ? [before, last] : null;
}
function counterFamily(pair, family) {
  if (!pair) return {};
  const out = {};
  for (const [key, v] of pair[1].values) {
    if (key === family || key.startsWith(family + '{')) {
      const d = v - (pair[0].values.get(key) ?? 0);
      if (d !== 0) out[key.slice(family.length) || '_'] = d;
    }
  }
  return out;
}
// A Prometheus histogram over the window: its count, mean and quantiles by linear interpolation inside its buckets.
function promHistogram(pair, name) {
  if (!pair) return null;
  const d = (key) => (pair[1].values.get(key) ?? 0) - (pair[0].values.get(key) ?? 0);
  const buckets = [];
  for (const key of pair[1].values.keys()) {
    const m = new RegExp(`^${name}_bucket\\{le="([^"]+)"\\}$`).exec(key);
    if (m) buckets.push({ le: m[1] === '+Inf' ? Infinity : Number(m[1]), n: d(key) });
  }
  buckets.sort((a, b) => a.le - b.le);
  const count = d(`${name}_count`);
  const quantile = (q) => {
    if (count <= 0) return null;
    const target = q * count;
    let prevLe = 0;
    let prevN = 0;
    for (const b of buckets) {
      if (b.n >= target) return b.le === Infinity ? prevLe : prevLe + ((target - prevN) / Math.max(b.n - prevN, 1)) * (b.le - prevLe);
      prevLe = b.le;
      prevN = b.n;
    }
    return null;
  };
  const ms = (s) => (s == null ? null : round(s * 1000, 2));
  return { count, meanMs: count > 0 ? ms(d(`${name}_sum`) / count) : null, p50Ms: ms(quantile(0.5)), p99Ms: ms(quantile(0.99)) };
}

// --- The loadgen's histograms, added up across shards (histograms.json: bucket i counts values below base^(i+1) µs). --
function mergeHists(dumps) {
  const counts = new Map();
  let count = 0;
  let sumS = 0;
  let maxMs = 0;
  let base = 1.01;
  for (const h of dumps.filter(Boolean)) {
    base = h.base;
    count += h.count;
    sumS += h.sumSeconds;
    maxMs = Math.max(maxMs, h.maxMs);
    for (const [i, n] of h.buckets) counts.set(i, (counts.get(i) ?? 0) + n);
  }
  const sorted = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  const quantile = (q) => {
    if (count === 0) return null;
    const target = Math.max(Math.ceil(q * count), 1);
    let cum = 0;
    for (const [i, n] of sorted) {
      cum += n;
      if (cum >= target) return Math.min(base ** (i + 1) / 1000, maxMs);
    }
    return maxMs;
  };
  return { count, meanMs: count ? round((sumS / count) * 1000, 3) : null, p50Ms: round(quantile(0.5), 3), p90Ms: round(quantile(0.9), 3),
    p99Ms: round(quantile(0.99), 3), p999Ms: round(quantile(0.999), 3), maxMs: round(maxMs, 3) };
}
// The stub's histograms between two of its stats reads: the buckets' differences (bucket i below 1.01^(i+1) µs).
function bucketDelta(after, before) {
  const was = new Map((before?.buckets ?? []).map(([i, n]) => [i, n]));
  return (after?.buckets ?? []).map(([i, n]) => [i, n - (was.get(i) ?? 0)]).filter(([, n]) => n > 0);
}
function bucketQuantiles(buckets) {
  const count = sum(buckets.map(([, n]) => n));
  const sorted = [...buckets].sort((a, b) => a[0] - b[0]);
  const at = (q) => {
    if (!count) return null;
    const target = Math.max(Math.ceil(q * count), 1);
    let cum = 0;
    for (const [i, n] of sorted) if ((cum += n) >= target) return round(1.01 ** (i + 1) / 1000, 3);
    return null;
  };
  return { count, p50Ms: at(0.5), p99Ms: at(0.99), maxMs: sorted.length ? round(1.01 ** (sorted.at(-1)[0] + 1) / 1000, 3) : null };
}

// --- cgroup and host samples. -------------------------------------------------------------------------------------------
const inWindow = (points, from, to) => points.filter((p) => p.t >= from && p.t <= to);
// cg is a cgroup's figures summed over the units whose name matches: the gateway, the stubs, a level's shards, NATS.
function cgSeries(match, from, to) {
  return inWindow(samples, from, to).map((s) => {
    const units = Object.entries(s.cgroups ?? {}).filter(([u]) => match(u)).map(([, v]) => v);
    return { t: s.t, units: units.length, cpuUsec: sum(units.map((v) => v.cpuUsec)), throttledUsec: sum(units.map((v) => v.throttledUsec)),
      memBytes: sum(units.map((v) => v.memBytes)), anonBytes: sum(units.map((v) => v.anonBytes)), sockBytes: sum(units.map((v) => v.sockBytes)),
      psiSomeUsec: sum(units.map((v) => v.psiSomeUsec)), oomKills: sum(units.map((v) => v.oomKills)) };
  }).filter((p) => p.units > 0);
}
// Cores over consecutive samples of one set of units: the mean over the window, and the highest over any span of spanMs.
function cores(series, field = 'cpuUsec', spanMs = 10_000) {
  if (series.length < 2) return { mean: null, peak: null };
  const rate = (a, b) => (b[field] - a[field]) / ((b.t - a.t) * 1000);
  let peak = null;
  for (let i = 0; i < series.length; i++) {
    const j = series.findIndex((p, k) => k > i && p.t - series[i].t >= spanMs - 500);
    if (j < 0) break;
    peak = Math.max(peak ?? 0, rate(series[i], series[j]));
  }
  return { mean: rate(series[0], series.at(-1)), peak };
}
function part(match, from, to) {
  const s = cgSeries(match, from, to);
  if (s.length === 0) return null;
  const c = cores(s);
  const psi = cores(s, 'psiSomeUsec', 60_000);
  const thr = cores(s, 'throttledUsec');
  return { raw: { meanCores: c.mean, maxBytes: maxOf(s.map((p) => p.memBytes)), meanBytes: meanOf(s.map((p) => p.memBytes)) },
    meanCores: round(c.mean, 3), peak10sCores: round(c.peak, 3), maxMiB: round(maxOf(s.map((p) => p.memBytes)) / 2 ** 20, 0),
    meanMiB: round(meanOf(s.map((p) => p.memBytes)) / 2 ** 20, 0), anonMaxMiB: round(maxOf(s.map((p) => p.anonBytes)) / 2 ** 20, 0),
    sockMaxMiB: round(maxOf(s.map((p) => p.sockBytes)) / 2 ** 20, 1), cpuPressurePct: round(100 * psi.mean, 2),
    throttledPct: round(100 * thr.mean, 2), oomKills: s.at(-1).oomKills - s[0].oomKills };
}
function hostFigures(from, to) {
  const s = inWindow(samples, from, to).filter((p) => p.host);
  if (s.length < 2) return null;
  const busy = (c) => sum(c) - c[3] - c[4];
  const [a, b] = [s[0], s.at(-1)];
  const secs = (b.t - a.t) / 1000;
  const spans = [];
  for (let i = 0; i < s.length; i++) {
    const j = s.findIndex((p, k) => k > i && p.t - s[i].t >= 59_500);
    if (j < 0) break;
    spans.push((busy(s[j].host.cpu) - busy(s[i].host.cpu)) / USER_HZ / ((s[j].t - s[i].t) / 1000));
  }
  const loads = s.map((p) => p.host.load[0]);
  return { busyCoresMean: round((busy(b.host.cpu) - busy(a.host.cpu)) / USER_HZ / secs, 2), busyCoresPeak60s: round(maxOf(spans), 2),
    softirqCores: round((b.host.cpu[6] - a.host.cpu[6]) / USER_HZ / secs, 3),
    load1: { min: minOf(loads), mean: round(meanOf(loads), 1), max: maxOf(loads) },
    memAvailableMinMiB: round(minOf(s.map((p) => p.host.memAvailKb)) / 1024, 0),
    swapInPagesPerSecond: round((b.host.pswpin - a.host.pswpin) / secs, 1), swapOutPagesPerSecond: round((b.host.pswpout - a.host.pswpout) / secs, 1) };
}
function kernelFigures(from, to) {
  const s = inWindow(samples, from, to).filter((p) => p.kernel);
  if (s.length < 2) return null;
  const [a, b] = [s[0].kernel, s.at(-1).kernel];
  const secs = (s.at(-1).t - s[0].t) / 1000;
  const d = (k) => (b[k] == null || a[k] == null ? null : b[k] - a[k]);
  const most = (k) => maxOf(s.map((p) => p.kernel[k]).filter((v) => v != null));
  const tcpMem = (run.host?.settings?.['net.ipv4.tcp_mem'] ?? '').split(' ').map(Number);
  return {
    listenOverflows: d('listenOverflows'), listenDrops: d('listenDrops'), tcpBacklogDrop: d('tcpBacklogDrop'),
    tcpMemoryPressures: d('tcpMemoryPressures'), tcpAbortOnMemory: d('tcpAbortOnMemory'), tcpReqQFullDrop: d('tcpReqQFullDrop'),
    tcpRetransSegs: d('tcpRetransSegs'), tcpEstabResets: d('tcpEstabResets'), tcpAttemptFails: d('tcpAttemptFails'), tcpOutRsts: d('tcpOutRsts'),
    conntrackMax: b.conntrackMax ?? null, conntrackCountMax: most('conntrackCount'),
    conntrackDrops: d('drop'), conntrackEarlyDrops: d('early_drop'), conntrackInsertFailed: d('insert_failed'), conntrackInvalid: d('invalid'),
    tcpInuseMax: most('tcpInuse'), tcpTimeWaitMax: most('tcpTw'), tcpOrphanMax: most('tcpOrphan'),
    tcpMemMiBMax: round((most('tcpMemPages') * PAGE) / 2 ** 20, 1),
    tcpMemPressureMiB: tcpMem.length === 3 && tcpMem[1] > 0 ? round((tcpMem[1] * PAGE) / 2 ** 20, 0) : null,
    netRxSoftirqsPerSecond: round(d('netRxSoftirqs') / secs, 0), netTxSoftirqsPerSecond: round(d('netTxSoftirqs') / secs, 0),
    softnetDropped: d('dropped'), softnetTimeSqueeze: d('time_squeeze'),
  };
}

// --- GC: GODEBUG=gctrace=1's line for each cycle, timed from the gateway's start. --------------------------------------
const gcs = [];
if (has('logs/gateway.log') && run.gatewayStartMs) {
  const re = /^gc (\d+) @([\d.]+)s (\d+)%: ([\d.]+)\+([\d.]+)\+([\d.]+) ms clock, .*?(\d+)->(\d+)->(\d+) MB, (\d+) MB goal/;
  for (const line of read('logs/gateway.log').split('\n')) {
    const m = re.exec(line);
    if (m) {
      gcs.push({ t: run.gatewayStartMs + Number(m[2]) * 1000, pauseMs: Number(m[4]) + Number(m[6]), concurrentMs: Number(m[5]),
        liveMB: Number(m[9]), goalMB: Number(m[10]) });
    }
  }
}
function gcFigures(from, to) {
  const g = gcs.filter((x) => x.t >= from && x.t <= to);
  const pauses = g.map((x) => x.pauseMs).sort((a, b) => a - b);
  const q = (p) => (pauses.length ? pauses[Math.min(pauses.length - 1, Math.ceil(p * pauses.length) - 1)] : null);
  const out = { cycles: g.length, cyclesPerMinute: round((g.length / ((to - from) / 1000)) * 60, 1), pauseP50Ms: round(q(0.5), 3),
    pauseP99Ms: round(q(0.99), 3), pauseMaxMs: round(maxOf(pauses), 3), heapLiveMeanMB: round(meanOf(g.map((x) => x.liveMB)), 0),
    heapLiveMaxMB: maxOf(g.map((x) => x.liveMB)), heapGoalMaxMB: maxOf(g.map((x) => x.goalMB)) };
  // The probe's view: the stop-the-world pause histogram between its reads, and the CPU the GC took.
  const pair = bracket(probe, from, to);
  if (pair) {
    const pausesKey = '/sched/pauses/total/gc:seconds';
    const was = new Map((pair[0][pausesKey] ?? []).map(([lo, hi, n]) => [`${lo}|${hi}`, n]));
    const delta = (pair[1][pausesKey] ?? []).map(([lo, hi, n]) => ({ hi, n: n - (was.get(`${lo}|${hi}`) ?? 0) })).filter((x) => x.n > 0);
    const total = sum(delta.map((x) => x.n));
    let cum = 0;
    const p99 = delta.find((x) => (cum += x.n) >= Math.ceil(0.99 * total));
    const secs = (pair[1].t - pair[0].t) / 1000;
    out.probe = { pauses: total, pauseP99UpperBoundMs: p99?.hi == null ? null : round(p99.hi * 1000, 3),
      gcCores: round((pair[1]['/cpu/classes/gc/total:cpu-seconds'] - pair[0]['/cpu/classes/gc/total:cpu-seconds']) / secs, 3) };
  }
  return out;
}

// --- The idle gateway (run.json idleFromMs..idleToMs): NATS and the stubs up, no runner. --------------------------------
let idle = null;
if (run.idleFromMs && run.idleToMs) {
  const p = part((u) => u === 'gateway', run.idleFromMs, run.idleToMs);
  const g = inWindow(samples, run.idleFromMs, run.idleToMs).filter((x) => x.gateway);
  const pr = inWindow(probe, run.idleFromMs, run.idleToMs);
  idle = p && { ...p, rssMeanKb: meanOf(g.map((x) => x.gateway.rssKb)), goroutines: maxOf(pr.map((x) => x['/sched/goroutines:goroutines'])) };
}

// --- Each level. ------------------------------------------------------------------------------------------------------
const levelDirs = has('levels') ? readdirSync(join(dir, 'levels')).filter((d) => has(join('levels', d, 'level.json'))).map(Number).sort((a, b) => a - b) : [];
const levels = [];
for (const n of levelDirs) {
  const lv = json(join('levels', String(n), 'level.json'));
  const shardDirs = readdirSync(join(dir, 'levels', String(n))).filter((d) => d.startsWith('shard-')).sort();
  const shards = shardDirs.map((d) => ({
    name: d,
    summary: has(join('levels', String(n), d, 'summary.json')) ? json(join('levels', String(n), d, 'summary.json')) : null,
    hists: has(join('levels', String(n), d, 'histograms.json')) ? json(join('levels', String(n), d, 'histograms.json')) : null,
  }));
  const steadyShards = shards.filter((s) => s.summary?.steadyStartedAt);
  const complete = steadyShards.length === shards.length && shards.length > 0;
  const from = complete ? Math.max(...steadyShards.map((s) => Date.parse(s.summary.steadyStartedAt))) : lv.startedMs;
  const to = complete ? Math.min(...steadyShards.map((s) => Date.parse(s.summary.steadyEndedAt))) : lv.endedMs;
  const steadyPair = bracket(scrapes, from, to);
  const wholePair = bracket(scrapes, lv.startedMs - 1, lv.endedMs + 16_000);
  const conns = inWindow(scrapes, from, to).map((s) => s.values.get('link_connections') ?? 0);
  const connMin = minOf(conns);

  // What the runners saw: counters summed, rates as each shard measured them, latencies from the merged histograms.
  const counters = (win) => {
    const out = {};
    for (const s of shards) for (const [k, v] of Object.entries(s.summary?.[win]?.counters ?? {})) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const errors = (win) => {
    const out = {};
    for (const s of shards) for (const [k, v] of Object.entries(s.summary?.[win]?.errors ?? {})) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const steadyErrors = errors('steady');
  const wholeErrors = errors('whole');
  const isRefusal = (k) => /^(upgrade_refused_|closed_before_welcome|closed_CLOSE_CODE_|welcome_not_mode_link)/.test(k);
  const wholeCounters = counters('whole');
  const unacknowledged = sum(shards.map((s) => s.summary?.unacknowledgedEvents ?? 0));
  const runners = {
    shards: shards.length, shardExits: lv.shardExits, everConnected: sum(shards.map((s) => s.summary?.everConnected ?? 0)),
    steadySeconds: round((to - from) / 1000, 1),
    heartbeatAcksPerSecond: round(sum(steadyShards.map((s) => s.summary.steady.heartbeatAcksPerSecond)), 1),
    eventsAckedPerSecond: round(sum(steadyShards.map((s) => s.summary.steady.eventsAckedPerSecond)), 1),
    batchesAckedPerSecond: round(sum(steadyShards.map((s) => s.summary.steady.batchesAckedPerSecond)), 1),
    heartbeatAck: mergeHists(shards.map((s) => s.hists?.steady?.heartbeatAck)),
    eventAckBatch: mergeHists(shards.map((s) => s.hists?.steady?.ackBatch)),
    eventAckEvent: mergeHists(shards.map((s) => s.hists?.steady?.ackEvent)),
    dialToWelcome: mergeHists(shards.map((s) => s.hists?.whole?.dialToWelcome)),
    tokenMint: mergeHists(shards.map((s) => s.hists?.whole?.tokenMint)),
    steadyErrors, steadyErrorTotal: sum(Object.values(steadyErrors)), wholeErrors, wholeErrorTotal: sum(Object.values(wholeErrors)),
    refusals: Object.fromEntries(Object.entries(wholeErrors).filter(([k]) => isRefusal(k))),
    steadyCounters: counters('steady'), wholeCounters, unacknowledgedEvents: unacknowledged,
    everyHeartbeatAnswered: (wholeCounters.heartbeatsSent ?? 0) > 0 && wholeCounters.heartbeatsSent === wholeCounters.heartbeatAcks,
    everyEventAnswered: (wholeCounters.eventsProduced ?? 0) > 0 && wholeCounters.eventsProduced === wholeCounters.eventsAcked && unacknowledged === 0,
  };

  // The gateway.
  const gwPart = part((u) => u === 'gateway', from, to);
  const gwSamples = inWindow(samples, from, to).filter((s) => s.gateway);
  const probes = inWindow(probe, from, to);
  const socks = inWindow(sockets, from, to);
  const bySource = {};
  for (const s of socks) for (const [ip, c] of Object.entries(s.bySource ?? {})) (bySource[ip] ??= []).push(c);
  const perConn = connMin || n;
  const gateway = {
    connections: { target: n, min: connMin, max: maxOf(conns) },
    ...gwPart,
    coresPer1000Connections: gwPart?.raw.meanCores != null ? round((gwPart.raw.meanCores / perConn) * 1000, 4) : null,
    kibPerConnection: gwPart?.raw.maxBytes != null ? round(gwPart.raw.maxBytes / 1024 / perConn, 1) : null,
    // Above the idle gateway: what each connection adds.
    coresPer1000AboveIdle: gwPart?.raw.meanCores != null && idle ? round(((gwPart.raw.meanCores - idle.raw.meanCores) / perConn) * 1000, 4) : null,
    kibPerConnectionAboveIdle: gwPart?.raw.maxBytes != null && idle ? round((gwPart.raw.maxBytes - idle.raw.meanBytes) / 1024 / perConn, 1) : null,
    rssMaxMiB: round(maxOf(gwSamples.map((s) => s.gateway.rssKb)) / 1024, 0),
    rssMeanMiB: round(meanOf(gwSamples.map((s) => s.gateway.rssKb)) / 1024, 0),
    rssKibPerConnection: gwSamples.length ? round(maxOf(gwSamples.map((s) => s.gateway.rssKb)) / perConn, 1) : null,
    rssKibPerConnectionAboveIdle: gwSamples.length && idle?.rssMeanKb ? round((maxOf(gwSamples.map((s) => s.gateway.rssKb)) - idle.rssMeanKb) / perConn, 1) : null,
    threadsMax: maxOf(gwSamples.map((s) => s.gateway.threads)),
    goroutinesMean: round(meanOf(probes.map((p) => p['/sched/goroutines:goroutines'])), 0),
    goroutinesMax: maxOf(probes.map((p) => p['/sched/goroutines:goroutines'])),
    goroutinesPerConnection: probes.length ? round(maxOf(probes.map((p) => p['/sched/goroutines:goroutines'])) / perConn, 2) : null,
    gomaxprocs: probes.at(-1)?.['/sched/gomaxprocs:threads'] ?? null,
    gc: gcFigures(from, to),
    fdsMax: maxOf(socks.map((s) => s.fds)),
    connectionsBySource: Object.fromEntries(Object.entries(bySource).sort().map(([ip, cs]) => [ip, { min: minOf(cs), max: maxOf(cs) }])),
    handshakes: { ...counterFamily(wholePair, 'link_handshakes_total') },
    handshakeDuration: promHistogram(wholePair, 'link_handshake_duration_seconds'),
    tokenRefusals: counterFamily(wholePair, 'link_token_refusals_total'),
    disconnects: counterFamily(steadyPair, 'link_disconnects_total'),
    backendCalls: counterFamily(steadyPair, 'link_backend_calls_total'),
    backendRetries: counterFamily(steadyPair, 'link_backend_retries_total'),
    heartbeatForwards: counterFamily(steadyPair, 'link_heartbeat_forwards_total'),
    eventBatches: counterFamily(steadyPair, 'link_event_batches_total'),
    welcomeLookups: counterFamily(wholePair, 'link_welcome_lookups_total'),
    queueFull: counterFamily(steadyPair, 'link_queue_full_total'),
    backendCallDuration: promHistogram(steadyPair, 'link_backend_call_duration_seconds'),
    heartbeatForwardDuration: promHistogram(steadyPair, 'link_heartbeat_forward_duration_seconds'),
    eventAckDuration: promHistogram(steadyPair, 'link_event_ack_duration_seconds'),
    mergeCallDuration: promHistogram(steadyPair, 'link_event_merge_call_duration_seconds'),
  };

  // The rig: the shards, the stubs (their cgroups, and what each says of itself), NATS.
  const loadgen = part((u) => u.startsWith(`loadgen-${n}-`), from, to);
  const stub = part((u) => u.startsWith('stub-'), from, to);
  const nats = part((u) => u === 'nats', from, to);
  const stubSelf = { routes: {}, cpuCores: null, inFlightMax: null };
  const stubIds = [...new Set(stubs.map((s) => s.stub))];
  let stubCpu = 0;
  let stubSecs = 0;
  const routeBuckets = {};
  for (const id of stubIds) {
    const pair = bracket(stubs.filter((s) => s.stub === id), from, to);
    if (!pair) continue;
    stubCpu += pair[1].cpuSeconds - pair[0].cpuSeconds;
    stubSecs = Math.max(stubSecs, (pair[1].t - pair[0].t) / 1000);
    stubSelf.inFlightMax = Math.max(stubSelf.inFlightMax ?? 0, pair[1].inFlightMax);
    for (const [route, v] of Object.entries(pair[1].routes ?? {})) {
      const b = pair[0].routes?.[route];
      const r = (routeBuckets[route] ??= { calls: 0, errors: 0, work: [], answered: [] });
      r.calls += v.calls - (b?.calls ?? 0);
      r.errors += (v.calls - (v.byStatus?.['2xx'] ?? 0)) - ((b?.calls ?? 0) - (b?.byStatus?.['2xx'] ?? 0));
      r.work.push(...bucketDelta(v.work, b?.work));
      r.answered.push(...bucketDelta(v.answered, b?.answered));
    }
  }
  for (const [route, r] of Object.entries(routeBuckets)) {
    if (r.calls <= 0) continue;
    const merge = (list) => [...list.reduce((m, [i, c]) => m.set(i, (m.get(i) ?? 0) + c), new Map()).entries()];
    stubSelf.routes[route] = { callsPerSecond: round(r.calls / stubSecs, 1), errors: r.errors, work: bucketQuantiles(merge(r.work)),
      answered: bucketQuantiles(merge(r.answered)) };
  }
  stubSelf.cpuCores = stubSecs > 0 ? round(stubCpu / stubSecs, 3) : null;
  const delay = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(String(run.rig?.stubDelay ?? '5ms'));
  const delayMs = delay ? Number(delay[1]) * (delay[2] === 's' ? 1000 : 1) : null;
  const answeredP99 = maxOf(Object.values(stubSelf.routes).map((r) => r.answered.p99Ms).filter((v) => v != null));
  const workP99 = maxOf(Object.values(stubSelf.routes).map((r) => r.work.p99Ms).filter((v) => v != null));
  // The rig is not the limit while the stubs answer within their delay and their own work is a fraction of it, and the
  // shards neither wait for CPU nor see acknowledgements much later than the gateway sends them.
  const rigCheck = {
    stubAnsweredP99Ms: answeredP99, stubDelayMs: delayMs, stubWorkP99Ms: workP99,
    stubKeptUp: answeredP99 != null && answeredP99 <= delayMs * 1.1 + 1 && (workP99 ?? 0) < delayMs,
    gatewayBackendCallP99Ms: gateway.backendCallDuration?.p99Ms ?? null,
    loadgenCpuPressurePct: loadgen?.cpuPressurePct ?? null, loadgenKeptUp: (loadgen?.cpuPressurePct ?? 0) < 10,
    // The gateway's own histogram is too coarse for a p99 (its buckets), so the means are compared: what the runners wait
    // beyond what the gateway took is the network and the shards' own loop.
    eventAckMeanRunnerMs: runners.eventAckBatch.meanMs, eventAckMeanGatewayMs: gateway.eventAckDuration?.meanMs ?? null,
  };

  const compare = (v, ref) => (v == null ? null : round((100 * (v - ref)) / ref, 0));
  levels.push({
    level: n, complete, window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    rampRate: lv.rampRate, eventRate: lv.eventRate, gateway, runners,
    kernel: kernelFigures(from, to), host: hostFigures(from, to),
    rig: { loadgen, stub, nats, stubSelf, check: rigCheck },
    vsC2b: { coresPer1000: round(C2B.coresPer1000, 4), coresGapPct: compare(gateway.coresPer1000Connections, C2B.coresPer1000),
      kibPerConnection: round(C2B.kibPerConnection, 1), memoryGapPct: compare(gateway.kibPerConnection, C2B.kibPerConnection) },
  });
}

const report = { name: run.name, sha: run.sha, dirty: run.dirty, binaryUnderTest: run.binaryUnderTest, go: run.go,
  gateway: run.gateway, rig: run.rig, host: run.host, loadTestLock: run.loadTestLock, warnings: run.warnings ?? [],
  stoppedForMemory: has('stopped-for-memory') ? read('stopped-for-memory').trim() : null,
  gatewayEnded: has('gateway-ended.json') ? json('gateway-ended.json') : null, c2b: C2B,
  idle: idle && { meanCores: idle.meanCores, memMiB: round(idle.raw.meanBytes / 2 ** 20, 1), rssMiB: round(idle.rssMeanKb / 1024, 1), goroutines: idle.goroutines },
  levels };
writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

// --- report.md. -------------------------------------------------------------------------------------------------------
const md = [];
const dash = (text) => String(text).replace(/\b(null|undefined|NaN)\b/g, '—');
const row = (...cells) => md.push(dash(`| ${cells.map((c) => (c == null ? '—' : c)).join(' | ')} |`));
const kv = (o) => (o && Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') : '—');
const lat = (h) => (h?.count ? `p50 ${h.p50Ms}, p99 ${h.p99Ms}, max ${h.maxMs}` : '—');
const but = run.binaryUnderTest ?? {};
md.push(`# Gateway limit run ${run.name}`, '');
md.push(`Commit \`${String(run.sha).slice(0, 12)}\`${run.dirty ? ' (with uncommitted changes)' : ''}, ${run.go}. ` +
  (but.probe ? `The binary under test is the product source at that commit plus \`${but.probeFile}\` (sha256 \`${but.probeSha256}\`), added at build time.`
    : 'The binary under test is the product source at that commit, without the runtime probe.'));
md.push('', `Gateway: TLS (${run.gateway?.tls}), MODE_LINK, real NATS, CPU allowance ${run.gateway?.cpus} cores, memory ${run.gateway?.memory}` +
  `${run.gateway?.cpuset ? `, CPUs ${run.gateway.cpuset}` : ''}${run.gateway?.env?.length ? `, ${run.gateway.env.join(' ')}` : ''}. ` +
  `Rig: ${run.rig?.shards} loadgen shard(s) from ${run.rig?.sources?.join(', ')}, ${run.rig?.stubs} stub(s) answering after ${run.rig?.stubDelay}, ` +
  `${run.rig?.eventsPerConnection} events a second per connection${run.rig?.loadgenArgs?.length ? `, loadgen ${run.rig.loadgenArgs.join(' ')}` : ''}. ` +
  `Host: ${run.host?.cpus} CPUs (${run.host?.cpuModel}), ${round((run.host?.memKb ?? 0) / 2 ** 20, 1)} GiB, kernel ${run.host?.kernel}` +
  `${run.loadTestLock ? ', under the host\'s load-test lock' : ''}.`);
for (const w of report.warnings) md.push('', `Warning: ${w}`);
if (report.stoppedForMemory) md.push('', `**Stopped at ${report.stoppedForMemory}: the host's available memory stayed under the floor.**`);
if (report.gatewayEnded) md.push('', `**The gateway ended under load at ${new Date(report.gatewayEnded.t).toISOString()} (OOM kills in its cgroup: ${report.gatewayEnded.oomKills}).**`);
md.push('', '## Levels', '');
row('Level', 'Connections (min)', 'Gateway cores mean / peak 10 s', 'Cores per 1,000', 'Memory MiB (cgroup max)', 'KiB a connection',
  'RSS MiB', 'Goroutines', 'GC pause p99 ms', 'FDs', 'Handshake p99 ms', 'HeartbeatAck p99 ms', 'EventAck p99 ms', 'Errors', 'All answered');
row(...Array(15).fill('---'));
for (const l of levels) {
  const g = l.gateway;
  const r = l.runners;
  row(l.level, g.connections.min, `${g.meanCores} / ${g.peak10sCores}`, g.coresPer1000Connections, g.maxMiB, g.kibPerConnection, g.rssMaxMiB,
    g.goroutinesMax, g.gc.pauseP99Ms, g.fdsMax, g.handshakeDuration?.p99Ms, r.heartbeatAck.p99Ms, r.eventAckBatch.p99Ms, r.wholeErrorTotal,
    r.everyHeartbeatAnswered && r.everyEventAnswered ? 'yes' : '**no**');
}
md.push('', `C2b, one gateway at ${C2B.connections.toLocaleString('en')} connections behind four apiservers: ${round(C2B.coresPer1000, 3)} cores per 1,000 connections ` +
  `and ${round(C2B.kibPerConnection, 0)} KiB a connection.`, '');
if (report.idle) {
  md.push(`The idle gateway (NATS and the stubs up, no runner): ${report.idle.meanCores} cores, ${report.idle.memMiB} MiB in its cgroup, ` +
    `${report.idle.rssMiB} MiB RSS, ${report.idle.goroutines ?? '—'} goroutines. "Above idle" is what each connection adds to it.`, '');
}
row('Level', 'Cores per 1,000', 'vs C2b', 'above idle', 'KiB a connection (cgroup)', 'vs C2b', 'above idle', 'RSS KiB a connection, above idle');
row('---', '---', '---', '---', '---', '---', '---', '---');
for (const l of levels) {
  const flag = (p) => (p == null ? null : `${p > 0 ? '+' : ''}${p}%${Math.abs(p) > 30 ? ' (over 30%)' : ''}`);
  const g = l.gateway;
  row(l.level, g.coresPer1000Connections, flag(l.vsC2b.coresGapPct), g.coresPer1000AboveIdle, g.kibPerConnection, flag(l.vsC2b.memoryGapPct),
    g.kibPerConnectionAboveIdle, `${g.rssKibPerConnection}, ${g.rssKibPerConnectionAboveIdle}`);
}
for (const l of levels) {
  const g = l.gateway;
  const r = l.runners;
  const k = l.kernel ?? {};
  const h = l.host ?? {};
  md.push('', `## Level ${l.level}`, '');
  md.push(`Steady window ${l.window.from} → ${l.window.to} (${r.steadySeconds} s)${l.complete ? '' : ', **not every shard reached it: the whole level instead**'}; ` +
    `ramp ${l.rampRate}/s, ${l.eventRate} events/s asked; shards exited ${r.shardExits?.join(', ')}.`, '');
  md.push('**The gateway**', '');
  row('Measure', 'Value');
  row('---', '---');
  row('connections (min, max; target)', `${g.connections.min}, ${g.connections.max}; ${g.connections.target}`);
  row('connections by source address (min-max)', Object.entries(g.connectionsBySource).map(([ip, c]) => `${ip} ${c.min}-${c.max}`).join(', ') || null);
  row('CPU cores (mean, peak 10 s), throttled, CPU pressure', `${g.meanCores}, ${g.peak10sCores}; ${g.throttledPct}% of the time; ${g.cpuPressurePct}%`);
  row('memory MiB (cgroup max, mean; anon; socket buffers)', `${g.maxMiB}, ${g.meanMiB}; ${g.anonMaxMiB}; ${g.sockMaxMiB}`);
  row('RSS MiB (max, mean); threads', `${g.rssMaxMiB}, ${g.rssMeanMiB}; ${g.threadsMax}`);
  row('goroutines (mean, max, per connection); GOMAXPROCS', `${g.goroutinesMean}, ${g.goroutinesMax}, ${g.goroutinesPerConnection}; ${g.gomaxprocs}`);
  row('GC (gctrace): cycles/min; pause p50, p99, max ms; live heap MB mean, max; goal max',
    `${g.gc.cyclesPerMinute}; ${g.gc.pauseP50Ms}, ${g.gc.pauseP99Ms}, ${g.gc.pauseMaxMs}; ${g.gc.heapLiveMeanMB}, ${g.gc.heapLiveMaxMB}; ${g.gc.heapGoalMaxMB}`);
  row('GC (probe): pauses, p99 below ms, GC cores', g.gc.probe ? `${g.gc.probe.pauses}, ${g.gc.probe.pauseP99UpperBoundMs}, ${g.gc.probe.gcCores}` : null);
  row('open file descriptors (max)', g.fdsMax);
  row('handshakes over the level', kv(g.handshakes));
  row('handshake duration (gateway, upgrade to Welcome)', g.handshakeDuration?.count ? `${g.handshakeDuration.count} handshakes, mean ${g.handshakeDuration.meanMs}, p50 ≈ ${g.handshakeDuration.p50Ms}, p99 ≈ ${g.handshakeDuration.p99Ms} ms` : null);
  row('token refusals; disconnects in the window', `${kv(g.tokenRefusals)}; ${kv(g.disconnects)}`);
  row('backend calls; retries', `${kv(g.backendCalls)}; ${kv(g.backendRetries)}`);
  row('heartbeat forwards; event batches; welcome lookups', `${kv(g.heartbeatForwards)}; ${kv(g.eventBatches)}; ${kv(g.welcomeLookups)}`);
  row('write queues full', kv(g.queueFull));
  for (const [label, x] of [['backend call', g.backendCallDuration], ['heartbeat forward', g.heartbeatForwardDuration],
    ['EventAck (gateway, batch arrival to EventAck)', g.eventAckDuration], ['merged call', g.mergeCallDuration]]) {
    row(`${label} duration ms`, x?.count ? `mean ${x.meanMs}, p50 ≈ ${x.p50Ms}, p99 ≈ ${x.p99Ms} (${x.count})` : null);
  }
  md.push('', '**The runners** (the loadgen shards, added up)', '');
  row('Measure', 'Value');
  row('---', '---');
  row('runners connected; heartbeats acknowledged/s; events acknowledged/s; batches/s',
    `${r.everConnected}; ${r.heartbeatAcksPerSecond}; ${r.eventsAckedPerSecond}; ${r.batchesAckedPerSecond}`);
  row('HeartbeatAck latency ms', lat(r.heartbeatAck));
  row('EventAck latency per batch ms', `${lat(r.eventAckBatch)}, p99.9 ${r.eventAckBatch.p999Ms}`);
  row('EventAck latency per event ms', lat(r.eventAckEvent));
  row('dial to Welcome ms (whole level)', lat(r.dialToWelcome));
  row('token mint ms (whole level)', lat(r.tokenMint));
  row('errors in the window; over the whole level', `${r.steadyErrorTotal} (${kv(r.steadyErrors)}); ${r.wholeErrorTotal} (${kv(r.wholeErrors)})`);
  row('refusals (whole level)', kv(r.refusals));
  row('heartbeats sent, acknowledged (whole level)', `${r.wholeCounters.heartbeatsSent}, ${r.wholeCounters.heartbeatAcks}: ${r.everyHeartbeatAnswered ? 'every one answered' : '**not every one answered**'}`);
  row('events produced, acknowledged, unacknowledged at the end', `${r.wholeCounters.eventsProduced}, ${r.wholeCounters.eventsAcked}, ${r.unacknowledgedEvents}: ${r.everyEventAnswered ? 'every one answered' : '**not every one answered**'}`);
  row('renewals, reconnects, tokens minted (whole level)', `${r.wholeCounters.renewals}, ${r.wholeCounters.reconnects}, ${r.wholeCounters.tokensMinted}`);
  md.push('', '**The kernel** (changes over the window, or the most seen)', '');
  row('Measure', 'Value');
  row('---', '---');
  row('ListenOverflows, ListenDrops, TCPBacklogDrop, TCPReqQFullDrop', `${k.listenOverflows}, ${k.listenDrops}, ${k.tcpBacklogDrop}, ${k.tcpReqQFullDrop}`);
  row('conntrack entries (most), max; drops, early drops, insert failed, invalid',
    `${k.conntrackCountMax}, ${k.conntrackMax}; ${k.conntrackDrops}, ${k.conntrackEarlyDrops}, ${k.conntrackInsertFailed}, ${k.conntrackInvalid}`);
  row('TCP sockets in use, TIME_WAIT, orphans (most)', `${k.tcpInuseMax}, ${k.tcpTimeWaitMax}, ${k.tcpOrphanMax}`);
  row('TCP socket memory MiB (most); pressure at (tcp_mem); memory pressure events, aborts on memory',
    `${k.tcpMemMiBMax}; ${k.tcpMemPressureMiB}; ${k.tcpMemoryPressures}, ${k.tcpAbortOnMemory}`);
  row('softirqs NET_RX/s, NET_TX/s; softirq cores (host); softnet dropped, squeezed',
    `${k.netRxSoftirqsPerSecond}, ${k.netTxSoftirqsPerSecond}; ${h.softirqCores}; ${k.softnetDropped}, ${k.softnetTimeSqueeze}`);
  row('retransmitted segments, resets sent, connection resets, failed attempts', `${k.tcpRetransSegs}, ${k.tcpOutRsts}, ${k.tcpEstabResets}, ${k.tcpAttemptFails}`);
  md.push('', '**The host and the rig**', '');
  row('Part', 'CPU cores mean / peak 10 s', 'Memory MiB max', 'CPU pressure', 'Notes');
  row('---', '---', '---', '---', '---');
  row('host (busy, of all CPUs)', `${h.busyCoresMean} / ${h.busyCoresPeak60s} (60 s)`, `${h.memAvailableMinMiB} available at least`, null,
    `load ${h.load1?.min}-${h.load1?.max}; swap in/out ${h.swapInPagesPerSecond}/${h.swapOutPagesPerSecond} pages/s`);
  row('gateway', `${g.meanCores} / ${g.peak10sCores}`, g.maxMiB, `${g.cpuPressurePct}%`, g.oomKills ? `${g.oomKills} OOM kills` : null);
  for (const [label, p] of [['loadgen shards', l.rig.loadgen], ['stubs', l.rig.stub], ['NATS', l.rig.nats]]) {
    row(label, p ? `${p.meanCores} / ${p.peak10sCores}` : null, p?.maxMiB, p ? `${p.cpuPressurePct}%` : null, p?.oomKills ? `${p.oomKills} OOM kills` : null);
  }
  const c = l.rig.check;
  md.push('', `The stubs say of themselves: ${l.rig.stubSelf.cpuCores} cores, at most ${l.rig.stubSelf.inFlightMax} calls in hand at once; ` +
    Object.entries(l.rig.stubSelf.routes).map(([route, v]) => `${route} ${v.callsPerSecond}/s answered p99 ${v.answered.p99Ms} ms (own work p99 ${v.work.p99Ms} ms)` +
      `${v.errors ? `, ${v.errors} refused` : ''}`).join('; ') + '.');
  md.push('', `Rig check: the stubs answered p99 ${c.stubAnsweredP99Ms} ms against their ${c.stubDelayMs} ms delay, their own work p99 ` +
    `${c.stubWorkP99Ms} ms: ${c.stubKeptUp ? 'they kept up' : '**they did not keep up: the stub may be the limit**'}. The gateway saw its backend calls ` +
    `answered p99 ≈ ${c.gatewayBackendCallP99Ms} ms. The shards waited for CPU ${c.loadgenCpuPressurePct}% of the time: ` +
    `${c.loadgenKeptUp ? 'they kept up' : '**the loadgen may be the limit**'}; EventAck took ${c.eventAckMeanRunnerMs} ms on average at the runners ` +
    `and ${c.eventAckMeanGatewayMs} ms at the gateway, from a batch's arrival to its EventAck.`);
}
process.stdout.write(dash(md.join('\n')) + '\n');

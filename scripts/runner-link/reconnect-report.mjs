#!/usr/bin/env node
// Reduces one reconnect-probe.sh directory to the figures the report carries (task C2b, step 4): the handshake's cost,
// the welcome route's cost, what the reconnect added to the stack's CPU, and what the reaper did.
//
//   node scripts/runner-link/reconnect-report.mjs <probe-dir> [more-probe-dirs...]
//
// Quantiles come from link_handshake_duration_seconds by the same linear interpolation inside a bucket that
// loadgen-report.mjs uses, over the delta across the restart's window, so they are as precise as the buckets are
// (5 ms, 10, 25, 50, 100, 250, 500 ms, 1 s, 2.5, 5, 10).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const round = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? null : Number(n.toFixed(d)));
const readJson = (p, fallback = null) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
};
const readLines = (p) => (existsSync(p)
  ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().startsWith('{')).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  })
  : []);

function histogramFrom(name, first, last) {
  const buckets = [];
  for (const key of Object.keys(last)) {
    const m = new RegExp(`^${name}_bucket\\{le="([^"]+)"\\}$`).exec(key);
    if (m) buckets.push({ le: m[1] === '+Inf' ? Infinity : Number(m[1]), n: (last[key] ?? 0) - (first[key] ?? 0) });
  }
  buckets.sort((a, b) => a.le - b.le);
  const count = (last[`${name}_count`] ?? 0) - (first[`${name}_count`] ?? 0);
  const sum = (last[`${name}_sum`] ?? 0) - (first[`${name}_sum`] ?? 0);
  const quantile = (q) => {
    if (count <= 0) return null;
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
  return {
    count,
    meanMs: count > 0 ? round((sum / count) * 1000, 1) : null,
    p50Ms: round(quantile(0.5) * 1000, 1),
    p90Ms: round(quantile(0.9) * 1000, 1),
    p99Ms: round(quantile(0.99) * 1000, 1),
  };
}

// The scrape nearest a moment, among those the gateway answered.
const nearest = (scrapes, t) => scrapes.filter((s) => s.up === 1)
  .reduce((best, s) => (best === null || Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best), null);

function analyse(dir) {
  const probe = readJson(join(dir, 'probe.json'));
  if (!probe) throw new Error(`${dir}: no probe.json`);
  const metrics = readLines(join(dir, 'metrics.jsonl'));
  const cpu = readLines(join(dir, 'cpu.jsonl'));
  const { killMs, wholeMs, signal } = probe;
  const endMs = wholeMs ?? metrics.at(-1)?.t ?? killMs;

  // The window the restart's cost is measured over: the kill, until the fleet was whole, plus the settle.
  const windowEnd = metrics.at(-1)?.t ?? endMs;
  // A restart resets every counter, so the series is split by the process it came from: the gateway's own start time.
  // The old process keeps answering after a SIGTERM while it drains, and that is where its drains are counted, so its
  // figures are the last scrape it answered less the last one before the kill — not the pre-kill scrape alone.
  const up = metrics.filter((s) => s.up === 1);
  const startOf = (s) => s['link_gateway_start_time_seconds'] ?? null;
  const oldStart = startOf(nearest(metrics, killMs - 2000) ?? {});
  const oldScrapes = up.filter((s) => startOf(s) === oldStart);
  const newScrapes = up.filter((s) => startOf(s) !== null && startOf(s) !== oldStart);
  const preKill = oldScrapes.filter((s) => s.t <= killMs).at(-1) ?? {};
  const lastOld = oldScrapes.at(-1) ?? {};
  // What the old process did between the kill and its exit: the drains it sent and the handshakes it turned away.
  const oldProcess = Object.fromEntries(Object.keys(lastOld)
    .filter((k) => k !== 't' && k !== 'up')
    .map((k) => [k, (lastOld[k] ?? 0) - (k === 'link_connections' || k === 'link_draining' ? 0 : (preKill[k] ?? 0))]));
  oldProcess.link_connections = preKill['link_connections'] ?? lastOld['link_connections'] ?? 0;
  // The new process's counters start at 0, so its last scrape IS everything it has done.
  const newProcess = newScrapes.at(-1) ?? {};
  const after = newProcess;

  const handshake = histogramFrom('link_handshake_duration_seconds', {}, newProcess);
  const ctr = (o, k) => o?.[k] ?? 0;
  const sumKeys = (o, re) => Object.entries(o ?? {}).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);

  // CPU the restart added, against the mean of the baseline the probe held before the kill.
  const cpuAt = (t) => cpu.reduce((best, s) => (best === null || Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best), null);
  const svcs = [...new Set(cpu.flatMap((s) => Object.keys(s).filter((k) => k !== 't' && k !== 'host')))];
  const apiservers = svcs.filter((s) => s.startsWith('apiserver'));
  // Cores between two samples. A container that is stopped and started again gets a new cgroup, whose usage starts from
  // 0, so the CPU is the sum of the steps between consecutive samples that went up: the restarted gateway's included.
  const rate = (a, b, svc) => {
    if (!a || !b || !a[svc] || !b[svc] || b.t <= a.t) return null;
    let used = 0;
    let prev = null;
    for (const s of cpu) {
      if (s.t < a.t || s.t > b.t || !s[svc]) continue;
      if (prev !== null && s[svc].cpuUsec >= prev) used += s[svc].cpuUsec - prev;
      prev = s[svc].cpuUsec;
    }
    return (used / 1000) / ((b.t - a.t) / 1000) / 1000; // cores
  };
  const baseA = cpuAt(killMs - 300_000);
  const baseB = cpuAt(killMs - 5_000);
  const winA = cpuAt(killMs);
  const winB = cpuAt(endMs);
  const windowSec = winA && winB ? (winB.t - winA.t) / 1000 : null;
  const connections = probe.expectConnections;
  const perSvc = {};
  for (const svc of svcs) {
    const baseline = rate(baseA, baseB, svc);
    const during = rate(winA, winB, svc);
    perSvc[svc] = {
      baselineCores: round(baseline, 3),
      windowCores: round(during, 3),
      extraMsPerReconnect: baseline !== null && during !== null && windowSec && connections
        ? round(((during - baseline) * windowSec * 1000) / connections, 2)
        : null,
    };
  }
  // The highest 5-second mean over the window, a container at a time.
  const peak5s = {};
  for (const svc of svcs) {
    let best = null;
    for (let i = 0; i + 5 < cpu.length; i++) {
      const a = cpu[i];
      const b = cpu[i + 5];
      if (a.t < killMs - 5000 || b.t > windowEnd) continue;
      const r = rate(a, b, svc);
      if (r !== null && (best === null || r > best)) best = r;
    }
    peak5s[svc] = round(best, 2);
  }
  // The gateway's memory peak over the window: one node holding every connection is the memory line.
  const gwMemPeak = Math.max(0, ...cpu.filter((s) => s.t >= killMs - 5000 && s.t <= windowEnd)
    .map((s) => s['link-gateway']?.memBytes ?? 0));

  // The welcome walk, from pg_stat_statements across the restart.
  const wBefore = (readJson(join(dir, 'pgss-welcome-before.json'), []) ?? [])[0] ?? {};
  const wAfter = (readJson(join(dir, 'pgss-welcome-after.json'), []) ?? [])[0] ?? {};
  const tBefore = readJson(join(dir, 'pgss-totals-before.json'), {}) ?? {};
  const tAfter = readJson(join(dir, 'pgss-totals-after.json'), {}) ?? {};
  const wCalls = Number(wAfter.calls ?? 0) - Number(wBefore.calls ?? 0);
  const wMs = Number(wAfter.total_ms ?? 0) - Number(wBefore.total_ms ?? 0);
  const wRows = Number(wAfter.rows ?? 0) - Number(wBefore.rows ?? 0);
  const wHit = Number(wAfter.shared_blks_hit ?? 0) - Number(wBefore.shared_blks_hit ?? 0);
  const wRead = Number(wAfter.shared_blks_read ?? 0) - Number(wBefore.shared_blks_read ?? 0);
  const dbMs = Number(tAfter.totalExecMs ?? 0) - Number(tBefore.totalExecMs ?? 0);

  return {
    dir,
    signal,
    killedAt: new Date(killMs).toISOString(),
    startedBy: probe.startedBy,
    oldProcessGoneMs: probe.exitedMs ? probe.exitedMs - killMs : null,
    runningAgainMs: probe.runningMs - killMs,
    // From the kill, and from the moment the new process ran (the first run's evidence 11 reported the latter).
    backMs: {
      p50: probe.milestones?.p50 ? probe.milestones.p50 - killMs : null,
      p90: probe.milestones?.p90 ? probe.milestones.p90 - killMs : null,
      p99: probe.milestones?.p99 ? probe.milestones.p99 - killMs : null,
      whole: wholeMs ? wholeMs - killMs : null,
    },
    backFromRestartMs: {
      p50: probe.milestones?.p50 ? probe.milestones.p50 - probe.runningMs : null,
      p90: probe.milestones?.p90 ? probe.milestones.p90 - probe.runningMs : null,
      p99: probe.milestones?.p99 ? probe.milestones.p99 - probe.runningMs : null,
      whole: wholeMs ? wholeMs - probe.runningMs : null,
    },
    depthBefore: readJson(join(dir, 'depth-before.json')),
    depthAfter: readJson(join(dir, 'depth-after.json')),
    helloSessions: readJson(join(dir, 'hello-sessions.json')),
    // The old process between the kill and its exit (a SIGTERM drains first; a SIGKILL leaves nothing).
    oldProcess: {
      drainsSent: ctr(oldProcess, 'link_drains_sent_total'),
      handshakesDraining: ctr(oldProcess, 'link_handshakes_total{result="draining"}'),
      connectionsAtKill: ctr(oldProcess, 'link_connections'),
      disconnectsDrained: ctr(oldProcess, 'link_disconnects_total{reason="drained"}'),
      scrapesAfterKill: oldScrapes.filter((s) => s.t > killMs).length,
    },
    newProcess: {
      handshakesOk: ctr(newProcess, 'link_handshakes_total{result="ok"}'),
      handshakesRateLimited: ctr(newProcess, 'link_handshakes_total{result="rate_limited"}'),
      handshakesOther: sumKeys(newProcess, /^link_handshakes_total\{result="(?!ok|rate_limited)/),
      connectionsNow: ctr(newProcess, 'link_connections'),
      handshake,
      welcome: {
        answered: ctr(newProcess, 'link_welcome_lookups_total{result="answered"}'),
        failed: ctr(newProcess, 'link_welcome_lookups_total{result="failed"}'),
        refused: ctr(newProcess, 'link_welcome_lookups_total{result="refused"}'),
        malformed: ctr(newProcess, 'link_welcome_lookups_total{result="malformed"}'),
        callAnswered: ctr(newProcess, 'link_backend_calls_total{kind="welcome",result="answered"}'),
        callTimeout: ctr(newProcess, 'link_backend_calls_total{kind="welcome",result="timeout"}'),
        callCancelled: ctr(newProcess, 'link_backend_calls_total{kind="welcome",result="cancelled"}'),
        callUnavailable: ctr(newProcess, 'link_backend_calls_total{kind="welcome",result="unavailable"}'),
        callCutOff: ctr(newProcess, 'link_backend_calls_total{kind="welcome",result="cut_off"}'),
      },
      retriesByReason: Object.fromEntries(Object.entries(newProcess)
        .filter(([k, v]) => k.startsWith('link_backend_retries_total{') && v > 0)),
      tokenRefusals: Object.fromEntries(Object.entries(newProcess)
        .filter(([k, v]) => k.startsWith('link_token_refusals_total{') && v > 0)),
    },
    // The peak admitted-handshake rate, from the new process's link_handshakes_total{result="ok"} a second apart.
    handshakePeakPerSec: (() => {
      const ok = newScrapes.map((s) => ({ t: s.t, n: s['link_handshakes_total{result="ok"}'] ?? 0 }));
      let best = 0;
      for (let i = 1; i < ok.length; i++) {
        const dt = (ok[i].t - ok[i - 1].t) / 1000;
        if (dt > 0 && ok[i].n >= ok[i - 1].n) best = Math.max(best, (ok[i].n - ok[i - 1].n) / dt);
      }
      return round(best, 0);
    })(),
    welcomeStatement: {
      calls: wCalls,
      sessionsTouched: wRows,
      totalMs: round(wMs, 1),
      msPerCall: wCalls > 0 ? round(wMs / wCalls, 3) : null,
      msPerSession: wRows > 0 ? round(wMs / wRows, 4) : null,
      shareOfDbExecPct: dbMs > 0 ? round((100 * wMs) / dbMs, 2) : null,
      dbExecMsInWindow: round(dbMs, 1),
      bufferHitPct: wHit + wRead > 0 ? round((100 * wHit) / (wHit + wRead), 3) : null,
      blocksRead: wRead,
    },
    cpu: { windowSeconds: round(windowSec, 1), perService: perSvc, peak5sCores: peak5s, apiservers },
    gatewayMemPeakMiB: round(gwMemPeak / 1024 / 1024, 0),
    gatewayMemPerConnectionKiB: connections > 0 ? round(gwMemPeak / connections / 1024, 1) : null,
    reaper: readJson(join(dir, 'reaped.json')),
    webLinkToken: readJson(join(dir, 'web-link-token.json'), []),
    metricsScrapes: metrics.length,
    scrapesDown: metrics.filter((s) => s.up === 0).length,
  };
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: reconnect-report.mjs <probe-dir> [more...]');
  process.exit(2);
}
console.log(JSON.stringify(dirs.map(analyse), null, 2));

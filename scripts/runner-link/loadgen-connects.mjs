#!/usr/bin/env node
// What one connect costs (task O3), from a load test run's ramp (loadgen-run.sh): every runner's first connection, at the
// loadgen's -ramp-rate. A connect is a link token minted through the web gateway (POST /api/runner/link-token), a TLS
// handshake and Hello at the link gateway, the Welcome route (each session's durable seq and lease), and the
// connection's first heartbeat, which carries every part whole and is reconciled in full. It is what a gateway node's
// loss costs the rest of the cell for each of its runners, when they come back (an upper bound: a runner whose token
// is still good does not mint another).
//
// Over the span from the run's start to its steady window (the ramp and the settle), each part's CPU time above what the
// steady window costs it a second, scaled to the share of the fleet connected at each moment (series.jsonl), over the
// connects. The steady window's renewals and sweeps are in what is subtracted, so what is left is the connects' own.
// "apiserver" is every apiserver of the stack together.
//
//   node scripts/runner-link/loadgen-connects.mjs <run dir>...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
for (const dir of process.argv.slice(2)) {
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  const samples = readFileSync(join(dir, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const series = readFileSync(join(dir, 'series.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const from = Date.parse(summary.startedAt);
  const to = Date.parse(summary.steadyStartedAt);
  const runners = summary.config.runners;
  const connectedAt = (t) => {
    let n = 0;
    for (const l of series) {
      if (Date.parse(l.at) <= t) n = l.connected;
      else return { n, next: l.connected };
    }
    return { n, next: n };
  };
  const keys = Object.keys(report.components).filter((k) => k !== 'loadgen');
  const out = {};
  for (const key of keys) {
    let used = 0;
    let steadyShare = 0;
    for (let i = 1; i < samples.length; i++) {
      const [a, b] = [samples[i - 1], samples[i]];
      if (!a[key] || !b[key]) continue;
      const lo = Math.max(a.t, from);
      const hi = Math.min(b.t, to);
      if (hi <= lo) continue;
      const frac = (hi - lo) / (b.t - a.t);
      used += ((b[key].cpuUsec - a[key].cpuUsec) / 1e6) * frac;
      // The fleet connected over the slice, as the series' lines around it say (they are 10 s apart).
      const c = connectedAt((lo + hi) / 2);
      steadyShare += ((hi - lo) / 1000) * (Math.min(c.n, c.next) + Math.max(c.n, c.next)) / 2 / runners;
    }
    const steadyCores = report.components[key].meanCores;
    out[key] = { usedCoreSeconds: round(used, 2), steadyCoreSeconds: round(steadyCores * steadyShare, 2),
      perConnectMs: round(((used - steadyCores * steadyShare) * 1000) / summary.whole.counters.connects, 3) };
  }
  const apiservers = keys.filter((k) => /^apiserver(-[a-z0-9]+)?$/.test(k));
  const sum = (field) => round(apiservers.reduce((n, k) => n + out[k][field], 0), 3);
  console.log(JSON.stringify({
    run: report.run, connects: summary.whole.counters.connects, tokensMinted: summary.whole.counters.tokensMinted,
    rampSeconds: summary.rampSeconds, spanSeconds: round((to - from) / 1000, 1), rampRate: summary.config.rampRate,
    firstBeatsReconciled: series.filter((l) => l.phase === 'ramp' || l.phase === 'settle').reduce((n, l) => n + l.heartbeatsReconciled, 0),
    perConnectMs: { apiserver: sum('perConnectMs'), ...Object.fromEntries(keys.filter((k) => !apiservers.includes(k)).map((k) => [k, out[k].perConnectMs])) },
    components: out,
  }));
}

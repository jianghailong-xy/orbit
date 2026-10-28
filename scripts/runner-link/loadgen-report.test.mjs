// loadgen-report.mjs on synthetic runs that differ in one thing: whether the link gateway restarts in the steady window,
// as an OOM kill and the restart policy, or a kill and `docker start`, leave it (C2b, 2026-10-28). Each new process
// counts again from zero, and so does its container's cgroup; the report adds up what each process counted, so every
// figure comes out as in the run without a restart, except what the reconnects themselves did. The report of the run
// without a restart is byte for byte what the report was before it added anything up (testdata/loadgen-report-steady.md
// and .json, written by loadgen-report.mjs at c615e5f18). Run from the repository root:
//
//   node --test scripts/runner-link/
//
// Should the report change on purpose, write the run's report again:
//
//   node scripts/runner-link/loadgen-report.test.mjs --update-golden
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const here = import.meta.dirname;
const golden = join(here, 'testdata', 'loadgen-report-steady');
const scratch = mkdtempSync(join(tmpdir(), 'loadgen-report-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The loadgen starts at T0, its 1,000 runners are connected after 20 s, the steady window is 600 s from T0 + 60 s, and
// the run ends 30 s after it. Every restart below falls on a sample and a scrape, so that nothing the new process did
// goes unseen and every figure is exact.
const T0 = Date.UTC(2026, 9, 28, 2, 0, 0);
const STEADY_FROM = T0 + 60_000;
const STEADY_TO = T0 + 660_000;
const END = T0 + 690_000;
const iso = (t) => new Date(t).toISOString();
// The stack's containers: the cores each uses, its CPU pressure (PSI "some", a share of the time), its memory and when
// it started. The gateway's container starts again with each of its processes.
const SCOPES = { postgres: 'docker-postgres.scope', apiserver: 'docker-apiserver.scope', 'link-gateway': 'docker-link-gateway.scope' };
const POSTGRES = { cores: 2, psi: 0.05, mem: 2 * 2 ** 30, start: T0 - 600_000 };
const APISERVER = { cores: 0.8, psi: 0, mem: 700 * 2 ** 20, start: T0 - 600_000 };
const GATEWAY = { cores: 1.5, psi: 0.1, mem: 512 * 2 ** 20 };
// The gateway process at t: when it started, and from when it counted the load. A restart at t is right after t's
// sample and scrape.
const gatewayAt = (t, restarts) => {
  const start = restarts.filter((r) => r < t).at(-1);
  return start === undefined ? { start: T0 - 120_000, from: T0 } : { start, from: start };
};
const usec = (cores, t, start) => Math.round(cores * 1000 * (t - start));

// A run directory, as loadgen-run.sh leaves it, of a stack whose link gateway restarts at each of `restarts`.
function writeRun(name, restarts) {
  const dir = join(scratch, name);
  mkdirSync(dir);
  const put = (file, value) => writeFileSync(join(dir, file), JSON.stringify(value));
  const lines = (file, values) => writeFileSync(join(dir, file), values.map((v) => JSON.stringify(v) + '\n').join(''));
  const every = (step, from = T0) => Array.from({ length: Math.floor((END - from) / step) + 1 }, (_, i) => from + i * step);
  // Whether t is the first of lines `step` apart after a restart.
  const firstAfterRestart = (t, step) => restarts.some((r) => r < t && t <= r + step);
  const latency = (p50Ms, p99Ms) => ({ count: 6000, meanMs: p50Ms, p50Ms, p90Ms: p99Ms, p99Ms, p999Ms: p99Ms, maxMs: p99Ms });

  put('run.json', {
    name, project: 'orbit-link-test', sha: 'c615e5f18b5e5eb0c46bdcfdeeadf2b4d0194655', dirty: false, dbCpus: '4', backends: '1',
    mergeWindow: 'default', hostCpus: 8, hostMemKb: 16_000_000, loadTestLock: true,
    containers: Object.fromEntries(Object.entries(SCOPES).map(([svc, cgroup]) => [svc, { cgroup, cpuset: '' }])),
  });
  const errors = restarts.length ? { connection_lost: 1000 * restarts.length } : {};
  put('summary.json', {
    config: { runners: 1000, activeSessions: 500, eventRate: 20, perSessionRate: 0.04, liveRate: 0 },
    startedAt: iso(T0), steadyStartedAt: iso(STEADY_FROM), steadyEndedAt: iso(STEADY_TO), endedAt: iso(END), rampSeconds: 20,
    everConnected: 1000,
    steady: {
      seconds: 600,
      counters: { renewals: 0, reconnects: 1000 * restarts.length, tokensMinted: 0, batchesAcked: 6000, eventsAcked: 12_000,
        eventsResent: 0, payloadBytes: 7_200_000 },
      eventsAckedPerSecond: 20, batchesAckedPerSecond: 10, heartbeatAcksPerSecond: 67,
      ackBatch: latency(60, 120), ackEvent: latency(60, 120), heartbeatAck: latency(2, 9), tokenMint: latency(3, 8),
      dialToWelcome: latency(4, 40), errorTotal: 1000 * restarts.length, errors,
    },
    whole: { seconds: 690 },
    unacknowledgedEvents: 0,
    notes: {},
    errorSamples: restarts.length ? { connection_lost: [`${iso(restarts[0] + 100)} runner r-0001: failed to read frame header: EOF`] } : {},
  });
  // What the runners saw, every 10 s.
  lines('series.jsonl', every(10_000, T0 + 10_000).map((t) => {
    const phase = t <= STEADY_FROM ? 'ramp' : t <= STEADY_TO ? 'steady' : 'drain';
    return { at: iso(t), elapsedS: (t - T0) / 1000, phase, connected: phase === 'drain' ? 0 : firstAfterRestart(t, 10_000) ? 640 : Math.min(1000, (t - T0) / 20),
      eventsAcked: 200, heartbeatAcks: 670, errors: firstAfterRestart(t, 10_000) ? { connection_lost: 1000 } : {}, ackBatch: { p99Ms: 120 } };
  }));
  // The containers and the host every 5 s.
  const cgroup = (c, t, start) => ({ cpuUsec: usec(c.cores, t, start), throttledUsec: 0, memBytes: c.mem,
    psiSomeUsec: usec(c.psi, t, start), psiFullUsec: usec(c.psi / 2, t, start) });
  lines('samples.jsonl', every(5000).map((t) => {
    const s = 86_400 + (t - T0) / 1000; // seconds since the host booted: 8 CPUs, 4.8 of them busy
    return { t, postgres: cgroup(POSTGRES, t, POSTGRES.start), apiserver: cgroup(APISERVER, t, APISERVER.start),
      'link-gateway': cgroup(GATEWAY, t, gatewayAt(t, restarts).start),
      host: { cpu: [400 * s, 0, 80 * s, 320 * s, 0, 0, 0, 0], load: [4.8, 4.6, 4.4], memAvailKb: 9_000_000, swapFreeKb: 4_000_000,
        pswpin: 1000, pswpout: 2000, psiSomeUsec: 20_000 * s } };
  }));
  // Every cgroup on the host every 15 s: the stack's, and what else ran there.
  lines('slices.jsonl', every(15_000).map((t) => ({ t,
    [SCOPES.postgres]: usec(POSTGRES.cores, t, POSTGRES.start), [SCOPES.apiserver]: usec(APISERVER.cores, t, APISERVER.start),
    [SCOPES['link-gateway']]: usec(GATEWAY.cores, t, gatewayAt(t, restarts).start),
    'cron.service': usec(0.05, t, T0 - 3_600_000), 'user.slice': usec(0.45, t, T0 - 3_600_000) })));
  lines('db.jsonl', every(15_000).map((t) => {
    const s = (t - T0) / 1000;
    return { t, xactCommit: 300 * s, xactRollback: 0, blksRead: 1000, blksHit: 990_000 + 9900 * s, tupInserted: 20 * s, tupUpdated: 70 * s,
      walBytes: 52_428 * s, deadlocks: 0, tempBytes: 0, backends: { 'active:-': 3, 'idle:Client': 12 }, lockWaits: 0 };
  }));
  // The gateway's /metrics every 15 s. Each 15 s of load: 1,000 heartbeats forwarded, 150 event batches of 2 events
  // stored, acknowledged within 0.1 s (120), 0.25 s (20), 0.5 s (8), 1 s (1) and later (1). A new process has 640 of
  // the 1,000 runners back at its first scrape and all of them at the next, after refusing 250 handshakes at its limit.
  // Seven welcome calls are retried at T0 + 200 s, a series the gateway does not have until it counts one.
  writeFileSync(join(dir, 'metrics.prom'), every(15_000).map((t) => {
    const g = gatewayAt(t, restarts);
    const n = (t - g.from) / 15_000;
    const connected = g.from === T0 ? Math.min(1000, (t - T0) / 20) : firstAfterRestart(t, 15_000) ? 640 : 1000;
    const series = {
      link_gateway_start_time_seconds: g.start / 1000,
      link_connections: connected,
      'link_handshakes_total{result="ok"}': connected,
      'link_handshakes_total{result="rate_limited"}': g.from === T0 ? 0 : 250,
      'link_heartbeat_forwards_total{result="forwarded"}': 1000 * n,
      'link_backend_calls_total{kind="events",result="answered"}': 150 * n,
      'link_backend_calls_total{kind="heartbeat",result="answered"}': 1000 * n,
      ...(g.from === T0 && t >= T0 + 200_000 ? { 'link_backend_retries_total{kind="welcome",reason="lost"}': 7 } : {}),
      'link_event_batches_total{result="stored"}': 150 * n,
      link_events_stored_total: 300 * n,
      'link_event_ack_duration_seconds_bucket{le="0.1"}': 120 * n,
      'link_event_ack_duration_seconds_bucket{le="0.25"}': 140 * n,
      'link_event_ack_duration_seconds_bucket{le="0.5"}': 148 * n,
      'link_event_ack_duration_seconds_bucket{le="1"}': 149 * n,
      'link_event_ack_duration_seconds_bucket{le="+Inf"}': 150 * n,
      link_event_ack_duration_seconds_sum: 12 * n,
      link_event_ack_duration_seconds_count: 150 * n,
      'link_heartbeat_forward_duration_seconds_bucket{le="0.005"}': 900 * n,
      'link_heartbeat_forward_duration_seconds_bucket{le="0.025"}': 1000 * n,
      'link_heartbeat_forward_duration_seconds_bucket{le="+Inf"}': 1000 * n,
      link_heartbeat_forward_duration_seconds_sum: 3 * n,
      link_heartbeat_forward_duration_seconds_count: 1000 * n,
      link_ingest_queue_events: 40,
      link_credit_reduced: 0,
    };
    return `# scrape ${t}\n` + Object.entries(series).map(([k, v]) => `${k} ${v}\n`).join('');
  }).join(''));
  return dir;
}

// The report of a run, as loadgen-run.sh makes it: report.md on standard output, report.json beside the run's files.
function report(dir) {
  const r = spawnSync(process.execPath, [join(here, 'loadgen-report.mjs'), dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { md: r.stdout, text: readFileSync(join(dir, 'report.json'), 'utf8') };
}

// What every run counts alike, restarted or not: 20 events a second stored, in 10 batches, and 1,000 heartbeats every
// 15 s, over the 600 s window; the gateway's 1.5 cores at 10% CPU pressure, in the 5 s samples and in its cgroup's 15 s.
function assertTheLoad(r) {
  assert.equal(r.gateway.link_events_stored_total._, 12_000);
  assert.equal(r.gateway.link_event_batches_total['{result="stored"}'], 6000);
  assert.equal(r.gateway.link_heartbeat_forwards_total['{result="forwarded"}'], 40_000);
  assert.deepEqual(r.gateway.eventAck, { count: 6000, meanMs: 80, p50Ms: 62.5, p99Ms: 750, withinOneSecondPct: 99.333 });
  assert.deepEqual(r.components['link-gateway'], { meanCores: 1.5, peak10sCores: 1.5, peak60sCores: 1.5, peakMemMiB: 512,
    cpuPressurePct: 10, cpuPressurePeak60sPct: 10, throttledPct: 0 });
  assert.equal(r.others.find((o) => o.name.startsWith(SCOPES['link-gateway'])).meanCores, 1.5);
  assert.equal(r.host.testMeanCores, 4.3);
}

for (const [label, restarts] of [['once', [T0 + 375_000]], ['twice (an OOM loop)', [T0 + 255_000, T0 + 435_000]]]) {
  test(`a gateway restarted ${label} in the window: its counters and CPU added up over each process`, () => {
    const r = JSON.parse(report(writeRun(`restarted-${restarts.length}`, restarts)).text);
    assertTheLoad(r);
    // What the restarts did: each new process took the 1,000 runners back, and refused 250 handshakes on the way.
    assert.deepEqual(r.gateway.link_handshakes_total, { '{result="ok"}': 1000 * restarts.length, '{result="rate_limited"}': 250 * restarts.length });
    assert.deepEqual(r.gateway.connections, { min: 640, max: 1000 });
    // The retries the first process counted are there, though the last process never had the series.
    assert.deepEqual(r.gatewayErrors, { 'handshakes{result="rate_limited"}': 250 * restarts.length, 'backend_retries{kind="welcome",reason="lost"}': 7 });
    assert.equal(r.errorCounts.gateway, 250 * restarts.length + 7);
  });
}

test('a run without a restart: the report is byte for byte what it was before restarts were added up', () => {
  const { md, text } = report(writeRun('steady', []));
  if (process.argv.includes('--update-golden')) {
    mkdirSync(join(here, 'testdata'), { recursive: true });
    writeFileSync(`${golden}.md`, md);
    writeFileSync(`${golden}.json`, text);
    return;
  }
  const r = JSON.parse(text);
  assertTheLoad(r);
  assert.deepEqual(r.gateway.link_handshakes_total, {});
  assert.deepEqual(r.gatewayErrors, { 'backend_retries{kind="welcome",reason="lost"}': 7 });
  assert.equal(md, readFileSync(`${golden}.md`, 'utf8'));
  assert.equal(text, readFileSync(`${golden}.json`, 'utf8'));
});

// gateway-limit-report.mjs on a synthetic gateway-limit.sh run whose every figure is known: one level of 1,000
// connections played by two shards from two source addresses, the gateway idle at 0.01 cores and 20 MiB first, then at
// 0.15 cores and up to 260 MiB. Run from the repository root:
//
//   node --test scripts/runner-link/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const here = import.meta.dirname;
const scratch = mkdtempSync(join(tmpdir(), 'gateway-limit-report-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 9, 31, 0, 0, 0);
const IDLE = [T0 + 5_000, T0 + 25_000];
const LEVEL = [T0 + 30_000, T0 + 420_000];
const STEADY = [T0 + 90_000, T0 + 390_000];
const MiB = 2 ** 20;
// The loadgen's and the stub's histogram bucket of a duration: below 1.01^(i+1) µs.
const bucket = (ms) => Math.floor(Math.log(ms * 1000) / Math.log(1.01));
const upper = (i) => Math.round(1.01 ** (i + 1)) / 1000;

function writeRun(dir) {
  const put = (name, body) => {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  };
  put('run.json', {
    name: 'synthetic', sha: 'c18e80ff28e9aaaa', dirty: false, go: 'go version go1.27.1 linux/amd64',
    binaryUnderTest: { source: 'src/link-gateway at the commit above', probe: true, probeFile: 'scripts/runner-link/gateway-limit-probe.go', probeSha256: 'ab'.repeat(32) },
    gateway: { cpus: '4', memory: '4G', cpuset: '0-7', env: [], tls: 'files, ECDSA P-256' },
    rig: { shards: 2, sources: ['127.0.0.2', '127.0.0.3'], stubs: 2, stubDelay: '5ms', eventsPerConnection: 0.1333, loadgenArgs: ['-volatile'] },
    host: { cpus: 24, cpuModel: 'Test CPU', memKb: 16 * 2 ** 20, kernel: '6.12', settings: { 'net.ipv4.tcp_mem': '182313 243084 364626' } },
    loadTestLock: true, warnings: [], gatewayStartMs: T0, idleFromMs: IDLE[0], idleToMs: IDLE[1],
  });
  put('levels/1000/level.json', { level: 1000, startedMs: LEVEL[0], endedMs: LEVEL[1], rampRate: 16.667, eventRate: 133.3, shardExits: [0, 0] });
  const hist = (buckets) => ({ base: 1.01, count: buckets.reduce((a, [, n]) => a + n, 0), sumSeconds: 1, maxMs: 200, buckets });
  for (const s of [0, 1]) {
    const steady = { seconds: 300, heartbeatAcksPerSecond: 8.3, eventsAckedPerSecond: 66.6, batchesAckedPerSecond: 43,
      counters: { heartbeatsSent: 2500, heartbeatAcks: 2500, eventsProduced: 20000, eventsAcked: 20000 }, errors: {} };
    const whole = { counters: { heartbeatsSent: 3000, heartbeatAcks: 3000, eventsProduced: 26000, eventsAcked: 26000, renewals: 40, reconnects: 0, tokensMinted: 540 },
      errors: s === 1 ? { upgrade_refused_429: 2 } : {} };
    put(`levels/1000/shard-${s}/summary.json`, {
      config: { shard: { index: s, count: 2 } }, everConnected: 500, unacknowledgedEvents: 0,
      steadyStartedAt: new Date(STEADY[0] - s * 1000).toISOString(), steadyEndedAt: new Date(STEADY[1] + s * 1000).toISOString(), steady, whole,
    });
    const beat = s === 0 ? [[bucket(4), 99], [bucket(30), 1]] : [[bucket(4), 100]];
    put(`levels/1000/shard-${s}/histograms.json`, {
      steady: { heartbeatAck: hist(beat), ackBatch: hist([[bucket(110), 100]]), ackEvent: hist([[bucket(110), 150]]), tokenMint: hist([]), dialToWelcome: hist([]) },
      whole: { heartbeatAck: hist(beat), ackBatch: hist([[bucket(110), 120]]), ackEvent: hist([[bucket(110), 180]]), tokenMint: hist([[bucket(6), 270]]),
        dialToWelcome: hist([[bucket(7), 270]]) },
    });
  }
  // Every 5 s: the gateway at 0.01 cores and 20 MiB idle, 0.15 cores and 250 MiB from the level's start (260 MiB once,
  // at +200 s); each shard at 0.05 cores; the host 0.6 cores busy, 0.02 of them softirq.
  const samples = [];
  let gw = 0;
  let host = [0, 0, 0, 0, 0, 0, 0, 0];
  let k = { listenOverflows: 5, listenDrops: 5, conntrackCount: 1500, conntrackMax: 262144, drop: 0, tcpMemPages: 1000, netRxSoftirqs: 0, netTxSoftirqs: 0 };
  for (let t = T0; t <= T0 + 440_000; t += 5_000) {
    const busy = t >= LEVEL[0] && t <= LEVEL[1];
    if (t > T0) gw += (t > LEVEL[0] && t <= LEVEL[1] ? 0.15 : 0.01) * 5e6;
    host = host.map((v, i) => v + [200, 0, 90, 4000, 0, 0, 10, 0][i]);
    k = { ...k, netRxSoftirqs: k.netRxSoftirqs + 5000, conntrackCount: busy ? 2500 : 1500, listenOverflows: t === T0 + 300_000 ? 7 : k.listenOverflows };
    const mem = (busy ? (t === T0 + 200_000 ? 260 : 250) : 20) * MiB;
    const cgroups = { gateway: { cpuUsec: gw, throttledUsec: 0, memBytes: mem, anonBytes: mem / 2, sockBytes: MiB, psiSomeUsec: 0, oomKills: 0 },
      'stub-0': { cpuUsec: (t - T0) * 10, throttledUsec: 0, memBytes: 10 * MiB, anonBytes: 0, sockBytes: 0, psiSomeUsec: 0, oomKills: 0 },
      nats: { cpuUsec: 0, throttledUsec: 0, memBytes: 20 * MiB, anonBytes: 0, sockBytes: 0, psiSomeUsec: 0, oomKills: 0 } };
    if (busy) for (const s of [0, 1]) cgroups[`loadgen-1000-${s}`] = { cpuUsec: (t - LEVEL[0]) * 50, throttledUsec: 0, memBytes: 100 * MiB, anonBytes: 0, sockBytes: 0, psiSomeUsec: 0, oomKills: 0 };
    samples.push({ t, cgroups, gateway: { rssKb: busy ? 240 * 1024 : 18 * 1024, hwmKb: 0, threads: 9 },
      host: { cpu: host, load: [20, 20, 20], memAvailKb: 5 * 2 ** 20, swapFreeKb: 0, pswpin: 0, pswpout: 0, psiSomeUsec: 0 }, kernel: k });
  }
  put('samples.jsonl', samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
  // Every 15 s: /metrics with 1,000 connections from +60 s, and the handshakes of the ramp: 900 within 5 ms, 1,000 within 10.
  let prom = '';
  for (let t = T0; t <= T0 + 440_000; t += 15_000) {
    const up = t >= T0 + 60_000;
    const hs = t >= T0 + 60_000 ? 1000 : 0;
    prom += `# scrape ${t}\nlink_connections ${up && t <= LEVEL[1] ? 1000 : 0}\nlink_handshakes_total{result="ok"} ${hs}\n` +
      `link_handshake_duration_seconds_bucket{le="0.005"} ${hs * 0.9}\nlink_handshake_duration_seconds_bucket{le="0.01"} ${hs}\n` +
      `link_handshake_duration_seconds_bucket{le="+Inf"} ${hs}\nlink_handshake_duration_seconds_count ${hs}\nlink_handshake_duration_seconds_sum ${hs * 0.005}\n` +
      `link_backend_calls_total{kind="heartbeat",result="answered"} ${Math.max(0, Math.round((t - LEVEL[0]) / 30))}\n`;
  }
  put('metrics.prom', prom);
  put('probe.jsonl', [IDLE[0], IDLE[1], STEADY[0], T0 + 240_000, STEADY[1]].map((t, i) => JSON.stringify({
    t, '/sched/goroutines:goroutines': t < LEVEL[0] ? 26 : 4026, '/sched/gomaxprocs:threads': 4,
    '/sched/pauses/total/gc:seconds': [[0.00001, 0.00002, 10 + i * 100], [0.0004, 0.0005, i]],
    '/cpu/classes/gc/total:cpu-seconds': i * 3, '/cpu/classes/total:cpu-seconds': i * 1000,
  })).join('\n') + '\n');
  const stubStats = (stub, t, calls) => JSON.stringify({ stub, t, cpuSeconds: (t - T0) / 1e5, inFlightMax: 3,
    routes: calls ? { heartbeat: { calls, byStatus: { '2xx': calls }, work: { buckets: [[bucket(0.2), calls]] },
      answered: { buckets: [[bucket(5.1), calls - calls / 100], [bucket(5.6), calls / 100]] } } } : {} });
  put('stub.jsonl', [stubStats(0, STEADY[0], 0), stubStats(1, STEADY[0], 0), stubStats(0, STEADY[1], 5000), stubStats(1, STEADY[1], 5000)].join('\n') + '\n');
  put('sockets.jsonl', [STEADY[0] + 15_000, STEADY[0] + 30_000].map((t, i) => JSON.stringify({ t, fds: 1100 + i,
    bySource: { '127.0.0.2': 500 - i, '127.0.0.3': 500 + i } })).join('\n') + '\n');
  put('logs/gateway.log', ['time=x level=INFO msg="link gateway serving"',
    ...[[100, 0.05], [160, 0.08], [220, 0.5], [400, 9]].map(([s, pause], i) => `gc ${i + 1} @${s}.000s 1%: ${pause / 2}+1.5+${pause / 2} ms clock, 0.1+0.2/0.3/0.4+0.5 ms cpu, 100->110->${60 + i} MB, 120 MB goal, 0 MB stacks, 0 MB globals, 4 P`)].join('\n') + '\n');
}

test('every figure of a level comes out as the run recorded it', () => {
  const dir = join(scratch, 'run');
  writeRun(dir);
  const res = spawnSync(process.execPath, [join(here, 'gateway-limit-report.mjs'), dir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.levels.length, 1);
  const l = report.levels[0];
  const g = l.gateway;
  // The steady window every shard was in: the latest start, the earliest end.
  assert.deepEqual(l.window, { from: new Date(STEADY[0]).toISOString(), to: new Date(STEADY[1]).toISOString() });
  assert.deepEqual(g.connections, { target: 1000, min: 1000, max: 1000 });
  assert.equal(g.meanCores, 0.15);
  assert.equal(g.coresPer1000Connections, 0.15);
  assert.equal(g.coresPer1000AboveIdle, 0.14);
  assert.equal(g.maxMiB, 260);
  assert.equal(g.kibPerConnection, 266.2);
  assert.equal(g.kibPerConnectionAboveIdle, 245.8);
  assert.equal(g.rssKibPerConnection, 245.8);
  assert.deepEqual([g.goroutinesMax, g.goroutinesPerConnection, g.gomaxprocs], [4026, 4.03, 4]);
  assert.deepEqual(g.connectionsBySource, { '127.0.0.2': { min: 499, max: 500 }, '127.0.0.3': { min: 500, max: 501 } });
  assert.equal(g.fdsMax, 1101);
  // gctrace's cycles inside the window, their pauses the sum of the two stop-the-world phases.
  assert.deepEqual([g.gc.cycles, g.gc.pauseP50Ms, g.gc.pauseP99Ms, g.gc.heapLiveMaxMB], [3, 0.08, 0.5, 62]);
  assert.equal(g.gc.probe.pauses, 202);
  assert.equal(g.gc.probe.gcCores, round(6 / 300, 3));
  // The handshakes of the whole level, interpolated in their bucket: 990 of 1,000 at 5 + 0.9 * 5 ms.
  assert.equal(g.handshakeDuration.count, 1000);
  assert.equal(g.handshakeDuration.p99Ms, 9.5);
  assert.deepEqual(g.handshakes, { '{result="ok"}': 1000 });
  // The runners: counters added up, latencies from the histograms added up bucket by bucket.
  const r = l.runners;
  assert.equal(r.heartbeatAck.count, 200);
  assert.equal(r.heartbeatAck.p99Ms, upper(bucket(4)));
  assert.equal(r.heartbeatAcksPerSecond, 16.6);
  assert.deepEqual([r.wholeErrorTotal, r.steadyErrorTotal], [2, 0]);
  assert.deepEqual(r.refusals, { upgrade_refused_429: 2 });
  assert.equal(r.everyHeartbeatAnswered, true);
  assert.equal(r.everyEventAnswered, true);
  assert.equal(r.everConnected, 1000);
  // The rig: two shards at 0.05 cores each; the stubs within their delay; the host and the kernel.
  assert.equal(l.rig.loadgen.meanCores, 0.1);
  assert.equal(l.rig.stub.meanCores, 0.01);
  assert.equal(l.rig.check.stubKeptUp, true);
  assert.equal(l.rig.check.stubAnsweredP99Ms, upper(bucket(5.1)));
  assert.equal(l.rig.stubSelf.routes.heartbeat.callsPerSecond, round(10000 / 300, 1));
  assert.equal(l.host.busyCoresMean, 0.6);
  assert.equal(l.host.softirqCores, 0.02);
  assert.equal(l.kernel.listenOverflows, 2);
  assert.equal(l.kernel.conntrackCountMax, 2500);
  assert.equal(l.kernel.netRxSoftirqsPerSecond, 1000);
  assert.equal(l.kernel.tcpMemPressureMiB, 950);
  assert.deepEqual(l.vsC2b, { coresPer1000: 0.0534, coresGapPct: 181, kibPerConnection: 242.8, memoryGapPct: 10 });
  assert.equal(report.idle.meanCores, 0.01);
  const md = readFileSync(join(dir, 'report.json'), 'utf8') && res.stdout;
  assert.match(md, /plus `scripts\/runner-link\/gateway-limit-probe\.go` \(sha256 `(ab){32}`\)/);
  assert.match(md, /\| 1000 \| 0\.15 \| \+181% \(over 30%\) \| 0\.14 \| 266\.2 \| \+10% \| 245\.8 \|/);
  assert.match(md, /6000, 6000: every one answered/);
  assert.match(md, /127\.0\.0\.2 499-500, 127\.0\.0\.3 500-501/);
  assert.doesNotMatch(md, /\b(null|undefined|NaN)\b/);
});

test('a run without the probe says so, and a level a shard never steadied is reported over the whole level', () => {
  const dir = join(scratch, 'no-probe');
  writeRun(dir);
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  run.binaryUnderTest = { source: run.binaryUnderTest.source, probe: false, probeFile: null, probeSha256: null };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run));
  rmSync(join(dir, 'probe.jsonl'));
  const summary = JSON.parse(readFileSync(join(dir, 'levels/1000/shard-1/summary.json'), 'utf8'));
  delete summary.steadyStartedAt;
  delete summary.steadyEndedAt;
  writeFileSync(join(dir, 'levels/1000/shard-1/summary.json'), JSON.stringify(summary));
  const res = spawnSync(process.execPath, [join(here, 'gateway-limit-report.mjs'), dir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /without the runtime probe/);
  assert.match(res.stdout, /not every shard reached it/);
  const l = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).levels[0];
  assert.equal(l.complete, false);
  assert.equal(l.gateway.goroutinesMax, null);
  assert.equal(l.window.from, new Date(LEVEL[0]).toISOString());
});

function round(v, d) {
  return Math.round(v * 10 ** d) / 10 ** d;
}

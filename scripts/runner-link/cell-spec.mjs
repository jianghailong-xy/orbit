#!/usr/bin/env node
// A runner link cell's size, projected from what each operation costs (task O3; docs/runner-link-design.md §9;
// docs/self-hosting.md, "Large deployments"). The costs are measured at a fraction of the cell (README.md beside this
// file: "Per-operation baseline", "The live stream", "The cell's size") and written to an inputs file, each with the runs
// it rests on; this script does the arithmetic, linear in each rate, and prints every step of it.
//
//   node scripts/runner-link/cell-spec.mjs <inputs.json> [--json out.json]
//
// The inputs file: { cell, costs, rules } as in the example the README gives. Costs are CPU milliseconds per operation
// (or cores, for a process's idle cost); rates are per second at the cell's peak.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const at = args.indexOf('--json');
const jsonOut = at >= 0 ? args.splice(at, 2)[1] : null;
if (args.length !== 1) {
  console.error('usage: cell-spec.mjs <inputs.json> [--json out.json]');
  process.exit(2);
}
const { cell, costs, rules } = JSON.parse(readFileSync(args[0], 'utf8'));
const r2 = (v) => Math.round(v * 100) / 100;
const lines = [];
const say = (...s) => lines.push(...s);

// Mean cores of each part at the cell's peak rates: rate × cost, operation by operation.
const parts = { apiserver: [], database: [], gateway: [], nats: [], webGateway: [] };
const add = (part, label, rate, ms) => {
  if (ms == null) return;
  parts[part].push({ label, rate, ms, cores: (rate * ms) / 1000 });
};
const f = cell.fullReconcileShare;
const beat = (k) => (1 - f) * costs.beatUnflagged[k] + f * costs.beatFull[k];
for (const [part, k] of [['apiserver', 'apiserverMs'], ['database', 'databaseMs'], ['gateway', 'gatewayMs']]) {
  add(part, `heartbeats (${r2(f * 100)}% reconciled in full)`, cell.heartbeatsPerSecond, costs.beatFull[k] == null ? null : beat(k));
  add(part, 'durable events', cell.eventsPerSecond, costs.event[k]);
  add(part, 'live deltas forwarded', cell.liveDeltasPerSecond, costs.liveDelta[k]);
  add(part, 'connects (renewals)', cell.renewalsPerSecond, costs.connect[k]);
}
add('nats', 'live deltas forwarded', cell.liveDeltasPerSecond, costs.liveDelta.natsMs);
add('webGateway', 'live deltas forwarded', cell.liveDeltasPerSecond, costs.liveDelta.webGatewayMs);
add('webGateway', 'connects (renewals)', cell.renewalsPerSecond, costs.connect.webGatewayMs);
const total = (part) => parts[part].reduce((n, x) => n + x.cores, 0);

// Apiserver processes. A process's limit is its main thread: of a process's CPU, mainThreadShare is the main thread's.
// The link gateway spreads the runners' calls (heartbeats, events, connects) evenly over every process. The live relay
// does not spread: a watcher's session stream reaches the apiserver through the web gateway, which sends people's
// requests to the first process alone (docs/self-hosting.md, "Several apiservers"), so its relay is the first one's.
// N is the least number of processes that keeps the main thread of each process but the first under
// rules.apiserverMainThreadMax at the peak, and under rules.apiserverMainThreadMaxOneDown with one of them down. The first
// one carries its share and the relay: it is checked against the same limits, and when it does not fit, more processes
// are not the answer (the relay does not divide); the spec says so. With rules.sessionStreamsSpread, the session
// streams are spread over every process too (an open design question: a web-gateway route the deployment does not have),
// and the relay divides with the rest.
const spreadLabels = new Set(['heartbeats', 'durable events', 'connects (renewals)', ...(rules.sessionStreamsSpread ? ['live deltas forwarded'] : [])]);
const isSpread = (x) => [...spreadLabels].some((l) => x.label.startsWith(l));
const apiSpread = parts.apiserver.filter(isSpread).reduce((n, x) => n + x.cores, 0);
const apiFirstOnly = parts.apiserver.filter((x) => !isSpread(x)).reduce((n, x) => n + x.cores, 0);
const apiMean = apiSpread + apiFirstOnly;
const peak = rules.peakOverMean.apiserver;
const share = costs.apiserverMainThreadShare;
const idle = costs.idlePerProcess.apiserverCores;
const other = (n) => ((apiSpread * peak) / n + idle) * share;
const first = (n) => ((apiSpread * peak) / n + apiFirstOnly * peak + idle) * share;
const fits = (n) => other(n) <= rules.apiserverMainThreadMax && other(n - 1) <= rules.apiserverMainThreadMaxOneDown;
let n = 2;
while (!fits(n) && n < 64) n++;
const firstFits = first(n) <= rules.apiserverMainThreadMax && first(n - 1) <= rules.apiserverMainThreadMaxOneDown;
const firstFloor = (apiFirstOnly * peak + idle) * share;
// The database: its own peak, every apiserver's idle work beside it, under rules.databaseCpuMax (the C8 criterion).
const dbMean = total('database') + n * costs.idlePerProcess.databaseCores;
const dbPeak = dbMean * rules.peakOverMean.database;
const dbCores = Math.ceil(dbPeak / rules.databaseCpuMax);
// Gateway nodes: connections and CPU, each with one node down.
const gwCores = total('gateway');
const nodes = Math.max(rules.gatewayNodesMin, Math.ceil(cell.connections / rules.gatewayConnectionsPerNodeMax) + 1);
const perNodeConnections = Math.ceil(cell.connections / (nodes - 1));
const perNodeMemGiB = (perNodeConnections * costs.gatewayBytesPerConnection) / 2 ** 30;
// A gateway node's loss: its runners reconnect to the others at the handshake limit of those left.
const stormRate = (nodes - 1) * rules.gatewayHandshakesPerSecond;
const stormSeconds = cell.connections / nodes / stormRate;

say(`Cell: ${cell.connections} connections, ${cell.heartbeatsPerSecond} heartbeats/s, ${cell.eventsPerSecond} durable events/s, ` +
  `${cell.liveDeltasPerSecond} live deltas/s forwarded, ${cell.renewalsPerSecond} renewals/s; ${r2(f * 100)}% of beats reconciled in full.`);
for (const part of Object.keys(parts)) {
  say('', `${part}:`);
  for (const x of parts[part]) say(`  ${x.label}: ${x.rate}/s × ${x.ms} ms = ${r2(x.cores)} cores`);
  say(`  mean ${r2(total(part))} cores`);
}
say('', `apiserver: mean ${r2(apiMean)} cores, of which ${r2(apiSpread)} spread over every process and ${r2(apiFirstOnly)} the first ` +
  `one's alone${rules.sessionStreamsSpread ? ' (the session streams spread over every process too)' : ' (the live relay)'}; ` +
  `peak/mean ${peak}; main thread ${share} of a process's CPU; idle ${idle} cores a process.`);
say(`  ${n} processes: at the peak the first one's main thread ${r2(first(n) * 100)}% busy and each other's ${r2(other(n) * 100)}% ` +
  `(≤ ${rules.apiserverMainThreadMax * 100}%); with one of the others down ${r2(first(n - 1) * 100)}% and ${r2(other(n - 1) * 100)}% ` +
  `(≤ ${rules.apiserverMainThreadMaxOneDown * 100}%). People's own requests come on top, on the first one: not measured here.`);
if (!firstFits) {
  say(`  THE FIRST ONE DOES NOT FIT: the live relay alone keeps its main thread ${r2(firstFloor * 100)}% busy at the peak, ` +
    `before its share of the gateway's calls; more processes do not divide it: the session streams must be spread too.`);
}
say(`database: mean ${r2(dbMean)} cores (${n} processes' idle work included) × peak/mean ${rules.peakOverMean.database} = ` +
  `${r2(dbPeak)} cores at the 10 s peak; under ${rules.databaseCpuMax * 100}% of ${dbCores} cores.`);
say(`gateway: ${nodes} nodes, ${perNodeConnections} connections each with one down (≤ ${rules.gatewayConnectionsPerNodeMax}), ` +
  `${r2(perNodeMemGiB)} GiB of connections each; ${r2(gwCores)} cores across the cell, ${r2(gwCores / (nodes - 1))} a node with one down.`);
say(`a gateway node's loss: ${Math.round(cell.connections / nodes)} runners reconnect at up to ${stormRate}/s for about ` +
  `${r2(stormSeconds)} s, ${r2((stormRate * costs.connect.apiserverMs) / 1000)} apiserver cores and ` +
  `${r2((stormRate * costs.connect.databaseMs) / 1000)} database cores meanwhile (a connect with its token minted: an upper bound).`);
const spec = {
  sessionStreamsSpread: !!rules.sessionStreamsSpread, apiserverProcesses: n, firstProcessFits: firstFits, firstProcessFloorPct: r2(firstFloor * 100), apiserverMeanCores: r2(apiMean), apiserverSpreadCores: r2(apiSpread), apiserverFirstOnlyCores: r2(apiFirstOnly),
  mainThreadPeakPct: { first: r2(first(n) * 100), other: r2(other(n) * 100) },
  mainThreadOneDownPct: { first: r2(first(n - 1) * 100), other: r2(other(n - 1) * 100) }, databaseMeanCores: r2(dbMean), databasePeakCores: r2(dbPeak),
  databaseCores: dbCores, gatewayNodes: nodes, gatewayConnectionsPerNodeOneDown: perNodeConnections, gatewayMemGiBPerNode: r2(perNodeMemGiB),
  gatewayCores: r2(gwCores), natsCores: r2(total('nats')), webGatewayCores: r2(total('webGateway')),
  storm: { reconnectsPerSecond: stormRate, seconds: r2(stormSeconds), apiserverCores: r2((stormRate * costs.connect.apiserverMs) / 1000),
    databaseCores: r2((stormRate * costs.connect.databaseMs) / 1000) },
  parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.map((x) => ({ ...x, cores: r2(x.cores) }))])),
};
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(spec, null, 2) + '\n');
console.log(lines.join('\n'));

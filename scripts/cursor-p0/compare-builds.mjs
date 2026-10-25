#!/usr/bin/env node
// Compares two builds' runs of the same scenarios (no CLI, no prompt): which checks differ, and how the
// recorded details differ once what changes from run to run is set aside (timings, sizes, pids, run
// ids, numbering of redacted ids, the version strings themselves). With --cli-a/--cli-b (the unpacked
// builds) it also compares the packages file by file and lists the chunks `agent acp` loads.
//   node scripts/cursor-p0/compare-builds.mjs <evidence dir A> <evidence dir B> <out.json> [--cli-a <dir> --cli-b <dir>]
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const cliA = opt('--cli-a'), cliB = opt('--cli-b');
const [dirA, dirB, out] = args;
const load = dir => Object.fromEntries(readdirSync(join(dir, 'scenarios')).filter(f => f.endsWith('.json')).map(f => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, 'scenarios', f), 'utf8'))]));
const A = load(dirA), B = load(dirB);
const sumA = JSON.parse(readFileSync(join(dirA, 'summary.json'), 'utf8')), sumB = JSON.parse(readFileSync(join(dirB, 'summary.json'), 'utf8'));
const versions = [sumA.cli.version, sumB.cli.version];

// What differs between any two runs, whatever the build.
const VOLATILE_KEY = /(^|[^a-z])(ms|t|seq|pid|pids|at|bytes|size|lines|matching|startTime|openedMs|closedMs|firstMs|up|down|tunnels|times)$|Ms$|At$|Pids$|Bytes$|Count$/i;
function normalize(v, key = '') {
  if (typeof v === 'number') return VOLATILE_KEY.test(key) ? '<n>' : v;
  if (typeof v === 'string') {
    let s = v;
    for (const ver of versions) s = s.split(ver).join('<VERSION>');
    return s.replace(/<UUID_\d+>/g, '<UUID>').replace(/\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}[:-]\d{2}[.-]\d{3}Z/g, '<TIME>')
      .replace(/\b\d+(\.\d+)? ?(ms|s)\b/g, '<n>$2').replace(/session-<TIME>-\d+-\d+/g, 'session-<log>').replace(/\b(pid|PID):? ?\d+/g, '$1 <n>');
  }
  if (Array.isArray(v)) return v.map(x => normalize(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x, k)]));
  return v;
}
function diff(a, b, path, outList) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, outList);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.every(x => typeof x !== 'object') && b.every(x => typeof x !== 'object')) {
    const onlyA = a.filter(x => !b.includes(x)), onlyB = b.filter(x => !a.includes(x));
    if (!onlyA.length && !onlyB.length) outList.push({ path, change: 'order only' });
    else outList.push({ path, onlyA: onlyA.slice(0, 30), onlyB: onlyB.slice(0, 30) });
    return;
  }
  const clip = x => { const s = JSON.stringify(x); return s === undefined ? null : s.length > 600 ? s.slice(0, 600) + '…' : s; };
  outList.push({ path, a: clip(a), b: clip(b) });
}

const scenarios = {};
for (const name of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
  const a = A[name], b = B[name];
  if (!a || !b) { scenarios[name] = { onlyIn: a ? versions[0] : versions[1] }; continue; }
  const checksA = Object.fromEntries(a.checks.map(c => [c.name, c.ok])), checksB = Object.fromEntries(b.checks.map(c => [c.name, c.ok]));
  const checks = [...new Set([...Object.keys(checksA), ...Object.keys(checksB)])].filter(c => checksA[c] !== checksB[c]).map(c => ({ check: c, a: checksA[c] ?? 'absent', b: checksB[c] ?? 'absent' }));
  const details = [];
  diff(normalize(a.detail), normalize(b.detail), 'detail', details);
  scenarios[name] = { passed: [a.passed, b.passed], checks: [a.checks.length, b.checks.length], checksThatDiffer: checks, detailDifferences: details };
}

let packages = null;
if (cliA && cliB) {
  const files = dir => { const m = {}; const walk = d => { for (const n of readdirSync(d)) { const f = join(d, n), st = statSync(f); st.isDirectory() ? walk(f) : (m[relative(dir, f)] = { sha256: createHash('sha256').update(readFileSync(f)).digest('hex'), bytes: st.size }); } }; walk(dir); return m; };
  const fa = files(cliA), fb = files(cliB);
  const acpChunks = dir => { const m = readFileSync(join(dir, 'index.js'), 'utf8').match(/command\("acp"[\s\S]{0,400}?Promise\.all\(\[([^\]]+)\]\)/); return m ? [...m[1].matchAll(/r\.e\((\w+)\)/g)].map(x => x[1] === '7e3' ? '7000' : x[1]) : null; };
  packages = {
    files: [Object.keys(fa).length, Object.keys(fb).length],
    bytes: [Object.values(fa).reduce((s, f) => s + f.bytes, 0), Object.values(fb).reduce((s, f) => s + f.bytes, 0)],
    added: Object.keys(fb).filter(f => !fa[f]).sort(), removed: Object.keys(fa).filter(f => !fb[f]).sort(),
    changed: Object.keys(fa).filter(f => fb[f] && fa[f].sha256 !== fb[f].sha256).sort().map(f => ({ file: f, bytes: [fa[f].bytes, fb[f].bytes] })),
    unchanged: Object.keys(fa).filter(f => fb[f] && fa[f].sha256 === fb[f].sha256).length,
    acpLoadsChunks: [acpChunks(cliA), acpChunks(cliB)],
  };
}
const result = { a: { dir: relative(process.cwd(), dirA), cli: sumA.cli, lastRunId: sumA.lastRunId }, b: { dir: relative(process.cwd(), dirB), cli: sumB.cli, lastRunId: sumB.lastRunId },
  volatileSetAside: 'numbers under timing/size/pid/count keys, run times, redacted-id numbering, the two version strings', packages, scenarios };
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
for (const [name, s] of Object.entries(scenarios)) console.log(`${name.padEnd(36)} ${s.onlyIn ? `only in ${s.onlyIn}` : `passed ${s.passed.join('/')}, checks differing ${s.checksThatDiffer.length}, detail differences ${s.detailDifferences.length}`}`);

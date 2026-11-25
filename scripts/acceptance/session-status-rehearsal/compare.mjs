// Compare walk passes (walk.mjs) with the first one, scenario by scenario, and the payloads a pass's sessions read
// when another replica serves them (recheck.mjs). Times (ms) are left out; everything else must be equal, and each
// difference is printed with its path. A recheck's differences must be §3.4 kinds, which the census names; here
// every one is listed for the reader to match.
//   node compare.mjs <out dir> <base label> <label> [<label> ...] [--recheck <label>]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [dir, base, ...rest] = process.argv.slice(2);
const read = (l) => JSON.parse(readFileSync(join(dir, `walk-${l}.json`), 'utf8'));
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'ms').map(([k, x]) => [k, strip(x)]));
  }
  return v;
}
function diff(a, b, path, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out);
    return;
  }
  out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
}
let differences = 0;
const labels = rest.filter((x, i) => x !== '--recheck' && rest[i - 1] !== '--recheck');
const b = read(base);
for (const l of labels) {
  const w = read(l);
  console.log(`## ${base} -> ${l}`);
  for (const key of Object.keys(b.scenarios)) {
    const out = [];
    diff(strip(b.scenarios[key]), strip(w.scenarios[key] ?? null), key, out);
    console.log(out.length ? `- ${key}: ${out.length} difference(s)\n${out.map((x) => `    ${x}`).join('\n')}` : `- ${key}: equal`);
    differences += out.length;
  }
  console.log(`failures in ${l}: ${(w.failures ?? []).join(', ') || 'none'}`);
}
const ri = rest.indexOf('--recheck');
if (ri >= 0) {
  const l = rest[ri + 1];
  const file = join(dir, `recheck-${l}.json`);
  if (existsSync(file)) {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    const w = read(l);
    console.log(`## payloads of ${l}'s sessions, as ${r.api} serves them, against what ${w.api} served (S12)`);
    const out = [];
    diff(w.scenarios['S12 payloads'], r.payloads, 'S12', out);
    console.log(out.length ? out.map((x) => `    ${x}`).join('\n') : '    equal');
    console.log(`(not counted: a recheck's word changes are matched against §3.4 by hand)`);
  }
}
console.log(`\n${differences} difference(s) between passes`);
process.exit(differences ? 1 : 0);

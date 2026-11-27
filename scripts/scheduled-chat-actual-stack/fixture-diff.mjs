// The panel's Vitest fixtures against what the real server sent the page (capture-real.mjs's payloads): for the
// opening (GET /api/schedules/chat), the open answer (POST /api/schedules/chat) and a Scheduled chat's session list
// row, every key path and the type of its value. Prints each difference and exits 1 if there is any.
// Usage: node fixture-diff.mjs <payloadsDir> <fixturesModule exporting opening, openAnswer, chatRow>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [dir, mod] = process.argv.slice(2);
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const real = {
  opening: read('get-schedules-chat.json'),
  openAnswer: read('post-schedules-chat.json').answer,
  chatRow: read('session-rows.json')[0],
};
const fx = await import(pathToFileURL(path.resolve(mod)).href);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
function shape(value, at, out) {
  out.set(at, typeOf(value));
  if (Array.isArray(value)) { if (value.length) shape(value[0], `${at}[]`, out); }
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) shape(v, `${at}.${k}`, out);
  return out;
}
let total = 0;
for (const name of ['opening', 'openAnswer', 'chatRow']) {
  const want = shape(real[name], name, new Map());
  const have = shape(fx[name], name, new Map());
  const lines = [];
  for (const [p, t] of want) {
    if (!have.has(p)) lines.push(`  missing  ${p}: ${t}`);
    else if (have.get(p) !== t) lines.push(`  type     ${p}: fixture ${have.get(p)}, server ${t}`);
  }
  for (const [p, t] of have) if (!want.has(p)) lines.push(`  extra    ${p}: ${t}`);
  total += lines.length;
  console.log(`${name}: ${lines.length} difference(s) (server ${want.size} paths, fixture ${have.size})`);
  for (const line of lines) console.log(line);
}
console.log(`TOTAL ${total}`);
process.exit(total ? 1 : 0);

// The rows every client driver reads: the comparison rig's fixture (36 rows) and the server's own payloads from the walk.
// usage: node make-rows.mjs <walk out dir> <rows.json>
import { readFileSync, writeFileSync } from 'node:fs';
const [walkOut, to] = process.argv.slice(2);
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const fixture = read(new URL('../fixture.json', import.meta.url)).map((r, i) => ({
  id: `fixture ${i + 1}`, name: r.name, kind: 'fixture', newFields: r.newFields, payload: r.payload,
}));
const rows = [...fixture, ...read(`${walkOut}/server-rows.json`), ...read(`${walkOut}/search-rows.json`)];
writeFileSync(to, JSON.stringify(rows, null, 1) + '\n');
console.log(`${rows.length} rows (${fixture.length} fixture)`);

// Read the payloads of an earlier walk pass's sessions from another replica (plan §7.3 S12: what a deployed app or
// runner reads for the rows walked at D1, once D2 code serves them). Writes <out>/recheck-<label>.json.
//   node recheck.mjs <label> <api base URL>        (env LM_DIR, OUT)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [label, API] = process.argv.slice(2);
const S = process.env.LM_DIR;
const OUT = process.env.OUT;
const walk = JSON.parse(readFileSync(join(OUT, `walk-${label}.json`), 'utf8'));
const password = readFileSync(`${S}/stack/secrets/owner_password`, 'utf8').trim();
async function call(method, path, token, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
const T = (await call('POST', '/auth/login', undefined, { email: 'owner@orbit-staging.test', password })).accessToken;
const KEYS = ['status', 'runStatus', 'runState', 'sessionState', 'phase', 'released', 'lastTurnOutcome', 'waitingOn', 'endReason'];
const payloads = {};
for (const name of Object.keys(walk.scenarios['S12 payloads'] ?? {}).filter((k) => k !== 'ms').sort()) {
  const p = await call('GET', `/sessions/${walk.sessions[name].publicId}`, T);
  payloads[name] = Object.fromEntries(KEYS.map((k) => [k, p[k] ?? null]));
}
writeFileSync(join(OUT, `recheck-${label}.json`), JSON.stringify({ label, api: API, at: new Date().toISOString(), payloads }, null, 1));
console.log(`${Object.keys(payloads).length} payloads of ${label} read from ${API}`);

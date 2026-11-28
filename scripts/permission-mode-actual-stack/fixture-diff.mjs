// Holds the web tests' mode fixtures (src/web/src/test/permissionModeFixtures.ts, which the Vitest tests of the running-mode
// states build their sessions with) to what this checkout's apiserver really answers on the seeded stack:
//   GET /sessions/:id                        the detail: permissionMode, actualPermissionMode, actualPermissionModeAt,
//                                            permissionModeChanges and each change's fields
//   GET /sessions?runnerId&workspaceId&view=open   the Open list as the web reads it (lib/queries.ts fetchSessions)
// For each seeded session the fixture builders are given what the server recorded (cause, modes, time, and the app for an
// owner's pick) and must produce the server's answer exactly: the same keys in the same order, the same values, the same
// formats. Prints each difference and exits 1 when there is one; writes the real answers to $PMA_STACK_DIR/payloads/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { S, WT, call, readState } from './lib.mjs';

// PMA_FIXTURES names another builder module (modeChange, modeFacts) to hold to the same answers, such as an earlier revision's.
const { modeChange, modeFacts } = await import(process.env.PMA_FIXTURES || `${WT}/src/web/src/test/permissionModeFixtures.ts`);
const state = readState();
const { accessToken } = await call('POST', '/auth/login', undefined, { email: state.owner.email, password: state.owner.password });
const out = `${S}/payloads`;
mkdirSync(out, { recursive: true });
const differences = [];
const differ = (where, real, fixture) => differences.push({ where, real, fixture });
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const lists = {};
for (const r of Object.values(state.runners)) {
  const ws = state.workspaces[r.name];
  const path = `/sessions?runnerId=${r.publicId}&workspaceId=${ws.id}&view=open`;
  lists[r.name] = { path, body: await call('GET', path, accessToken) };
}
/** The rows of an Open list answer, whatever envelope the delta read wraps them in. */
const listRows = (body) => (Array.isArray(body) ? body : Object.values(body ?? {}).filter(Array.isArray).flat());

for (const s of Object.values(state.sessions)) {
  const detail = await call('GET', `/sessions/${s.id}`, accessToken);
  writeFileSync(`${out}/${s.key}.detail.json`, JSON.stringify(detail, null, 2) + '\n');
  const changes = detail.permissionModeChanges;
  if (!Array.isArray(changes)) { differ(`${s.key} detail.permissionModeChanges`, changes, 'an array'); continue; }
  // Each change, rebuilt by the fixture builder from what the server recorded.
  const rebuilt = changes.map((c) => modeChange(c.cause, c.toMode, c.fromMode, c.at, c.cause === 'OWNER_PICK' ? c.client : undefined));
  changes.forEach((c, i) => {
    if (!same(Object.keys(c), Object.keys(rebuilt[i]))) differ(`${s.key} change ${i} keys`, Object.keys(c), Object.keys(rebuilt[i]));
    if (!same(c, rebuilt[i])) differ(`${s.key} change ${i} (${c.cause})`, c, rebuilt[i]);
    if (!INSTANT.test(c.at)) differ(`${s.key} change ${i} at`, c.at, 'an ISO instant with milliseconds');
  });
  if (!same(changes.map((c) => c.at), [...changes.map((c) => c.at)].sort())) differ(`${s.key} order`, changes.map((c) => c.at), 'oldest first');
  // The session's own facts are its newest change's, as the fixtures make them. Its stamp is the same statement's own
  // clock_timestamp() (recordActualPermissionMode calls it for the session row, then for the change row), so it may read up
  // to a millisecond earlier than the change's; the fixtures use the change's instant, the other end of that range.
  const facts = pick(detail, ['actualPermissionMode', 'actualPermissionModeAt']);
  const expected = modeFacts(rebuilt);
  const lag = Date.parse(expected.actualPermissionModeAt) - Date.parse(facts.actualPermissionModeAt);
  if (facts.actualPermissionMode !== expected.actualPermissionMode || !(lag >= 0 && lag <= 1) || !INSTANT.test(facts.actualPermissionModeAt)) {
    differ(`${s.key} detail facts`, facts, expected);
  }
  // The Open list row the web reads carries the two facts, and no changes.
  const listed = listRows(lists[s.runnerName].body).find((row) => row?.id === s.id);
  if (!listed) { differ(`${s.key} Open list`, 'no row', 'a row'); continue; }
  if ('permissionModeChanges' in listed) differ(`${s.key} Open list row`, 'carries permissionModeChanges', 'only the two facts');
  const rowFacts = pick(listed, ['permissionMode', 'actualPermissionMode', 'actualPermissionModeAt']);
  const detailFacts = pick(detail, ['permissionMode', 'actualPermissionMode', 'actualPermissionModeAt']);
  if (!same(rowFacts, detailFacts)) differ(`${s.key} Open list facts`, rowFacts, detailFacts);
  console.log(`${s.key}: intent ${detail.permissionMode}, running ${detail.actualPermissionMode} at ${detail.actualPermissionModeAt}; ${changes.length} change(s) ` +
    `[${changes.map((c) => `${c.cause}${c.client ? `/${c.client}` : ''}`).join(', ')}]; Open list row ${JSON.stringify(rowFacts)}`);
}
for (const [name, l] of Object.entries(lists)) writeFileSync(`${out}/open-list.${name}.json`, JSON.stringify({ path: l.path, body: l.body }, null, 2) + '\n');

if (differences.length === 0) {
  console.log(`no differences: every mode field of ${Object.keys(state.sessions).length} details and their Open list rows is what the fixture builders make`);
} else {
  for (const d of differences) console.log(`DIFFERENCE ${d.where}\n  real:    ${JSON.stringify(d.real)}\n  fixture: ${JSON.stringify(d.fixture)}`);
  console.log(`${differences.length} difference(s)`);
  process.exit(1);
}

// Read the seven seeded sessions back through the real API: GET /api/sessions (each view the row could be in) and
// GET /api/sessions/:id, and keep the six three-state fields of each.
// usage: (. <walk>/env && node api-read.mjs <walk dir> <out.json>)
// Signs in with the real POST /api/auth/login; never prints the password or the token.
import fs from 'node:fs';
import path from 'node:path';

const [walk, out] = process.argv.slice(2);
if (!walk || !out) throw new Error('usage: api-read.mjs <walk dir> <out.json>');
const BASE = `http://127.0.0.1:${process.env.PORT}/api`;
const FIELDS = ['phase', 'released', 'lastTurnOutcome', 'waitingOn', 'endReason', 'workFinished'];
const seed = JSON.parse(fs.readFileSync(path.join(walk, 'seed.json'), 'utf8'));
const password = fs.readFileSync(path.join(walk, 'pw'), 'utf8').trim();

const login = await (await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: seed.ownerEmail, password }),
})).json();
const token = login.accessToken ?? login.access_token ?? login.token;
if (!token) throw new Error(`login answered no token; keys: ${Object.keys(login).join(',')}`);
const get = async (route) => {
  const res = await fetch(`${BASE}${route}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null };
};
const pick = (row) => (row ? Object.fromEntries(FIELDS.map((k) => [k, k in row ? row[k] : '<absent>'])) : null);

// The list: the Open view (the default), then the Completed view, since a released session may be listed there.
const views = {};
for (const view of [null, 'completed']) {
  const r = await get(`/sessions${view ? `?view=${view}` : ''}`);
  const rows = Array.isArray(r.body) ? r.body : (r.body?.sessions ?? r.body?.items ?? []);
  views[view ?? 'open'] = { status: r.status, rows };
}
const result = { at: new Date().toISOString(), cases: {} };
for (const [key, c] of Object.entries(seed.cases)) {
  const listed = {};
  for (const [view, v] of Object.entries(views)) {
    // The API answers public (encoded) ids, so a row is found by its unique title.
    const row = v.rows.find((s) => s.title === c.title);
    if (row) listed[view] = { status: v.status, id: row.id, fields: pick(row), legacy: { status: row.status, runState: row.runState ?? null, activity: row.activity ?? null, pendingApprovals: row.pendingApprovals ?? null } };
  }
  const detail = await get(`/sessions/${c.id}`);
  result.cases[key] = {
    id: c.id,
    publicId: detail.body?.id ?? null,
    title: c.title,
    list: listed,
    detail: { status: detail.status, fields: pick(detail.body), legacy: { status: detail.body?.status, runState: detail.body?.runState ?? null, activity: detail.body && 'activity' in detail.body ? detail.body.activity : '<absent>' } },
  };
}
fs.writeFileSync(out, JSON.stringify(result, null, 2));
for (const [key, c] of Object.entries(result.cases)) {
  const listView = Object.keys(c.list).join('+') || 'NOT LISTED';
  console.log(`${key.padEnd(14)} list(${listView}) ${JSON.stringify(Object.values(c.list)[0]?.fields ?? null)}`);
  console.log(`${''.padEnd(14)} detail(${c.detail.status}) ${JSON.stringify(c.detail.fields)}`);
}

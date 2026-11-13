// The lab's accounts against the server machine, as people use its API (adapted from /mnt/data/tmp/34sx/kit/lib.mjs and
// scenario.mjs). Two accounts: the first visitor (the administrator) and one the administrator creates. Each gets a model
// key on the fake model (not a model) at its public https address, its managed runner READY on the channel machine, and a
// session answered there. No token, password or secret is logged.
//
//   node scenario.mjs accounts <fake model https origin>   both accounts, keys, runners READY, a session answered on each
//   node scenario.mjs state                                what there is now
import { execFile as execFileCb } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const K = '/mnt/data/tmp/34w2jF';
const SERVER = 'mrrh-server';
const CHAN = 'mrrh-channel';
const ORIGIN = 'http://172.31.91.10:2086';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => {
  const text = `${new Date().toISOString()} ${line}`;
  appendFileSync(`${K}/logs/timeline.txt`, `${text}\n`);
  console.log(text);
};

async function on(machine, args) {
  const { stdout } = await execFile('docker', ['exec', machine, ...args], { timeout: 180_000, maxBuffer: 64 << 20 });
  return stdout;
}
async function sql(query) {
  return (await on(SERVER, ['docker', 'exec', 'orbit-postgres', 'psql', '-U', 'orbit', '-d', 'orbit', '-tAF', '\t', '-c', query])).trim();
}
async function call(token, method, route, body) {
  const res = await fetch(`${ORIGIN}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}
async function ok(token, method, route, body) {
  const res = await call(token, method, route, body);
  if (res.status < 200 || res.status >= 300) throw new Error(`${method} /api${route} answered ${res.status}: ${JSON.stringify(res.json)}`);
  return res.json;
}
function toUuid(id) {
  if (/^[0-9a-f-]{36}$/i.test(id)) return id.toLowerCase();
  let n = 0n;
  for (const ch of id) n = n * 62n + BigInt('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.indexOf(ch));
  const hex = n.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function waitFor(label, ms, fn, every = 5000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const got = await fn().catch((e) => { say(`${label}: ${e.message.slice(0, 200)}`); return null; });
    if (got) { say(`${label}: after ${((Date.now() - started) / 1000).toFixed(0)} s`); return got; }
    await sleep(every);
  }
  throw new Error(`${label}: not within ${ms / 1000} s`);
}

const stateFile = `${K}/state.json`;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });

async function signInAdmin() {
  state.admin ??= { email: 'owner@mrrh.test', password: randomUUID() };
  save();
  let made = await call(null, 'POST', '/auth/login', { email: state.admin.email, password: state.admin.password });
  if (made.status !== 200 && made.status !== 201) {
    made = { json: await ok(null, 'POST', '/auth/bootstrap', { email: state.admin.email, name: 'Lab owner', password: state.admin.password }) };
    say('the first visitor created the administrator');
  }
  return made.json.accessToken;
}
async function signInSecond(adminToken) {
  state.second ??= { email: 'second@mrrh.test', password: randomUUID() };
  save();
  let made = await call(null, 'POST', '/auth/login', { email: state.second.email, password: state.second.password });
  if (made.status !== 200 && made.status !== 201) {
    await ok(adminToken, 'POST', '/admin/users', { email: state.second.email, name: 'Lab second account', password: state.second.password });
    say('the administrator created the second account');
    made = await call(null, 'POST', '/auth/login', { email: state.second.email, password: state.second.password });
  }
  return made.json.accessToken;
}
async function mapping(token) {
  const { status, json } = await call(token, 'GET', '/managed-runner');
  if (status !== 200) return { status };
  return {
    state: json.managementState, desired: json.desiredState, usable: json.usable, reason: json.reason?.code ?? null,
    lastHeartbeatAt: json.lastHeartbeatAt, runnerId: json.runnerId, workspaceId: json.workspaceId, initialProvider: json.initialProvider ?? null,
  };
}
async function containers() {
  const out = (await on(CHAN, ['sh', '-c', 'docker ps -a --filter label=orbit.managed-runner.kind=runner --format '
    + '\'{{.Names}} {{.Label "orbit.managed-runner.instance"}} gen={{.Label "orbit.managed-runner.generation"}} {{.Image}} {{.Status}}\''])).trim();
  return out ? out.split('\n') : [];
}
async function answered(sessionUuid) {
  return Number(await sql(`SELECT count(*) FROM conversation_turn WHERE session_id = '${sessionUuid}' AND kind = 'message' AND status = 'ANSWERED'`));
}

const [cmd, fakeOrigin] = process.argv.slice(2);
const adminToken = await signInAdmin();
const accounts = [['first', adminToken], ['second', await signInSecond(adminToken)]];

if (cmd === 'accounts') {
  if (!fakeOrigin?.startsWith('https://')) throw new Error('give the fake model\'s https origin');
  for (const [who, token] of accounts) {
    const keys = await ok(token, 'GET', '/providers/mine');
    let key = (Array.isArray(keys) ? keys : keys.items ?? []).find((k) => k.label?.startsWith('FAKE model'));
    if (!key) {
      key = await ok(token, 'POST', '/providers/mine', {
        label: `FAKE model in the lab (not a model), ${who}`, presetSlug: 'deepseek',
        baseUrl: `${fakeOrigin}/anthropic`, apiKey: `sk-mrrh-fake-${who}-not-a-key`,
      });
      say(`${who}: a model key on the fake model at ${fakeOrigin}: ${key.slug}`);
    }
    const now = await mapping(token);
    if (!now.state || now.state === 'NOT_PROVISIONED') {
      say(`${who}: managed runner ${JSON.stringify(now)}; ensuring it`);
      await ok(token, 'POST', '/managed-runner/ensure', { idempotencyKey: `ensure-${who}-${Date.now()}` });
    }
  }
  for (const [who, token] of accounts) {
    const ready = await waitFor(`${who}: managed runner READY and usable`, 1_800_000, async () => {
      const m = await mapping(token);
      return m.state === 'READY' && m.usable ? m : null;
    });
    state[`${who}Runner`] = { ...ready, runnerUuid: toUuid(ready.runnerId) };
    save();
    say(`${who}: READY ${JSON.stringify(ready)}`);
  }
  say(`runner containers on the channel machine: ${JSON.stringify(await containers())}`);
  for (const [who, token] of accounts) {
    const r = state[`${who}Runner`];
    const provider = r.initialProvider ?? (await ok(token, 'GET', '/providers/mine')).find?.((k) => k.label?.startsWith('FAKE'))?.slug;
    let made;
    for (let i = 0; i < 40; i += 1) {
      made = await call(token, 'POST', '/sessions', { workspaceId: r.workspaceId, provider, prompt: `MRRH-${who.toUpperCase()}: a first message, answered on the channel host.` });
      if (made.status >= 200 && made.status < 300) break;
      say(`${who}: POST /sessions ${made.status} ${JSON.stringify(made.json).slice(0, 200)}`);
      await sleep(5000);
    }
    state[`${who}Session`] = { id: made.json.id, uuid: toUuid(made.json.id) };
    save();
    await waitFor(`${who}: session ${made.json.id} answered`, 600_000, async () => (await answered(state[`${who}Session`].uuid)) >= 1);
  }
}

// What there is now: both mappings, both sessions' turns, the runner rows, the containers.
for (const [who, token] of accounts) {
  const m = await mapping(token);
  const s = state[`${who}Session`];
  const turns = s ? await sql(`SELECT seq, kind, status FROM conversation_turn WHERE session_id = '${s.uuid}' ORDER BY seq`) : '';
  const runner = m.runnerId ? await sql(`SELECT r.name, r.status, m.cluster_key, m.namespace, m.management_state, m.generation FROM runner r JOIN managed_runner m ON m.runner_id = r.id WHERE r.id = '${toUuid(m.runnerId)}'`) : '';
  say(`${who}: mapping ${JSON.stringify(m)}`);
  say(`${who}: runner row ${JSON.stringify(runner)}`);
  if (s) say(`${who}: session ${s.id} turns ${JSON.stringify(turns.split('\n'))}`);
}
say(`containers: ${JSON.stringify(await containers())}`);

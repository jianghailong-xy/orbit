// The multi-host lab's accounts against the server machine, as people use its API (adapted from the two-host lab's
// scenario.mjs, task 34w2jF2t5FFJzkQ15RMyF). Accounts are named; `first` is the first visitor (the administrator), every
// other one an account the administrator creates. Each gets a model key on the fake model (not a model) at its public
// https address. No token, password or secret is logged.
//
//   node scenario.mjs new <name>...       accounts made, each one's managed runner ensured (placed); no wait
//   node scenario.mjs ready <name>...     wait until each one's runner is READY and usable
//   node scenario.mjs session <name>...   a new session on each one's runner, waited until answered (timed)
//   node scenario.mjs sleep <name>        ask the runner to sleep, wait until it is ASLEEP
//   node scenario.mjs wake <name>         wake it, wait until READY
//   node scenario.mjs state [label]       every mapping (placement, state, generation) and both hosts' containers
import { execFile as execFileCb } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const K = '/mnt/data/tmp/34w2jFb';
const SERVER = 'mrmh-server';
const HOSTS = [['A', 'mrmh-chan-a'], ['B', 'mrmh-chan-b']];
const ORIGIN = 'http://172.31.92.10:2086';
const FAKE = Object.fromEntries(readFileSync(`${K}/tunnels.env`, 'utf8').trim().split('\n').map((l) => l.split('='))).FAKE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => {
  const text = `${new Date().toISOString()} ${line}`;
  appendFileSync(`${K}/logs/timeline.txt`, `${text}\n`);
  console.log(text);
};

async function on(machine, args, timeout = 180_000) {
  const { stdout } = await execFile('docker', ['exec', machine, ...args], { timeout, maxBuffer: 64 << 20 });
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
    signal: AbortSignal.timeout(120_000),
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
async function waitFor(label, ms, fn, every = 3000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const got = await fn().catch((e) => { say(`${label}: ${e.message.slice(0, 200)}`); return null; });
    if (got) { say(`${label}: after ${((Date.now() - started) / 1000).toFixed(1)} s`); return got; }
    await sleep(every);
  }
  throw new Error(`${label}: not within ${ms / 1000} s`);
}

const stateFile = `${K}/state.json`;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
state.accounts ??= {};

async function signIn(name) {
  const a = (state.accounts[name] ??= { email: `${name}@mrmh.test`, password: randomUUID() });
  save();
  let made = await call(null, 'POST', '/auth/login', { email: a.email, password: a.password });
  if (made.status === 200 || made.status === 201) return made.json.accessToken;
  if (name === 'first') {
    made = { json: await ok(null, 'POST', '/auth/bootstrap', { email: a.email, name: 'Lab owner', password: a.password }) };
    say('first: the first visitor created the administrator');
    return made.json.accessToken;
  }
  await ok(await signIn('first'), 'POST', '/admin/users', { email: a.email, name: `Lab account ${name}`, password: a.password });
  say(`${name}: the administrator created the account`);
  made = await call(null, 'POST', '/auth/login', { email: a.email, password: a.password });
  return made.json.accessToken;
}
async function mapping(token) {
  const { status, json } = await call(token, 'GET', '/managed-runner');
  if (status !== 200) return { status };
  return {
    state: json.managementState, desired: json.desiredState, usable: json.usable, reason: json.reason?.code ?? null,
    revision: json.revision, runnerId: json.runnerId, workspaceId: json.workspaceId, initialProvider: json.initialProvider ?? null,
  };
}
async function placement(name) {
  return sql(`SELECT m.namespace, m.management_state, m.generation FROM managed_runner m JOIN "user" u ON u.id = m.owner_id WHERE u.email = '${name}@mrmh.test'`);
}
async function containers(machine) {
  const out = (await on(machine, ['sh', '-c', 'docker ps -a --filter label=orbit.managed-runner.kind=runner --format '
    + '\'{{.Names}} gen={{.Label "orbit.managed-runner.generation"}} image={{.Image}} {{.Status}}\''], 30_000).catch((e) => `unreadable: ${e.message.slice(0, 100)}`)).trim();
  return out ? out.split('\n') : [];
}
async function answered(sessionUuid) {
  return Number(await sql(`SELECT count(*) FROM conversation_turn WHERE session_id = '${sessionUuid}' AND kind = 'message' AND status = 'ANSWERED'`));
}

const [cmd, ...names] = process.argv.slice(2);

if (cmd === 'new') {
  for (const name of names) {
    const token = await signIn(name);
    const keys = await ok(token, 'GET', '/providers/mine');
    let key = (Array.isArray(keys) ? keys : keys.items ?? []).find((k) => k.label?.startsWith('FAKE model'));
    if (!key) {
      key = await ok(token, 'POST', '/providers/mine', {
        label: `FAKE model in the lab (not a model), ${name}`, presetSlug: 'deepseek',
        baseUrl: `${FAKE}/anthropic`, apiKey: `sk-mrmh-fake-${name}-not-a-key`,
      });
      say(`${name}: a model key on the fake model: ${key.slug}`);
    }
    const now = await mapping(token);
    if (!now.state || now.state === 'NOT_PROVISIONED') {
      const t0 = Date.now();
      const res = await call(token, 'POST', '/managed-runner/ensure', { idempotencyKey: `ensure-${name}-${Date.now()}` });
      say(`${name}: ensure answered ${res.status} in ${Date.now() - t0} ms: ${JSON.stringify({ state: res.json?.managementState, reason: res.json?.reason?.code ?? null })}`);
    }
    say(`${name}: placed (namespace, state, generation) = ${JSON.stringify(await placement(name))}`);
  }
}

if (cmd === 'ready') {
  for (const name of names) {
    const token = await signIn(name);
    const ready = await waitFor(`${name}: managed runner READY and usable`, 1_800_000, async () => {
      const m = await mapping(token);
      return m.state === 'READY' && m.usable ? m : null;
    });
    state.accounts[name].runner = { runnerId: ready.runnerId, workspaceId: ready.workspaceId, initialProvider: ready.initialProvider };
    save();
    say(`${name}: READY on ${JSON.stringify(await placement(name))}`);
  }
}

if (cmd === 'session') {
  for (const name of names) {
    const token = await signIn(name);
    const m = await mapping(token);
    const provider = m.initialProvider ?? (await ok(token, 'GET', '/providers/mine')).find?.((k) => k.label?.startsWith('FAKE'))?.slug;
    const t0 = Date.now();
    let made;
    for (let i = 0; i < 40; i += 1) {
      made = await call(token, 'POST', '/sessions', { workspaceId: m.workspaceId, provider, prompt: `MRMH-${name.toUpperCase()}: a message at ${new Date().toISOString()}.` });
      if (made.status >= 200 && made.status < 300) break;
      say(`${name}: POST /sessions ${made.status} ${JSON.stringify(made.json).slice(0, 200)}`);
      await sleep(5000);
    }
    const uuid = toUuid(made.json.id);
    (state.accounts[name].sessions ??= []).push(made.json.id);
    save();
    await waitFor(`${name}: session ${made.json.id} answered (from POST /sessions)`, 600_000, async () => (await answered(uuid)) >= 1, 1000);
    say(`${name}: session ${made.json.id} answered ${((Date.now() - t0) / 1000).toFixed(1)} s after POST /sessions, runner on ${JSON.stringify(await placement(name))}`);
  }
}

if (cmd === 'sleep' || cmd === 'wake') {
  const [name] = names;
  const token = await signIn(name);
  const m = await mapping(token);
  const res = await call(token, 'POST', `/managed-runner/${cmd}`, { idempotencyKey: `${cmd}-${name}-${Date.now()}`, revision: m.revision });
  say(`${name}: ${cmd} answered ${res.status}: ${JSON.stringify({ state: res.json?.managementState, desired: res.json?.desiredState, reason: res.json?.reason?.code ?? null })}`);
  const want = cmd === 'sleep' ? (x) => x.state === 'ASLEEP' || x.state === 'SLEEPING' : (x) => x.state === 'READY' && x.usable;
  await waitFor(`${name}: ${cmd === 'sleep' ? 'asleep' : 'READY again'}`, 1_200_000, async () => {
    const x = await mapping(token);
    return want(x) ? x : null;
  });
  say(`${name}: now ${JSON.stringify(await placement(name))}`);
}

if (cmd === 'state') {
  say(`=== state${names.length ? `: ${names.join(' ')}` : ''}`);
  const rows = await sql(`SELECT u.email, m.namespace, m.management_state, m.desired_state, m.generation, r.status, coalesce(p.link_state, '-'), coalesce(m.last_error->>'code', '-'), m.pod_name
    FROM managed_runner m JOIN "user" u ON u.id = m.owner_id JOIN runner r ON r.id = m.runner_id LEFT JOIN runner_presence p ON p.runner_id = r.id ORDER BY m.created_at`);
  say('mappings (account, host instance, management_state, desired, generation, runner status, link, failure, container):');
  for (const row of rows.split('\n')) say(`  ${row.replaceAll('\t', ' | ')}`);
  for (const [label, machine] of HOSTS) {
    say(`host ${label} (${machine}) runner containers:`);
    for (const c of await containers(machine)) say(`  ${c}`);
  }
}

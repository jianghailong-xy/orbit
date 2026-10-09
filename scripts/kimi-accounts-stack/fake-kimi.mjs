#!/usr/local/bin/node
// A stand-in for Kimi Code 2.1.x's `kimi`, for the local Kimi-accounts stack. It never reaches the
// network except the stack's own fake Kimi server (FAKE_KIMI_SERVER, 127.0.0.1 only), never calls a
// model, and keeps everything it writes in the KIMI_CODE_HOME it runs in, the way the real CLI does:
//
//   kimi --version                     2.1.1
//   kimi login [--region R]            RFC 8628 device login on R's site (default: the home's region
//                                      marker, else mainland-cn): device_id first, the device code on
//                                      stderr, then — once the stack approves the code on the fake
//                                      server — config.toml (managed:kimi-code) + credentials/<key>.json
//   kimi login --help                  mentions --region
//   kimi provider list --json          config.providers + models, raw (an empty home: {"providers": {}})
//   kimi acp                           ACP over stdio: initialize, authenticate, session/new,
//                                      session/resume, session/set_config_option, session/prompt,
//                                      session/cancel — the session store as Kimi 2.1.x writes it
//                                      (sessions/<wd_slug_hash12>/<id>/state.json, agents/main/wire.jsonl,
//                                      session_index.jsonl, workspaces.json, sessions/.index-dirty)
//
// Its reply to a prompt says which account answered (the home its sessions/ link leads to) and every
// earlier turn of the conversation it found in that home — what shows a conversation carried to
// another account, or not.
//
// Every invocation is appended to $FAKE_KIMI_LOG (JSON lines): argv, the KIMI_CODE_HOME it ran in and
// where that home's sessions/ leads. Nothing secret is logged — the fake has no secrets, and still
// never logs `provider list` output or token files.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '2.1.1';
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const SERVER = process.env.FAKE_KIMI_SERVER || 'http://127.0.0.1:18741';
const PORT = new URL(SERVER).port || '18741';
const HOME = resolve(process.env.KIMI_CODE_HOME?.trim() || join(process.env.HOME || homedir(), '.kimi-code'));
// Both sites' logins bring the same model aliases — the four a real kimi.com login on this host lists (2026-10-08).
const MODELS = {
  'kimi-code/kimi-for-coding': { model: 'kimi-for-coding', displayName: 'K2.8 Preview', maxContextSize: 1048576, supportEfforts: ['low', 'high', 'max'], defaultEffort: 'max' },
  'kimi-code/kimi-for-coding-highspeed': { model: 'kimi-for-coding-highspeed', displayName: 'K2.7 Code Highspeed', maxContextSize: 262144 },
  'kimi-code/k3': { model: 'k3', displayName: 'K3', maxContextSize: 1048576, supportEfforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  'kimi-code/k3-256k': { model: 'k3-256k', displayName: 'K3-256k', maxContextSize: 262144, supportEfforts: ['low', 'high', 'max'], defaultEffort: 'high' },
};
const SITES = {
  'mainland-cn': {
    label: 'kimi.com', www: 'https://www.kimi.com', oauthHost: `http://auth.kimi.com:${PORT}`,
    baseUrl: `http://api.kimi.com:${PORT}/coding/v1`, model: 'kimi-code/kimi-for-coding', models: MODELS,
  },
  global: {
    label: 'kimi.ai', www: 'https://www.kimi.ai', oauthHost: `http://auth.kimi.ai:${PORT}`,
    baseUrl: `http://api.kimi.ai:${PORT}/coding/v1`, model: 'kimi-code/kimi-for-coding', models: MODELS,
  },
};

function linkTarget(path) {
  try { return readlinkSync(path); } catch { return null; }
}
function log(event, extra = {}) {
  const file = process.env.FAKE_KIMI_LOG;
  if (!file) return;
  const line = {
    at: new Date().toISOString(), pid: process.pid, event, argv: process.argv.slice(2), kimiCodeHome: HOME,
    sessionsLink: linkTarget(join(HOME, 'sessions')), orbitSession: process.env.ORBIT_SESSION_ID || undefined, ...extra,
  };
  try { appendFileSync(file, JSON.stringify(line) + '\n'); } catch {}
}

// ── config.toml: the subset Kimi Code writes (tables, one-line strings, numbers, booleans) ───────────
function parseToml(text) {
  const out = {};
  let table = out;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      table = out;
      for (const part of splitKey(line.replace(/^\[+|\]+$/g, ''))) table = table[part] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const keys = splitKey(line.slice(0, eq));
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'")) value = value.slice(1, value.lastIndexOf("'"));
    else if (value === 'true' || value === 'false') value = value === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    else if (value.startsWith('[')) { try { value = JSON.parse(value); } catch { continue; } }
    let t = table;
    for (const k of keys.slice(0, -1)) t = t[k] ??= {};
    t[keys[keys.length - 1]] = value;
  }
  return out;
}
function splitKey(s) {
  const parts = [];
  for (const m of s.matchAll(/\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(?:\.|$)/g)) {
    const p = m[1];
    parts.push(p.startsWith('"') ? JSON.parse(p) : p.startsWith("'") ? p.slice(1, -1) : p);
  }
  return parts;
}
const q = (s) => JSON.stringify(s);
function readConfig() {
  try { return parseToml(readFileSync(join(HOME, 'config.toml'), 'utf8')); } catch { return null; }
}
// What the real CLI writes into a home it is first asked about: an empty template and a device id.
function ensureHome() {
  mkdirSync(HOME, { recursive: true, mode: 0o755 });
  if (!existsSync(join(HOME, 'device_id'))) writeFileSync(join(HOME, 'device_id'), randomUUID().replace(/-/g, '') + '\n', { mode: 0o600 });
  if (!existsSync(join(HOME, 'config.toml'))) {
    writeFileSync(join(HOME, 'config.toml'), '# Kimi Code configuration\ndefault_model = ""\ndefault_thinking = false\n\n[providers]\n\n[models]\n\n[loop_control]\nmax_steps_per_turn = 100\nmax_retries_per_step = 3\n', { mode: 0o600 });
  }
}
// The name a login's token is stored under, as the CLI derives it (and runner-go kimiTokenStorageName).
function storageName(oauthHost, baseUrl) {
  if (oauthHost === 'https://auth.kimi.com' && baseUrl === 'https://api.kimi.com/coding/v1') return 'kimi-code';
  return 'kimi-code-env-' + createHash('sha256').update(JSON.stringify({ oauthHost, baseUrl })).digest('hex').slice(0, 16);
}
function managedLogin() {
  const managed = readConfig()?.providers?.['managed:kimi-code'];
  if (!managed?.oauth?.key) return null;
  const storage = String(managed.oauth.key).replace(/^oauth\//, '');
  let token = null;
  try { token = JSON.parse(readFileSync(join(HOME, 'credentials', storage + '.json'), 'utf8')); } catch {}
  return { managed, storage, token };
}
function siteOf(managed) {
  const host = (() => { try { return new URL(managed?.oauth?.oauth_host || managed?.base_url).hostname; } catch { return ''; } })();
  return host.endsWith('kimi.ai') ? 'global' : 'mainland-cn';
}

// ── kimi login ──────────────────────────────────────────────────────────────────────────────────────
async function post(path, form) {
  const res = await fetch(SERVER + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fake-kimi-home': HOME },
    body: new URLSearchParams(form).toString(),
  });
  let body = {};
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: kimi login [options]\n\nSign in to Kimi Code with your Kimi account.\n\nOptions:\n  --region <region>  Login region: "mainland-cn" (kimi.com) or "global" (kimi.ai).\n  -h, --help         display help for command\n');
    return 0;
  }
  let region = null;
  const i = args.indexOf('--region');
  if (i >= 0) region = args[i + 1];
  if (!region) {
    const managed = readConfig()?.providers?.['managed:kimi-code'];
    if (managed) region = siteOf(managed);
    else { try { region = readFileSync(join(HOME, 'region'), 'utf8').trim(); } catch {} }
  }
  region ||= 'mainland-cn';
  const site = SITES[region];
  if (!site) { process.stderr.write(`error: unknown region ${q(region)}\n`); return 2; }
  mkdirSync(HOME, { recursive: true, mode: 0o755 });
  if (!existsSync(join(HOME, 'device_id'))) writeFileSync(join(HOME, 'device_id'), randomUUID().replace(/-/g, '') + '\n', { mode: 0o600 });
  const deviceId = readFileSync(join(HOME, 'device_id'), 'utf8').trim();
  const auth = await post('/api/oauth/device_authorization', { client_id: CLIENT_ID, region, device_id: deviceId });
  if (auth.status !== 200) { process.stderr.write(`error: device authorization failed (${auth.status})\n`); return 1; }
  const { device_code: deviceCode, user_code: userCode, expires_in: expiresIn = 1800, interval = 1 } = auth.body;
  const url = `${site.www}/code/authorize_device?user_code=${userCode}`;
  log('login.device_code', { region, userCode });
  process.stderr.write(`\nOpening browser for Kimi device login: ${url}\nIf the browser did not open, paste the URL above and enter code: ${userCode}\nCode expires in ${expiresIn}s.\n`);
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const tok = await post('/api/oauth/token', { client_id: CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
    if (tok.status === 200 && tok.body.access_token) {
      writeLogin(site, tok.body);
      log('login.done', { region, user: tok.body.fake_user });
      process.stdout.write(`✓ Logged in to Kimi Code on ${site.label}.\n`);
      return 0;
    }
    const err = tok.body?.error;
    if (err === 'authorization_pending' || err === 'slow_down') continue;
    log('login.failed', { region, error: err });
    process.stderr.write(`error: device login ${err || 'failed'}\n`);
    return 1;
  }
  process.stderr.write('error: the device code expired\n');
  return 1;
}

function writeLogin(site, token) {
  const storage = storageName(site.oauthHost, site.baseUrl);
  mkdirSync(join(HOME, 'credentials'), { recursive: true, mode: 0o700 });
  const now = Math.floor(Date.now() / 1000);
  const stored = {
    access_token: token.access_token, refresh_token: token.refresh_token, expires_at: now + Number(token.expires_in),
    scope: token.scope || 'kimi-code', token_type: token.token_type || 'Bearer', expires_in: Number(token.expires_in),
  };
  const credPath = join(HOME, 'credentials', storage + '.json');
  writeFileSync(credPath + '.tmp', JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
  renameSync(credPath + '.tmp', credPath);
  const models = Object.entries(site.models).map(([alias, m]) => [
    `[models.${q(alias)}]`, `provider = "managed:kimi-code"`, `model = ${q(m.model)}`, `max_context_size = ${m.maxContextSize}`,
    `display_name = ${q(m.displayName)}`, ...(m.supportEfforts ? [`support_efforts = ${JSON.stringify(m.supportEfforts)}`, `default_effort = ${q(m.defaultEffort)}`] : []), '',
  ].join('\n')).join('\n');
  const config = [
    '# Kimi Code configuration', `default_model = ${q(site.model)}`, 'default_thinking = true', '',
    '[providers."managed:kimi-code"]', 'type = "kimi"', `base_url = ${q(site.baseUrl)}`, 'api_key = ""', '',
    '[providers."managed:kimi-code".oauth]', 'storage = "file"', `key = ${q('oauth/' + storage)}`, `oauth_host = ${q(site.oauthHost)}`, '',
    models,
    '[loop_control]', 'max_steps_per_turn = 100', 'max_retries_per_step = 3', '',
  ].join('\n');
  writeFileSync(join(HOME, 'config.toml'), config, { mode: 0o600 });
}

// ── kimi provider list --json ─────────────────────────────────────────────────────────────────────────
function providerList() {
  ensureHome();
  const config = readConfig() || {};
  const providers = {};
  for (const [name, p] of Object.entries(config.providers || {})) {
    providers[name] = {
      type: p.type, baseUrl: p.base_url, apiKey: p.api_key ?? '',
      ...(p.oauth ? { oauth: { storage: p.oauth.storage, key: p.oauth.key, ...(p.oauth.oauth_host ? { oauthHost: p.oauth.oauth_host } : {}) } } : {}),
    };
  }
  const models = {};
  for (const [alias, m] of Object.entries(config.models || {})) {
    if (!m || typeof m !== 'object' || !m.provider) continue;
    models[alias] = {
      provider: m.provider, model: m.model, maxContextSize: m.max_context_size, displayName: m.display_name,
      ...(m.support_efforts ? { supportEfforts: m.support_efforts, defaultEffort: m.default_effort } : {}),
    };
  }
  log('provider.list', { providers: Object.keys(providers) });
  process.stdout.write(JSON.stringify({ providers, models }, null, 2) + '\n');
  return 0;
}

// ── kimi acp ─────────────────────────────────────────────────────────────────────────────────────────
// Kimi's encodeWorkDirKey: "wd_" + the directory's name slugged + "_" + 12 hex of its path's sha-256.
function workDirKey(workDir) {
  const normalized = workDir.replaceAll('\\', '/').replace(/\/+$/, '');
  let slug = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 40) slug = slug.slice(0, 40).replace(/^-+|-+$/g, '');
  if (!slug || slug === '.' || slug === '..') slug = 'workspace';
  return 'wd_' + slug + '_' + createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}
function sessionDirOf(id) {
  const root = join(HOME, 'sessions');
  let buckets = [];
  try { buckets = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const b of buckets) {
    if (!b.isDirectory() || b.name.startsWith('.')) continue;
    const dir = join(root, b.name, id);
    if (existsSync(join(dir, 'state.json'))) return dir;
  }
  return null;
}
function writeJSON(path, value) {
  writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
function appendWire(dir, records) {
  appendFileSync(join(dir, 'agents', 'main', 'wire.jsonl'), records.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
}
// What the user said, without the instructions Orbit puts in front of every prompt (kimiPromptText).
const userText = (s) => s.replace(/<orbit-agent-instructions>[\s\S]*?<\/orbit-agent-instructions>\s*/g, '').trim();
function readTurns(dir) {
  const turns = [];
  let text = '';
  try { text = readFileSync(join(dir, 'agents', 'main', 'wire.jsonl'), 'utf8'); } catch { return turns; }
  for (const line of text.split('\n')) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'turn.prompt' && rec.agentId === 'main') turns.push({ said: userText((rec.input || []).map((p) => p.text || '').join('')), turnId: rec.turnId });
  }
  return turns;
}
function markDirty(id) {
  const dir = join(HOME, 'sessions', '.index-dirty');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  closeSync(openSync(join(dir, `${id}.${Date.now()}`), 'w', 0o600));
}
function touchWorkspace(bucket, cwd) {
  const path = join(HOME, 'workspaces.json');
  let catalog = { version: 1, workspaces: {}, deleted_workspace_ids: [] };
  try { catalog = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  const now = new Date().toISOString();
  catalog.workspaces ??= {};
  catalog.workspaces[bucket] = { root: cwd, name: basename(cwd), created_at: catalog.workspaces[bucket]?.created_at || now, last_opened_at: now };
  catalog.deleted_workspace_ids = (catalog.deleted_workspace_ids || []).filter((x) => x !== bucket);
  writeFileSync(path, JSON.stringify(catalog));
}
// Which account a home is: the directory its sessions/ leads to (the runner's overlay links it), named
// the way the runner names accounts — "default" for a ~/.kimi-code, else the slot id under kimi-accounts/.
function accountOfHome() {
  const target = linkTarget(join(HOME, 'sessions'));
  const real = target ? dirname(resolve(HOME, target)) : HOME;
  const slot = basename(dirname(real)) === 'kimi-accounts' ? basename(real) : 'default';
  return { real, slot };
}
const CONFIG_OPTIONS = (thinking) => [
  { id: 'model', name: 'Model', type: 'select', currentValue: readConfig()?.default_model || '', options: Object.keys(readConfig()?.models || {}).map((v) => ({ value: v, name: v })) },
  { id: 'thinking', name: 'Thinking', type: 'select', currentValue: thinking, options: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'On' }] },
  { id: 'mode', name: 'Mode', type: 'select', currentValue: 'default', options: ['default', 'plan', 'auto', 'yolo'].map((v) => ({ value: v, name: v })) },
];

async function accountSpent() {
  const login = managedLogin();
  if (!login?.token?.access_token) return false;
  try {
    const res = await fetch(`${SERVER}/coding/v1/usages`, { headers: { authorization: `Bearer ${login.token.access_token}` } });
    if (!res.ok) return false;
    const { usages = {} } = await res.json();
    return Object.values(usages).some((w) => Number(w?.used_ratio) >= 1);
  } catch { return false; }
}

function acp() {
  const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const reply = (id, result) => out({ id, result });
  const fail = (id, code, message, data) => out({ id, error: { code, message, ...(data ? { data } : {}) } });
  const notify = (sessionId, update) => out({ method: 'session/update', params: { sessionId, update } });
  const sessions = new Map(); // id -> { dir, cwd, thinking, active }
  const { real, slot } = accountOfHome();
  log('acp.start', { account: slot, accountHome: real });

  async function prompt(id, params) {
    const s = sessions.get(params.sessionId);
    if (!s) return fail(id, -32602, 'Invalid params', { details: `unknown session ${params.sessionId}` });
    const said = (params.prompt || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const earlier = readTurns(s.dir);
    const turnId = earlier.length;
    const at = Date.now();
    const promptId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();
    const user = [{ type: 'text', text: said }];
    appendWire(s.dir, [
      { type: 'turn.prompt', agentId: 'main', input: user, origin: { kind: 'user' }, promptId, turnId, time: at },
      { type: 'context.append_message', agentId: 'main', message: { role: 'user', content: user, id: promptId, toolCalls: [], origin: { kind: 'user' } }, time: at + 1 },
      { turnId, queueItemId: promptId, type: 'agent.turn.started', time: at + 2, kind: 'event' },
    ]);
    s.active = { id, cancelled: false };
    const slow = /FAKE_KIMI_SLOW (\d+)/.exec(said);
    if (slow) {
      notify(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `(working for ${slow[1]}s…)\n` } });
      const end = Date.now() + Number(slow[1]) * 1000;
      while (Date.now() < end && !s.active.cancelled) await sleep(200);
    }
    // A spent account's turn ends the way Kimi ends one its provider refused with a 429: failed, with
    // APIProviderQuotaExhaustedError in the wire, and the prompt answered end_turn. Spent = the fake server says a
    // window of this login's quota is used up (asked with the login's own token, as Kimi's API would be).
    const quota = said.includes('FAKE_KIMI_QUOTA_EXHAUSTED') || await accountSpent();
    const history = earlier.map((t, n) => `  ${n + 1}. ${t.said}`).join('\n') || '  (none — this is the first turn here)';
    const text = quota ? '' : [
      `[fake kimi ${VERSION}] account ${slot} — KIMI_CODE_HOME ${HOME} → sessions in ${real}`,
      `session ${params.sessionId}, turn ${turnId + 1}. You said: ${userText(said)}`,
      `Earlier turns of this conversation I can read in this account:`, history,
    ].join('\n');
    if (text && !s.active.cancelled) {
      for (const chunk of text.match(/[\s\S]{1,120}/g)) notify(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
    }
    notify(params.sessionId, { sessionUpdate: 'usage_update', used: 1200 * (turnId + 1), size: 262144 });
    const endAt = Date.now();
    const reason = s.active.cancelled ? 'cancelled' : quota ? 'failed' : 'completed';
    appendWire(s.dir, [
      ...(text ? [{ type: 'context.append_loop_event', agentId: 'main', event: { type: 'content.part', turnId: String(turnId), step: 1, part: { type: 'text', text } }, time: endAt }] : []),
      { type: 'turn.ended', agentId: 'main', turnId, reason, durationMs: endAt - at,
        ...(quota ? { error: { code: 'provider.api_error', message: '429 You exceeded your current token quota (fake)', name: 'APIProviderQuotaExhaustedError', details: { statusCode: 429 }, retryable: false } } : {}), time: endAt + 1 },
      { type: 'prompt.completed', agentId: 'main', promptId, finishedAt: new Date(endAt + 2).toISOString(), reason, time: endAt + 2 },
    ]);
    const statePath = join(s.dir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    Object.assign(state, { updatedAt: endAt + 2, lastPrompt: said, lastTurnReason: reason });
    if (state.title === 'New Session') state.title = said.slice(0, 60);
    writeJSON(statePath, state);
    markDirty(params.sessionId);
    log('acp.prompt', { sessionId: params.sessionId, turn: turnId + 1, earlierTurns: earlier.length, reason, account: slot, accountHome: real, sessionDir: s.dir });
    const cancelled = s.active.cancelled;
    s.active = null;
    reply(id, { stopReason: cancelled ? 'cancelled' : 'end_turn' });
  }

  function open(id, params, resume) {
    const cwd = params.cwd || process.cwd();
    let sid = params.sessionId;
    let dir;
    if (resume) {
      dir = sessionDirOf(sid);
      if (!dir) {
        log('acp.resume.missing', { sessionId: sid, account: slot, accountHome: real });
        return fail(id, -32603, 'Internal error', { details: `Session ${sid} not found` });
      }
    } else {
      sid = 'session_' + randomUUID();
      const bucket = workDirKey(cwd);
      dir = join(HOME, 'sessions', bucket, sid);
      for (const sub of ['agents/main', 'notify', 'logs']) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
      const created = Date.now();
      appendWire(dir, [
        { type: 'metadata', protocol_version: '1.5', created_at: created },
        { type: 'runtime.set_binding', workspaceId: bucket, runtimeId: 'acp:' + sid, agentId: 'main', time: created + 7 },
      ]);
      writeFileSync(join(dir, 'notify', 'state.json'), '{"enabled":false}', { mode: 0o600 });
      writeJSON(join(dir, 'state.json'), {
        id: sid, version: 2, cwd, createdAt: created, updatedAt: created, archived: false,
        agents: { main: { homedir: join(dir, 'agents', 'main'), type: 'main' } },
        custom: {}, title: 'New Session', titleKind: 'replaceable', isCustomTitle: false,
      });
      appendFileSync(join(HOME, 'session_index.jsonl'), JSON.stringify({ sessionId: sid, sessionDir: dir, workDir: cwd }) + '\n', { mode: 0o600 });
      touchWorkspace(bucket, cwd);
      markDirty(sid);
    }
    sessions.set(sid, { dir, cwd, thinking: 'on', active: null });
    const turns = readTurns(dir).length;
    log(resume ? 'acp.session.resume' : 'acp.session.new', { sessionId: sid, sessionDir: dir, turnsFound: turns, account: slot, accountHome: real, cwd });
    notify(sid, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'usage', description: 'Show usage' }] });
    reply(id, { ...(resume ? {} : { sessionId: sid }), configOptions: CONFIG_OPTIONS('on'), modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } });
  }

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params = {} } = msg;
    if (id === undefined || id === null) {
      if (method === 'session/cancel') {
        const s = sessions.get(params.sessionId);
        if (s?.active) s.active.cancelled = true;
      }
      return;
    }
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { resume: {} } },
          authMethods: [{ id: 'login', name: 'Login with Kimi account', description: 'Run `kimi login`' }],
          agentInfo: { name: 'kimi-code', title: 'Kimi Code', version: VERSION },
        });
      case 'authenticate': {
        const login = managedLogin();
        const ok = !!login?.token?.access_token;
        log('acp.authenticate', { signedIn: ok, account: slot, accountHome: real });
        return ok ? reply(id, {}) : fail(id, -32000, 'Authentication required', { details: 'Run `kimi login` to sign in.' });
      }
      case 'session/new': return open(id, params, false);
      case 'session/resume': return open(id, params, true);
      case 'session/set_config_option': {
        const s = sessions.get(params.sessionId);
        log('acp.set_config_option', { sessionId: params.sessionId, configId: params.configId, value: params.value, account: slot,
          knownModels: params.configId === 'model' ? Object.keys(readConfig()?.models || {}) : undefined });
        if (params.configId === 'thinking' && !['off', 'on'].includes(params.value)) return fail(id, -32602, 'Invalid params', { details: `unsupported thinking ${params.value}` });
        // as Kimi's setModel: an alias this home's login did not bring is refused
        if (params.configId === 'model' && !Object.hasOwn(readConfig()?.models || {}, String(params.value))) return fail(id, -32603, 'Internal error', { details: `model ${params.value} does not exist` });
        if (s && params.configId === 'thinking') s.thinking = params.value;
        return reply(id, { configOptions: CONFIG_OPTIONS(s?.thinking || 'on') });
      }
      case 'session/prompt': return void prompt(id, params);
      default: return fail(id, -32601, `Method not found: ${method}`);
    }
  });
  rl.on('close', () => { log('acp.exit', { account: slot }); process.exit(0); });
  return null;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
log('invoke');
let code = 0;
if (args[0] === '--version' || args[0] === '-V') { process.stdout.write(VERSION + '\n'); }
else if (args[0] === 'login') code = await login(args.slice(1));
else if (args[0] === 'provider' && args[1] === 'list') code = providerList();
else if (args[0] === 'acp') code = acp();
else if (args[0] === '--resume') code = 0;
else { process.stderr.write(`fake kimi: unsupported command: ${args.join(' ')}\n`); code = 2; }
if (code !== null) process.exit(code);

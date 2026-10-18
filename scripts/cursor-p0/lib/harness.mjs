// Scenario harness: one run directory per scenario, every CLI process recorded, every output
// redacted, assertions collected as checks. Real prompts go through ctx.prompt, which charges the
// prompt ledger first and refuses to send anything but the Auto model.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync, copyFileSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AcpProcess, Recorder } from './acp.mjs';
import { Redactor } from './redact.mjs';
import { writeProtocol, writeFixture } from './record.mjs';
import { startProxy } from './proxy.mjs';
import { makeSlot, cursorEnv, readApiKey, AGENT, CLI_DIR, P0_ROOT, chargePrompt, VERSION } from './env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS = join(here, '..');
// --selftest swaps the CLI for the harness's own fake agent and never charges the ledger. Read at
// call time, not at import: reproduce.mjs sets it after its (hoisted) imports have run.
export const isSelftest = () => process.env.CURSOR_P0_SELFTEST === '1';
const FAKE = join(here, '..', 'selftest-fake-agent.mjs');
export const AUTO_MODEL = 'default[]';
export const INIT_PARAMS = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'orbit-p0', version: '0' } };
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Recursive content+mode fingerprint of a directory, or null when it does not exist.
export function fingerprint(dir) {
  if (!existsSync(dir)) return null;
  const hash = createHash('sha256');
  const visit = p => {
    for (const name of readdirSync(p).sort()) {
      const f = join(p, name), st = lstatSync(f);
      hash.update(relative(dir, f) + ':' + st.mode);
      if (st.isDirectory()) visit(f);
      else if (st.isFile()) hash.update(readFileSync(f));
    }
  };
  visit(dir);
  return hash.digest('hex');
}

// The runner user's real Cursor locations; the experiments must leave them as they found them.
export const REAL_CURSOR_DIRS = [join(homedir(), '.cursor'), join(homedir(), '.config', 'cursor'), join(homedir(), '.local', 'share', 'cursor-agent')];
export const realCursorState = () => Object.fromEntries(REAL_CURSOR_DIRS.map(d => [d, fingerprint(d)]));

export class ScenarioContext {
  constructor({ name, runId, runRoot, fixturesDir, key, shared = {} }) {
    this.name = name;
    this.shared = shared;
    this.runId = runId;
    this.dir = join(runRoot, name);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.fixturesDir = fixturesDir;
    this.key = key;
    this.rec = new Recorder();
    this.red = new Redactor().secret(key, 'CURSOR_API_KEY').path(this.dir, '<RUN>').path(CLI_DIR, '<CLI>').path(SCRIPTS, '<SCRIPTS>').path(P0_ROOT, '<P0_ROOT>');
    this.checks = [];
    this.detail = {};
    this.procs = [];
    this.proxies = [];
    this.realPrompts = [];
    this.fixtures = [];
  }

  // A check is a recorded assertion. `skipped` marks checks a scenario could not run (e.g. the
  // owner's key file is absent): they count as pass but carry skipped:true, so readers can tell
  // "held" from "verified".
  check(name, ok, detail, skipped = false) {
    this.checks.push({ name, ok: Boolean(ok), ...(skipped ? { skipped: true } : {}), ...(detail === undefined ? {} : { detail: this.red.value(detail) }) });
    return Boolean(ok);
  }
  note(key, value) { this.detail[key] = this.red.value(value); return value; }

  slot(name) { return makeSlot(this.dir, name); }

  repo(name, files = { 'README.md': '# probe repo\n' }) {
    const dir = join(this.dir, name);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    spawnSync('sh', ['-c', 'git init -q && git add -A && git -c user.email=p0@example.invalid -c user.name=p0 commit -qm init'], { cwd: dir });
    return dir;
  }

  env(slot, opts = {}) {
    const { apiKey = true, ...rest } = opts;
    return cursorEnv(slot, { ...rest, apiKey: apiKey === true ? this.key : apiKey || null });
  }

  acp({ slot, args = [], env, cwd, label, onRequest, wrap, envOpts = {} }) {
    const fullEnv = env ?? this.env(slot, envOpts);
    const target = isSelftest() ? [process.execPath, FAKE] : [AGENT];
    const bin = wrap ? wrap[0] : target[0];
    const argv = wrap ? [...wrap.slice(1), ...target, 'acp', ...args] : [...target.slice(1), 'acp', ...args];
    const p = new AcpProcess({ bin, args: argv, env: fullEnv, cwd, recorder: this.rec, label, onRequest: onRequest ?? defaultOnRequest });
    p.selftestFake = isSelftest();
    this.procs.push(p);
    return p;
  }

  async initialize(p, capabilities) {
    const params = capabilities ? { ...INIT_PARAMS, clientCapabilities: { ...INIT_PARAMS.clientCapabilities, ...capabilities } } : INIT_PARAMS;
    return p.request('initialize', params, 60000);
  }

  // session/new; remembers the model the process says the session uses.
  async newSession(p, cwd, mcpServers = []) {
    const r = await p.request('session/new', { cwd, mcpServers }, 180000);
    if (r.result) p.lastModel = currentModel(r.result);
    return r;
  }

  async loadSession(p, sessionId, cwd, mcpServers = []) {
    const r = await p.request('session/load', { sessionId, cwd, mcpServers }, 180000);
    if (r.result) p.lastModel = currentModel(r.result);
    return r;
  }

  // A real prompt: charged first, Auto model only (the model choice is process-global).
  async prompt(p, sessionId, text, note, timeoutMs = 600000) {
    if (p.lastModel !== AUTO_MODEL) {
      const r = await p.request('session/set_config_option', { sessionId, configId: 'model', value: AUTO_MODEL }, 60000);
      if (!r.result) throw new Error(`could not select the Auto model before a real prompt: ${JSON.stringify(r)}`);
      p.lastModel = currentModel(r.result);
      if (p.lastModel !== AUTO_MODEL) throw new Error(`model is ${p.lastModel}, refusing a real prompt`);
    }
    // A self-test prompt must reach the fake, and a charged prompt must reach the real CLI.
    if (isSelftest() !== p.selftestFake) throw new Error('refusing a prompt: self-test mode and the spawned agent disagree');
    const entry = isSelftest() ? { n: 0, at: new Date().toISOString(), selftest: true } : chargePrompt(this.runId, this.name, note);
    this.realPrompts.push({ n: entry.n, at: entry.at, note });
    const from = p.updates.length;
    const t0 = Date.now();
    const promise = p.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs);
    return { promise, from, t0 };
  }

  async promptAndWait(p, sessionId, text, note, timeoutMs = 600000) {
    const { promise, from, t0 } = await this.prompt(p, sessionId, text, note, timeoutMs);
    const response = await promise;
    return { response, ms: Date.now() - t0, updates: p.updates.slice(from).filter(u => u.sessionId === sessionId).map(u => u.update) };
  }

  cli(slot, args, { env, cwd, timeoutMs = 120000, input = '', envOpts = {} } = {}) {
    const fullEnv = env ?? this.env(slot, envOpts);
    const t0 = Date.now();
    const r = spawnSync(AGENT, args, { env: fullEnv, cwd: cwd ?? this.dir, encoding: 'utf8', timeout: timeoutMs, input });
    const out = { args, exit: r.status, signal: r.signal, ms: Date.now() - t0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    this.rec.add('cli', 'cli', out);
    return out;
  }

  async proxy(opts) {
    const p = await startProxy(opts);
    this.proxies.push(p);
    return p;
  }

  // Files under `root` with mode and size, relative and redacted; compile cache and synced skills elided.
  tree(root) {
    if (!existsSync(root)) return [];
    const out = [];
    const visit = p => {
      for (const name of readdirSync(p).sort()) {
        const f = join(p, name), st = lstatSync(f), rel = relative(root, f);
        if (/cursor-compile-cache|skills-cursor\/.|\.npm\/_cacache|\.npm\/_npx\/.+\/node_modules\/./.test(rel)) continue;
        if (st.isDirectory()) { out.push(`${rel}/`); visit(f); }
        else out.push(`${rel} ${(st.mode & 0o777).toString(8)} ${st.isSocket() ? 'socket' : st.isSymbolicLink() ? 'symlink' : st.size}`);
      }
    };
    visit(root);
    return out.map(l => this.red.text(l));
  }

  // The JSON blobs of an ACP session store (system prompt, user context, messages).
  storeBlobs(configDir, sessionId) {
    const db = join(configDir, 'acp-sessions', sessionId, 'store.db');
    if (!existsSync(db)) return null;
    // The store runs in WAL mode: most of a live (or killed) session sits in store.db-wal.
    const copy = join(this.dir, `store-copy-${sessionId}.db`);
    copyFileSync(db, copy);
    for (const ext of ['-wal', '-shm']) if (existsSync(db + ext)) copyFileSync(db + ext, copy + ext);
    const conn = new DatabaseSync(copy);
    const meta = conn.prepare('select key, value from meta').all().map(r => ({ key: r.key, value: safeJson(Buffer.from(r.value, 'hex').toString()) }));
    const blobs = [];
    let binary = 0;
    for (const row of conn.prepare('select id, data from blobs').all()) {
      const text = Buffer.from(row.data).toString('utf8');
      const json = safeJson(text);
      if (json && typeof json === 'object') blobs.push({ id: row.id, json });
      else binary++;
    }
    conn.close();
    for (const ext of ['', '-wal', '-shm']) rmSync(copy + ext, { force: true });
    return { meta, blobs, binary };
  }

  fixture(proc, fixtureName, meta = {}) {
    const dir = join(this.fixturesDir, this.name, fixtureName);
    writeFixture(dir, proc.label, this.rec, this.red, { scenario: this.name, process: proc.label, version: VERSION, exit: proc.exit, ...meta });
    this.fixtures.push(relative(this.fixturesDir, dir));
  }

  async dispose() {
    for (const p of this.procs) await p.dispose();
    for (const x of this.proxies) await x.close();
  }
}

function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }

export function currentModel(result) {
  const opt = (result.configOptions ?? []).find(o => o.id === 'model');
  return opt?.currentValue ?? result.models?.currentModelId ?? null;
}

// Unknown server requests are answered with an error rather than left hanging; permission
// requests default to reject-once (scenarios that want effects pass their own policy).
export function defaultOnRequest(msg) {
  if (msg.method === 'session/request_permission') return { result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } };
  return { error: { code: -32601, message: 'not supported by the P0 client' } };
}

// Permission policy by ACP tool kind (execute/edit/read/fetch/other ...), with a fallback.
export function policyByKind(map, fallback = 'reject-once', extra = {}) {
  return msg => {
    if (msg.method === 'session/request_permission') {
      const kind = msg.params?.toolCall?.kind ?? 'other';
      const choice = typeof map === 'function' ? map(msg) : (map[kind] ?? fallback);
      if (choice === null) return undefined;
      if (choice === 'cancelled') return { result: { outcome: { outcome: 'cancelled' } } };
      return { result: { outcome: { outcome: 'selected', optionId: choice } } };
    }
    if (extra[msg.method]) return extra[msg.method](msg);
    return { error: { code: -32601, message: 'not supported by the P0 client' } };
  };
}

export function textOf(updates, kind) {
  return updates.filter(u => u.sessionUpdate === kind).map(u => u.content?.text ?? '').join('');
}

export function toolCalls(updates) {
  const byId = new Map();
  for (const u of updates) {
    if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') continue;
    const cur = byId.get(u.toolCallId) ?? { toolCallId: u.toolCallId, statuses: [] };
    for (const k of ['title', 'kind', 'rawInput', 'rawOutput', 'locations', 'content']) if (u[k] !== undefined) cur[k] = u[k];
    if (u.status) cur.statuses.push(u.status);
    byId.set(u.toolCallId, cur);
  }
  return [...byId.values()];
}

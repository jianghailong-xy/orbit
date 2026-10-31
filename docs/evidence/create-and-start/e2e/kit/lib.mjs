// Shared helpers for the startNow / Create and start e2e (adapted from the R29-13 kit's lib.mjs): the stack's HTTP
// API (loopback only), its database (read-only psql through stack.sh), the fake engine's log, and the evidence files
// written under ../<scenario>/.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const S = process.env.CAS_DIR || '/var/tmp/cas-e2e';
export const API_PORT = Number(process.env.CAS_API_PORT || 3967);
export const WEB_PORT = Number(process.env.CAS_WEB_PORT || 2967);
export const API = `http://127.0.0.1:${API_PORT}/api`;
export const WEB = `http://127.0.0.1:${WEB_PORT}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uuid = () => randomUUID();

export class HttpError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} -> ${status} ${body.slice(0, 800)}`);
    this.status = status;
    this.body = body;
    try { this.json = JSON.parse(body); } catch { this.json = undefined; }
  }
}

export async function call(method, path, bearer, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(method, path, res.status, text);
  return text ? JSON.parse(text) : undefined;
}

export const stateFile = `${S}/state.json`;
export const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {});
export const saveState = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2) + '\n');

export async function login() {
  const a = JSON.parse(readFileSync(`${S}/accounts.json`, 'utf8')).owner;
  return call('POST', '/auth/login', undefined, { email: a.email, password: a.password });
}

export async function until(what, fn, { timeoutMs = 180_000, everyMs = 2_000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(everyMs);
  }
}

export function stack(...args) {
  return execFileSync('bash', [join(HERE, 'stack.sh'), ...args], {
    env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** One read-only query (stack.sh psql runs it with default_transaction_read_only=on). */
export const psql = (sql, expanded = false) => stack('psql', sql, ...(expanded ? ['x'] : []));

// ── evidence ─────────────────────────────────────────────────────────────────────────────────────────
export function evidence(scenario) {
  const dir = join(HERE, '..', scenario);
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, 'transcript.md');
  const say = (line) => {
    const stamped = `${new Date().toISOString()}  ${line}`;
    console.log(stamped);
    appendFileSync(transcript, stamped + '\n');
  };
  const file = (name, content) => writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  /** A titled read-only query, appended to queries.txt with the SQL itself. */
  const query = (title, sql, expanded = false) => {
    const outText = psql(sql, expanded);
    appendFileSync(join(dir, 'queries.txt'), `\n### ${title}  (${new Date().toISOString()})\n${sql.trim()}\n\n${outText}`);
    return outText;
  };
  return { dir, say, file, query };
}

export function logSize(path) {
  return existsSync(path) ? readFileSync(path).length : 0;
}
/** The JSON lines of a log written since a byte offset. */
export function jsonLinesSince(path, from = 0) {
  if (!existsSync(path)) return [];
  return readFileSync(path).subarray(from).toString('utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Send a message to a session as the owner (the fake engine acts on its E2E-MCP lines). */
export function sendTurn(T, sessionId, content) {
  return call('POST', `/sessions/${sessionId}/turns`, T, { clientTurnId: uuid(), content });
}

/** The fake engine's log line answering one E2E-MCP call. */
export function mcpAnswer(callId, timeoutMs = 300_000) {
  const path = `${S}/logs/fake-claude.jsonl`;
  return until(`the fake engine's answer to ${callId}`, () =>
    jsonLinesSince(path).find((rec) => rec.kind === 'mcp' && rec.id === callId) ?? null, { timeoutMs, everyMs: 1_000 });
}

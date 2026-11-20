// Shared helpers for the revision 42 part two e2e scenarios (a-ops.mjs, b-mixed.mjs): the stack's HTTP API (loopback
// only, through the staging stack's web gateway), its database (read-only psql through stack.sh), the bare origins, and
// the records each run writes under $LM_DIR/records/<scenario>/. Taken from the R29-13 kit and cut down.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT = process.env.LM_PROJECT || 'orbit-link-lm42';
export const S = process.env.LM_DIR || `/var/tmp/${PROJECT}`;
export const SD = S;
export const HTTP_PORT = Number(process.env.LM_HTTP_PORT || 46086);
export const API = `http://127.0.0.1:${HTTP_PORT}/api`;
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

/** The call's answer, or the refusal as data ({ refused: status, body }). */
export async function attempt(method, path, bearer, body) {
  try {
    return { ok: true, answer: await call(method, path, bearer, body) };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, status: e.status, body: e.json ?? e.body };
    throw e;
  }
}

export const stateFile = `${SD}/state.json`;
export const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {});
export const saveState = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2) + '\n');

export async function login() {
  const password = readFileSync(`${SD}/stack/secrets/owner_password`, 'utf8').trim();
  return (await call('POST', '/auth/login', undefined, { email: 'owner@orbit-staging.test', password })).accessToken;
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

export function gitIn(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: `${SD}/runner-userhome`, GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
export const origin = (name) => `${SD}/origin/${name}.git`;

// ── evidence ─────────────────────────────────────────────────────────────────────────────────────────
export function evidence(scenario) {
  const dir = join(SD, 'records', process.env.LM_RUN || 'adhoc', scenario);
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, 'transcript.md');
  const say = (line) => {
    const stamped = `${new Date().toISOString()}  ${line}`;
    console.log(stamped);
    appendFileSync(transcript, stamped + '\n');
  };
  const file = (name, content) => writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  const appendFile = (name, content) => appendFileSync(join(dir, name), content);
  /** A titled read-only query, appended to queries.txt with the SQL itself. */
  const query = (title, sql, expanded = false) => {
    const outText = psql(sql, expanded);
    appendFileSync(join(dir, 'queries.txt'), `\n### ${title}  (${new Date().toISOString()})\n${sql.trim()}\n\n${outText}`);
    return outText;
  };
  return { dir, say, file, appendFile, query };
}

/** The lines of a log file written since `from` (a byte offset), for the evidence of one step. */
export function logSince(path, from) {
  if (!existsSync(path)) return '';
  return readFileSync(path).subarray(from).toString('utf8');
}
export function logSize(path) {
  return existsSync(path) ? readFileSync(path).length : 0;
}

// ── common reads ─────────────────────────────────────────────────────────────────────────────────────
export const getTask = (T, id) => call('GET', `/tasks/${id}`, T);
export const waitTask = (T, id, statuses, what, timeoutMs = 240_000) =>
  until(what, async () => { const t = await getTask(T, id); return statuses.includes(t.status) ? t : null; }, { timeoutMs, everyMs: 2_000 });
export const execute = (T, id) => call('POST', `/tasks/${id}/execute`, T, { triggerId: uuid() });

/**
 * Send a message to a session as the owner (the coordinator's fake engine acts on E2E-MCP lines), once every turn the
 * session already has is answered. A message sent while a turn runs goes in as a steer, and a steer that finds its turn
 * over is re-filed as an ordinary message; on 2026-11-20 one such message reached the engine twice (task
 * 350rBMIZ9MSf6BLBb0Pdt), which would run a coordinator write twice. Waiting keeps these runs about revision 42.
 */
export async function sendTurn(T, sessionId, content) {
  const open = () => Number(psql(`select count(*) from conversation_turn
    where session_id = '${publicIdToUuid(sessionId)}' and answered_at is null`).split('\n')[2]?.trim());
  await until(`every turn of session ${sessionId} to be answered`, () => open() === 0, { timeoutMs: 180_000, everyMs: 500 });
  return call('POST', `/sessions/${sessionId}/turns`, T, { clientTurnId: uuid(), content });
}

/** A public id is the row's uuid in base62 (0-9A-Za-z). */
export function publicIdToUuid(id) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of id) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error(`not a public id: ${id}`);
    n = n * 62n + BigInt(v);
  }
  const hex = n.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Wait for the fake engine's log line answering one E2E-MCP call. */
export async function mcpAnswer(callId, timeoutMs = 180_000) {
  const path = `${SD}/logs/fake-claude.jsonl`;
  return until(`the coordinator's answer to ${callId}`, () => {
    if (!existsSync(path)) return null;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.includes(callId)) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.kind === 'mcp' && rec.id === callId) return rec;
      } catch { /* partial line */ }
    }
    return null;
  }, { timeoutMs, everyMs: 1_500 });
}

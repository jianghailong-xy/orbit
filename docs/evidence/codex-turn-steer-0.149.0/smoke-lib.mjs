import { spawn, spawnSync } from 'node:child_process';

export const base = process.env.ORBIT_SMOKE_BASE || 'http://127.0.0.1:2086';
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const deadline = (ms) => Date.now() + ms;

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function publicIdToUuid(value) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
  let n = 0n;
  for (const character of value) {
    const digit = BASE62.indexOf(character);
    if (digit < 0) throw new Error(`invalid public id: ${value}`);
    n = n * 62n + BigInt(digit);
  }
  if (n >= 1n << 128n) throw new Error(`public id overflows a UUID: ${value}`);
  const hex = n.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function loginToken() {
  const email = process.env.ORBIT_SMOKE_EMAIL;
  const password = process.env.ORBIT_SMOKE_PASSWORD;
  if (!email || !password) return null;
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status} ${await response.text()}`);
  return (await response.json()).accessToken;
}

/**
 * Resolve a bearer token without recording a password or JWT secret in the evidence.
 *
 * Production-style credentials win. For a smoke on the local Compose deployment, the caller may
 * instead name its own public owner id. The helper asks the already-running apiserver container to
 * sign a short-lived token with the secret it already has; neither that secret nor the token is
 * printed or persisted.
 */
export async function smokeToken() {
  if (process.env.ORBIT_SMOKE_TOKEN) return process.env.ORBIT_SMOKE_TOKEN;
  const loggedIn = await loginToken();
  if (loggedIn) return loggedIn;
  const ownerPublicId = process.env.ORBIT_SMOKE_OWNER_PUBLIC_ID;
  if (!ownerPublicId) {
    throw new Error('set ORBIT_SMOKE_TOKEN, ORBIT_SMOKE_EMAIL/PASSWORD, or ORBIT_SMOKE_OWNER_PUBLIC_ID');
  }
  const ownerId = publicIdToUuid(ownerPublicId);
  const signer = [
    "const jwt=require('jsonwebtoken')",
    "const token=jwt.sign({sub:process.env.ORBIT_SMOKE_SUB,email:'local-smoke@orbit.invalid'},process.env.JWT_SECRET,{expiresIn:'20m'})",
    'process.stdout.write(token)',
  ].join(';');
  const result = spawnSync(
    'docker',
    ['exec', '-e', `ORBIT_SMOKE_SUB=${ownerId}`, 'orbit-apiserver', 'node', '-e', signer],
    { encoding: 'utf8' },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`could not mint local smoke token: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

export async function smokeApi() {
  const token = await smokeToken();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const api = async (path, init = {}) => {
    const response = await fetch(`${base}/api${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${body}`);
    return body ? JSON.parse(body) : undefined;
  };
  return { api, token };
}

export async function chooseWorkspace(api) {
  if (process.env.ORBIT_SMOKE_WORKSPACE) return process.env.ORBIT_SMOKE_WORKSPACE;
  const workspaces = await api('/workspaces');
  assert(Array.isArray(workspaces), 'GET /workspaces did not return an array');
  const usable = workspaces.filter(
    (workspace) =>
      workspace.enabled !== false &&
      workspace.runner &&
      !['OFFLINE', 'DISABLED'].includes(String(workspace.runner.status || '').toUpperCase()),
  );
  const workspace =
    usable.find((candidate) => candidate.name === 'orbit' && candidate.workDir === '/root/orbit') ||
    usable.find((candidate) => candidate.name === 'orbit') ||
    usable[0];
  assert(workspace, 'no enabled workspace with a live runner is available for the smoke');
  return workspace.publicId || workspace.id;
}

export async function sessionEvents(api, sessionId, tail = 400) {
  const page = await api(`/sessions/${encodeURIComponent(sessionId)}/events/page?tail=${tail}`);
  return page.events || page.items || [];
}

export function eventPayload(event) {
  return event.payload && typeof event.payload === 'object'
    ? event.payload
    : event.data && typeof event.data === 'object'
      ? event.data
      : event;
}

export function eventText(event) {
  const payload = eventPayload(event);
  return String(payload.text ?? payload.content ?? event.text ?? event.content ?? '');
}

export function eventDelivery(event) {
  const payload = eventPayload(event);
  return String(payload.delivery ?? event.delivery ?? '');
}

export async function waitForTool(api, sessionId, maxMs = 120_000) {
  let events = [];
  for (const until = deadline(maxMs); Date.now() < until; ) {
    events = await sessionEvents(api, sessionId);
    const event = events.find((candidate) => candidate.type === 'tool_use');
    if (event) return { event, events };
    await sleep(300);
  }
  throw new Error(`tool_use did not appear: ${events.map((event) => event.type).join(',')}`);
}

const SETTLED = new Set(['AWAITING_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
export async function waitForSettled(api, sessionId, maxMs = 240_000) {
  let detail;
  let events = [];
  for (const until = deadline(maxMs); Date.now() < until; ) {
    detail = await api(`/sessions/${encodeURIComponent(sessionId)}`);
    events = await sessionEvents(api, sessionId);
    if (SETTLED.has(detail.status)) return { detail, events };
    await sleep(400);
  }
  throw new Error(`session did not settle: ${detail?.status}`);
}

export function assertDeliveryLifecycle(events, turnId) {
  const relevant = events.filter(
    (event) => event.turnId === turnId && ['user', 'user_delivery'].includes(event.type),
  );
  const states = relevant.map(eventDelivery).filter(Boolean);
  const written = states.indexOf('written');
  const acknowledged = states.indexOf('acknowledged');
  assert(written >= 0, `turn ${turnId} never reported written: ${JSON.stringify(states)}`);
  assert(acknowledged > written, `turn ${turnId} did not advance written -> acknowledged: ${JSON.stringify(states)}`);
  assert(!states.includes('failed'), `turn ${turnId} reported failed: ${JSON.stringify(states)}`);
  const bubbles = relevant.filter((event) => event.type === 'user').length;
  assert(bubbles === 1, `turn ${turnId} has ${bubbles} user bubbles, want one`);
  return states;
}

function rpcReader() {
  const proc = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 0;
  let stdout = '';
  let stderr = '';
  const waiters = new Map();
  proc.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const waiter = waiters.get(String(message.id));
      if (!waiter) continue;
      waiters.delete(String(message.id));
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        waiters.delete(String(id));
        reject(new Error(`${method} timed out; codex stderr: ${stderr}`));
      }, 30_000);
      waiters.set(String(id), { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const notify = (method, params) => proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  const close = () => {
    proc.stdin.end();
    proc.kill('SIGTERM');
  };
  return { request, notify, close };
}

export async function readCodexThread(threadId) {
  const rpc = rpcReader();
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'orbit-smoke-reader', title: 'Orbit Smoke Reader', version: '1' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized', {});
    const result = await rpc.request('thread/read', { threadId, includeTurns: true });
    assert(result?.thread?.id === threadId, `thread/read returned ${result?.thread?.id}, want ${threadId}`);
    return result.thread;
  } finally {
    rpc.close();
  }
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).join('\n');
  if (!value || typeof value !== 'object') return '';
  return [value.text, value.content].map(contentText).filter(Boolean).join('\n');
}

export function itemText(item) {
  return contentText(item?.content ?? item?.text);
}

export function assertOneTurnContainsBothMessages(thread, initialText, steerText, steerTurnId) {
  const turns = thread.turns || [];
  const initialTurns = [];
  const steerTurns = [];
  const steerItems = [];
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type !== 'userMessage') continue;
      const text = itemText(item);
      if (text.includes(initialText)) initialTurns.push(turn);
      if (text.includes(steerText) || item.clientId === steerTurnId) {
        steerTurns.push(turn);
        steerItems.push(item);
      }
    }
  }
  assert(initialTurns.length === 1, `initial message is in ${initialTurns.length} Codex turns, want one`);
  assert(steerTurns.length === 1, `steer is in ${steerTurns.length} Codex turns/items, want one`);
  assert(initialTurns[0].id === steerTurns[0].id, 'initial message and steer are not in the same Codex turn');
  assert(steerItems.length === 1, `steer formed ${steerItems.length} Codex items, want one`);
  assert(
    !steerTurnId || steerItems[0].clientId === steerTurnId,
    `Codex steer clientId=${steerItems[0].clientId}, want Orbit turn ${steerTurnId}`,
  );
  return {
    codexTurnId: initialTurns[0].id,
    steerItemId: steerItems[0].id,
    steerClientId: steerItems[0].clientId,
    userMessageItems: (initialTurns[0].items || []).filter((item) => item.type === 'userMessage').length,
  };
}

export function assertFinalAnswer(thread, expected) {
  const answers = (thread.turns || [])
    .flatMap((turn) => turn.items || [])
    .filter((item) => item.type === 'agentMessage')
    .map(itemText);
  assert(answers.some((answer) => answer.trim() === expected), `final answer ${JSON.stringify(expected)} not found: ${JSON.stringify(answers)}`);
}

export function conciseEvents(events, turnId) {
  return events
    .filter(
      (event) =>
        event.turnId === turnId ||
        ['tool_use', 'tool_result'].includes(event.type),
    )
    .map((event) => ({
      type: event.type,
      turnId: event.turnId,
      delivery: eventDelivery(event) || undefined,
      text: event.type === 'assistant' ? eventText(event) : undefined,
    }));
}

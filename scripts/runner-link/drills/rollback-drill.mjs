#!/usr/bin/env node
// The API calls rollback-drill.sh, lost-answer-drill.sh and release-outage-drill.sh make on the staging stack (README.md beside this file): as its
// owner, who is also its administrator, or as the drill runner. Each prints one line of JSON and exits non-zero on an
// answer outside 2xx.
//
//   node rollback-drill.mjs <origin> <state dir> switch on|off|get
//   node rollback-drill.mjs <origin> <state dir> workspace <runner id> <work dir> <name>
//   node rollback-drill.mjs <origin> <state dir> session <workspace id> <prompt>
//   node rollback-drill.mjs <origin> <state dir> turn <session id> <content>
//   node rollback-drill.mjs <origin> <state dir> diff-refresh <session id>
//   node rollback-drill.mjs <origin> <state dir> runner <runner id>
//   node rollback-drill.mjs <origin> <state dir> update-now <runner id>
//   node rollback-drill.mjs <origin> <state dir> release <runner config.json> <latest> <previous>
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [origin, state, command, ...args] = process.argv.slice(2);
if (!origin || !state || !command) {
  console.error('usage: rollback-drill.mjs <origin> <state dir> <command> [arguments]');
  process.exit(2);
}

async function call(method, route, { token, body } = {}) {
  const res = await fetch(`${origin}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (res.status < 200 || res.status >= 300) {
    console.error(`rollback-drill: ${method} /api${route} answered ${res.status}: ${text}`);
    process.exit(1);
  }
  return json;
}

async function owner() {
  const password = readFileSync(path.join(state, 'secrets', 'owner_password'), 'utf8').trim();
  return (await call('POST', '/auth/login', { body: { email: 'owner@orbit-staging.test', password } })).accessToken;
}

// A base62 public id as the UUID the database keys it by (src/shared/src/codec.ts); a UUID as it is.
function toUuid(id) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id.toLowerCase();
  let n = 0n;
  for (const ch of id) n = n * 62n + BigInt('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.indexOf(ch));
  const hex = n.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let out;
switch (command) {
  case 'switch': {
    const token = await owner();
    out = args[0] === 'get'
      ? await call('GET', '/admin/runner-link-required', { token })
      : await call('PUT', '/admin/runner-link-required', { token, body: { required: args[0] === 'on' } });
    break;
  }
  case 'workspace': {
    const [runnerId, workDir, name] = args;
    const ws = await call('POST', '/workspaces', { token: await owner(), body: { name, runnerId, workDir } });
    out = { id: ws.id, name: ws.name };
    break;
  }
  case 'session': {
    const [workspaceId, prompt] = args;
    const session = await call('POST', '/sessions', { token: await owner(), body: { workspaceId, engine: 'claude', prompt } });
    out = { id: session.id, uuid: toUuid(session.id) };
    break;
  }
  case 'turn': {
    const [sessionId, content] = args;
    const turn = await call('POST', `/sessions/${sessionId}/turns`, { token: await owner(), body: { clientTurnId: randomUUID(), content } });
    out = { id: turn?.id ?? null };
    break;
  }
  case 'diff-refresh':
    // A person opening a file's diff: a 'diff' control turn queued for the session's runner (requestDiffRefresh).
    await call('POST', `/sessions/${args[0]}/diff/refresh`, { token: await owner() });
    out = { ok: true };
    break;
  case 'runner': {
    const r = await call('GET', `/runners/${args[0]}`, { token: await owner() });
    out = { name: r.name, version: r.version, status: r.status, online: r.online, lastHeartbeatAt: r.lastHeartbeatAt, selfUpdate: r.selfUpdate };
    break;
  }
  case 'update-now':
    out = await call('POST', `/runners/${args[0]}/self-update`, { token: await owner() });
    break;
  case 'release': {
    // What GET /api/runner/release assigns the drill runner, asked with its own credential as its release check asks.
    const [configFile, latest, previous] = args;
    const { runnerToken } = JSON.parse(readFileSync(configFile, 'utf8'));
    out = await call('GET', `/runner/release?${new URLSearchParams({ latest, previous })}`, { token: runnerToken });
    break;
  }
  default:
    console.error(`rollback-drill: unknown command ${command}`);
    process.exit(2);
}
console.log(JSON.stringify(out));

// Helpers for the running-mode stack (stack.sh): the stack's API as its owner and as a runner, the runner's own sequence for
// holding a session (src/android/scripts/a11-stack/a07d-stack.mjs: claim, takeover-leases, activate-leases, inbox), and the
// state the seed leaves for the capture.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
export const S = process.env.PMA_STACK_DIR || '/var/tmp/permission-mode-actual-stack';
const ENV = Object.fromEntries(
  readFileSync(`${S}/stack.env`, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);
export const API = ENV.PMA_API;
export const WT = ENV.PMA_WT;
export const SHA = ENV.PMA_SHA;
export const DATABASE_URL = ENV.PMA_DATABASE_URL;
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const iso = () => new Date().toISOString();

export async function call(method, path, token, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
}

export async function until(what, read, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

const stateFile = `${S}/state.json`;
export const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
export const writeState = (state) => writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });

/** The app headers a client sends with a config change (turn-sender-client.ts): which app the owner was in. */
export const fromApp = (app, device) => ({ 'x-orbit-client': `${app}/1.0`, ...(device ? { 'x-orbit-device': device } : {}) });

// ── a runner, through the server's own doors ──────────────────────────────────────────────────────────────────────────────
// This server takes a runner daemon's calls only over the runner link (426 UPGRADE_REQUIRED over plain HTTP), so the runner's
// side is played as the server's own pg specs play it (src/apiserver/src/sessions/actual-permission-mode.pg.spec.ts): the
// production services from this checkout's dist/, on the stack's database — QueueService's claim, RunnerApiController's
// heartbeat, inbox, events and turn-complete, SessionsService.updateConfig. The link only carries those calls.
const ALL_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
/** The Claude models this runner's CLI lists, each with the modes its init frame settles on: Haiku 4.5 has no Auto. */
export const MODEL_CATALOG = {
  claude: [
    { value: 'claude-opus-5-5', label: 'Opus 5.5', permissionModes: ALL_MODES },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5', permissionModes: ALL_MODES.filter((mode) => mode !== 'auto') },
  ],
};

export function services() {
  const require = createRequire(`${WT}/src/apiserver/dist/main.js`);
  const { prismaClientFor } = require('./prisma/prisma-client.js');
  const { QueueService } = require('./queue/queue.service.js');
  const { SessionsService } = require('./sessions/sessions.service.js');
  const { RunnerApiController } = require('./runner-api/runner-api.controller.js');
  const prisma = prismaClientFor(DATABASE_URL);
  // As the pg spec builds them: realtime fan-out goes nowhere (the stack's apiserver is another process; the web reads on load).
  const quiet = new Proxy({}, { get: () => () => undefined });
  const queue = new QueueService(prisma, quiet);
  const sessions = new SessionsService(prisma, queue, quiet);
  const api = new RunnerApiController(
    prisma, queue, quiet,
    new Proxy({}, { get: () => async () => undefined }),
    { assert: async (_runner, callingSessionId) => callingSessionId ?? randomUUID() },
    { expand: async (_ownerId, content) => content },
    undefined, undefined, undefined, undefined, undefined,
    sessions,
  );
  return { prisma, queue, sessions, api };
}

/** The session's inbox lease generation, made when it has none live (src/apiserver/src/test-support/dequeue-under-lease.ts). */
export async function sessionLease(prisma, sessionId) {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw`
      SELECT s."inbox_lease_generation" AS "generation", s."inbox_lease_owner"::text AS "owner",
             EXISTS (SELECT 1 FROM "inbox_lease_generation" g
                      WHERE g."generation" = s."inbox_lease_generation" AND g."session_id" = s.id
                        AND g."lease_owner" IS NOT DISTINCT FROM s."inbox_lease_owner" AND g."retired_at" IS NULL) AS "live"
        FROM "session" s WHERE s.id = ${sessionId}::uuid FOR UPDATE OF s`;
    if (row?.generation && row.live) return row.generation;
    const generation = randomUUID();
    await tx.$executeRaw`SELECT set_config('orbit.runner_supports_opencode', '1', true), set_config('orbit.runner_supports_antigravity', '1', true), set_config('orbit.runner_supports_dsh', '1', true), set_config('orbit.runner_supports_cursor', '1', true), set_config('orbit.claim_reads_session_engine', '1', true)`;
    await tx.$executeRaw`UPDATE "session" SET "inbox_lease_generation" = ${generation}::uuid WHERE id = ${sessionId}::uuid`;
    await tx.$executeRaw`INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner") VALUES (${generation}::uuid, ${sessionId}::uuid, ${row.owner}::uuid)`;
    return generation;
  });
}

/** A runner's heartbeat through the controller's own reconcile path: its engines, model catalogue and whether it runs as root. */
export const heartbeat = (api, r) => api.heartbeat(
  { id: r.runnerId, version: r.version, lastHeartbeatAt: null },
  { status: 'ONLINE', idleCapacity: 4, version: r.version, runsAsRoot: r.runsAsRoot, leaseOwner: r.leaseOwner, draining: false,
    engines: [{ engine: 'claude', installed: true, version: '2.1.325 (Claude Code)', auth: 'yes',
      accounts: [{ id: 'default', home: '/root/.claude', auth: 'yes' }] }],
    modelCatalog: MODEL_CATALOG },
  undefined, 'claude', 'linux', undefined, undefined, {},
);

/** The Agent Tools report Claude Code's init frame becomes (runner agent_tools_report.go), with the mode it settled on. */
export const agentToolsReport = (permissionMode) => ({
  v: 1, at: iso(), engine: 'claude', engineVersion: '2.1.325',
  versions: { contract: '1.15.0', catalog: '1.8.1', primer: '1.8.1', guide: '1.2.0', playbooks: '1.0.0' },
  mcp: { status: 'connected', tools: 102 },
  families: [{ id: 'tasks', served: 21, total: 21 }],
  switches: { orchestration: true, watches: true, wiki: true },
  permissionMode,
  instructions: { carrier: 'append_system_prompt', workspace: false },
  skill: { name: 'orbit:playbooks', offered: true, loaded: true },
});

// The stack under the Codex rate-limit reset E2E (scripts/test-codex-reset-e2e.sh), every piece of it a real process
// or a real socket:
//
//   PostgreSQL ..... a disposable postgres:16-alpine container, migrated by this branch's `prisma migrate deploy`
//   apiserver ...... `node dist/main.js` — the production AppModule, its auth, operation API, heartbeat and result routes
//   web ............ the production `vite build` bundle, served with /api passed through to that apiserver
//   runner ......... the `orbit` binary built from src/runner-go: `orbit register`, then `orbit run` with its own
//                    runloop, heartbeat, usage probe, reset relay and consume
//   Codex .......... the consume tests' programmable fake app-server (the -tags codexresetfault test binary behind a
//                    `codex` shim first on the runner's PATH): credits, redeemed keys and every request it hears live in
//                    files, so its ledger is the ground truth. No real account, no real credit.
//
// Two taps sit on the wires and only ever add faults a scenario asks for: RunnerLink between the runner and the
// apiserver (drop a heartbeat or result answer, send a result twice), and WebFront between the browser and the
// apiserver (lose a create's answer). DbWatch samples the operation rows and the stored snapshot the whole time.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const CONSUME_METHOD = 'account/rateLimitResetCredit/consume';
export const RATE_LIMITS_READ_METHOD = 'account/rateLimits/read';

/** An error `eventually` must not retry through. */
export class Fatal extends Error {}

export async function eventually(what, check, timeoutMs = 60_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      last = undefined;
    } catch (error) {
      if (error instanceof Fatal) throw error;
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
    }
    await sleep(intervalMs);
  }
}

export async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function fileLog(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
  return (chunk) => appendFileSync(file, chunk);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function upstreamHeaders(req, target, body) {
  const headers = { ...req.headers, host: target.host };
  delete headers.connection;
  delete headers['transfer-encoding'];
  if (body !== undefined) headers['content-length'] = String(body.length);
  return headers;
}

function pipeThrough(req, res, upstream) {
  const target = new URL(req.url ?? '/', upstream);
  const outgoing = httpRequest(target, { method: req.method, headers: upstreamHeaders(req, target), agent: false }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  outgoing.on('error', () => res.destroy());
  res.on('close', () => outgoing.destroy());
  req.pipe(outgoing);
}

function forward(req, body, upstream) {
  return new Promise((resolve, reject) => {
    const target = new URL(req.url ?? '/', upstream);
    const outgoing = httpRequest(target, { method: req.method, headers: upstreamHeaders(req, target, body), agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// ── PostgreSQL ─────────────────────────────────────────────────────────────────────────────────

export async function startPostgres({ pg, name, log }) {
  const user = 'codex_reset_e2e';
  const database = 'codex_reset_e2e';
  const password = randomBytes(16).toString('hex');
  const run = spawnSync(
    'docker',
    ['run', '-d', '--name', name, '--label', 'orbit.codex-reset-e2e=1',
      '-e', `POSTGRES_USER=${user}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${database}`,
      '-e', 'PGDATA=/pgdata', '--tmpfs', '/pgdata:size=1g', '-p', '127.0.0.1::5432', 'postgres:16-alpine'],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  const stop = () => spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' });
  const published = spawnSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).stdout.trim().split('\n')[0] ?? '';
  const port = Number(published.slice(published.lastIndexOf(':') + 1));
  if (!port) {
    stop();
    throw new Error(`docker published no port for ${name}: ${published}`);
  }
  const url = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
  log(`==> ${name} on 127.0.0.1:${port}\n`);
  await eventually(
    'PostgreSQL to answer a query over TCP',
    async () => {
      const client = new pg.Client({ connectionString: url });
      client.on('error', () => undefined);
      try {
        await client.connect();
        await client.query('SELECT 1');
        return true;
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    120_000,
    500,
  );
  return { url, name, password, stop };
}

export function migrate({ apiDir, prisma, url, env, log }) {
  const result = spawnSync(prisma, ['migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    cwd: apiDir,
    env: { ...env, DATABASE_URL: url },
    encoding: 'utf8',
    timeout: 300_000,
  });
  log(`$ prisma migrate deploy\n${result.stdout}${result.stderr}\n`);
  if (result.status !== 0) throw new Error(`prisma migrate deploy exited ${result.status}:\n${result.stderr}`);
}

// ── the apiserver ──────────────────────────────────────────────────────────────────────────────

export async function startApiserver({ apiDir, node, env, port, log }) {
  const output = [];
  const child = spawn(node, ['dist/main.js'], { cwd: apiDir, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (chunk) => {
    const text = chunk.toString('utf8');
    output.push(text);
    log(text);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const origin = `http://127.0.0.1:${port}`;
  await eventually(
    'the apiserver to answer GET /api/auth/setup-status',
    async () => {
      if (child.exitCode !== null) throw new Fatal(`the apiserver exited ${child.exitCode}:\n${output.join('').slice(-6000)}`);
      const res = await fetch(`${origin}/api/auth/setup-status`);
      return res.ok;
    },
    240_000,
    500,
  );
  return {
    origin,
    child,
    text: () => output.join(''),
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const exited = await Promise.race([new Promise((resolve) => child.once('exit', () => resolve(true))), sleep(15_000).then(() => false)]);
      if (!exited) child.kill('SIGKILL');
    },
  };
}

/** One JSON request to the user API with a bearer token. */
export async function callApi(origin, method, route, { token, body } = {}) {
  const res = await fetch(`${origin}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: parseJson(text), text };
}

// ── the runner's wire ──────────────────────────────────────────────────────────────────────────

/**
 * Everything the runner says to the control plane passes through here. Heartbeats and reset results are read whole,
 * kept, and answered as the apiserver answered them unless a rule says otherwise; every other request is piped as-is,
 * long polls and streams included.
 */
export class RunnerLink {
  constructor(upstream) {
    this.upstream = upstream;
    this.exchanges = [];
    this.rules = [];
    this.seq = 0;
  }

  async listen() {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => res.destroy());
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    return this.origin;
  }

  close() {
    if (!this.server) return;
    this.server.closeAllConnections();
    this.server.close();
  }

  /** { route: 'heartbeat' | 'result', action: 'drop-response' | 'duplicate', when?(request, response), times? } */
  rule(spec) {
    const rule = { times: 1, ...spec, hits: 0 };
    this.rules.push(rule);
    return rule;
  }

  clearRules() {
    this.rules = [];
  }

  take(action, route, request, response) {
    const rule = this.rules.find(
      (candidate) =>
        candidate.action === action && candidate.route === route && candidate.hits < candidate.times && (!candidate.when || candidate.when(request, response)),
    );
    if (rule) rule.hits += 1;
    return rule ?? null;
  }

  async handle(req, res) {
    const url = req.url ?? '/';
    const route = url.endsWith('/runner/heartbeat') ? 'heartbeat' : url.endsWith('/runner/codex-rate-limit-reset-result') ? 'result' : null;
    if (!route) {
      pipeThrough(req, res, this.upstream);
      return;
    }
    const body = await readBody(req);
    const raw = body.toString('utf8');
    const request = parseJson(raw);
    const duplicate = this.take('duplicate', route, request, undefined);
    let forwarded;
    for (let attempt = 0; attempt < (duplicate ? 2 : 1); attempt += 1) {
      forwarded = await forward(req, body, this.upstream).catch((error) => ({
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ statusCode: 502, message: `codex-reset-e2e link: ${error.message}` })),
      }));
      const text = forwarded.body.toString('utf8');
      this.exchanges.push({
        seq: ++this.seq,
        at: Date.now(),
        route,
        request,
        raw,
        status: forwarded.status,
        response: parseJson(text),
        text,
        fault: attempt === 1 ? 'duplicate' : null,
      });
    }
    const exchange = this.exchanges.at(-1);
    if (this.take('drop-response', route, request, exchange.response)) {
      exchange.fault = exchange.fault ? `${exchange.fault}+drop-response` : 'drop-response';
      res.socket?.destroy();
      return;
    }
    res.writeHead(forwarded.status, { 'content-type': String(forwarded.headers['content-type'] ?? 'application/json') });
    res.end(forwarded.body);
  }
}

// ── the web ────────────────────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/** The production bundle, same-origin with /api — what the gateway does in a deployment. */
export class WebFront {
  constructor({ dist, upstream }) {
    this.dist = dist;
    this.upstream = upstream;
    this.exchanges = [];
    this.dropCreateAnswers = 0;
    this.holdCreateAnswers = 0;
    this.holdCreateAnswerMs = 0;
    this.seq = 0;
  }

  async listen() {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => res.destroy());
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${this.server.address().port}`;
    return this.origin;
  }

  close() {
    if (!this.server) return;
    this.server.closeAllConnections();
    this.server.close();
  }

  static isCreate(method, pathname) {
    return method === 'POST' && /^\/api\/runners\/[^/]+\/codex-rate-limit-reset$/.test(pathname);
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://front.invalid');
    if (!url.pathname.startsWith('/api/')) {
      this.serve(res, url.pathname);
      return;
    }
    if (WebFront.isCreate(req.method, url.pathname)) this.createsSeen = (this.createsSeen ?? 0) + 1;
    const body = await readBody(req);
    const target = new URL(req.url ?? '/', this.upstream);
    const outgoing = httpRequest(
      target,
      { method: req.method, headers: upstreamHeaders(req, target, body.length > 0 ? body : undefined), agent: false },
      (response) => {
        if (String(response.headers['content-type'] ?? '').includes('text/event-stream')) {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
          res.on('close', () => response.destroy());
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const payload = Buffer.concat(chunks);
          const create = WebFront.isCreate(req.method, url.pathname);
          const exchange = {
            seq: ++this.seq,
            at: Date.now(),
            method: req.method,
            path: url.pathname,
            request: create ? parseJson(body.toString('utf8')) : undefined,
            status: response.statusCode ?? 0,
            text: payload.toString('utf8'),
            dropped: false,
          };
          this.exchanges.push(exchange);
          if (create && this.dropCreateAnswers > 0) {
            this.dropCreateAnswers -= 1;
            exchange.dropped = true;
            res.socket?.destroy();
            return;
          }
          const answer = () => {
            if (res.destroyed || res.socket?.destroyed) {
              exchange.abandoned = true;
              return;
            }
            const headers = { ...response.headers, 'content-length': String(payload.length) };
            delete headers['transfer-encoding'];
            delete headers.connection;
            res.writeHead(response.statusCode ?? 502, headers);
            res.end(payload);
          };
          // The create landed; its answer waits longer than the page is willing to.
          if (create && this.holdCreateAnswers > 0) {
            this.holdCreateAnswers -= 1;
            exchange.heldMs = this.holdCreateAnswerMs;
            setTimeout(answer, this.holdCreateAnswerMs);
            return;
          }
          answer();
        });
        response.on('error', () => res.destroy());
      },
    );
    outgoing.on('error', () => res.destroy());
    outgoing.end(body);
  }

  serve(res, pathname) {
    let file = path.join(this.dist, path.normalize(decodeURIComponent(pathname)));
    if (!file.startsWith(this.dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(this.dist, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  }

  creates(since = 0) {
    return this.exchanges.slice(since).filter((exchange) => exchange.request !== undefined);
  }
}

// ── the fake Codex ─────────────────────────────────────────────────────────────────────────────

export class FakeCodex {
  constructor({ dir, binDir, faultBinary, runnerGoDir }) {
    this.dir = dir;
    this.binDir = binDir;
    this.faultBinary = faultBinary;
    this.runnerGoDir = runnerGoDir;
    this.shim = path.join(binDir, 'codex');
  }

  init(state) {
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.binDir, { recursive: true });
    writeFileSync(path.join(this.dir, 'provider.json'), JSON.stringify(state));
    // TestMain answers as the fake app-server before any test flag is parsed, whatever argv the runner passes.
    writeFileSync(this.shim, `#!/bin/sh\nORBIT_FAKE_CODEX_RESET_PROVIDER='${this.dir}' exec '${this.faultBinary}' "$@"\n`);
    chmodSync(this.shim, 0o755);
  }

  /** Applies provider-state fields under the lock every fake app-server takes, and resolves the state after it. */
  patch(fields = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        this.faultBinary,
        ['-test.run', '^TestCodexResetFaultProvider$', '-test.count', '1'],
        {
          cwd: this.runnerGoDir,
          timeout: 60_000,
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: this.dir,
            ORBIT_CODEX_RESET_FAULT_PROVIDER_DIR: this.dir,
            ORBIT_CODEX_RESET_FAULT_PROVIDER_PATCH: JSON.stringify(fields),
          },
        },
        (error, _stdout, stderr) => {
          const line = String(stderr).split('\n').find((text) => text.startsWith('FAULTPROVIDER '));
          if (error || !line) {
            reject(new Error(`patching the fake provider failed: ${error?.message ?? 'no FAULTPROVIDER line'}\n${stderr}`));
            return;
          }
          resolve(JSON.parse(line.slice('FAULTPROVIDER '.length)));
        },
      );
    });
  }

  state() {
    return this.patch({});
  }

  /** Every frame the fake app-servers heard, in the order they heard them. */
  ledger() {
    const file = path.join(this.dir, 'events.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        const event = parseJson(line);
        return event ? [event] : [];
      });
  }

  consumeCalls(since = 0) {
    return this.ledger()
      .slice(since)
      .filter((event) => event.src === 'app' && event.method === CONSUME_METHOD);
  }
}

// ── the runner ─────────────────────────────────────────────────────────────────────────────────

export class RunnerMachine {
  constructor({ binary, root, searchPath, log }) {
    this.binary = binary;
    this.home = path.join(root, 'home');
    this.orbitHome = path.join(root, 'orbit');
    this.codexHome = path.join(root, 'codex');
    this.work = path.join(root, 'work');
    const tmp = path.join(root, 'tmp');
    for (const dir of [this.home, this.orbitHome, this.codexHome, this.work, tmp]) mkdirSync(dir, { recursive: true });
    // Built from nothing rather than inherited: no OPENAI_*, no CODEX_API_KEY, no session context of whoever runs this.
    this.env = {
      PATH: searchPath,
      HOME: this.home,
      ORBIT_HOME: this.orbitHome,
      CODEX_HOME: this.codexHome,
      TMPDIR: tmp,
      SHELL: '/bin/sh',
      LANG: 'C.UTF-8',
      ORBIT_NO_SELFUPDATE: '1',
      ORBIT_NO_ENGINE_UPDATE: '1',
    };
    this.log = log;
    this.child = null;
    this.paused = false;
    this.starts = 0;
  }

  /** Asynchronous on purpose: the runner registers through RunnerLink, which answers on this process's event loop. */
  async register({ server, token, name }) {
    const args = ['register', '--server', server, '--token', token, '--name', name, '--workdir', this.work, '--no-service', '--no-auto-install-engines'];
    const { code, output } = await new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { env: this.env, cwd: this.work, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (chunk) => (text += chunk));
      child.stderr.on('data', (chunk) => (text += chunk));
      const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
      child.once('error', reject);
      child.once('exit', (exitCode) => {
        clearTimeout(timer);
        resolve({ code: exitCode, output: text });
      });
    });
    this.log(`$ orbit register\n${output}\n`);
    if (code !== 0) throw new Error(`orbit register exited ${code}:\n${output}`);
    this.config = JSON.parse(readFileSync(path.join(this.orbitHome, 'config.json'), 'utf8'));
    return this.config;
  }

  start() {
    this.starts += 1;
    this.log(`\n==> orbit run (start ${this.starts})\n`);
    const child = spawn(this.binary, ['run'], { env: this.env, cwd: this.work, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => this.log(chunk));
    child.stderr.on('data', (chunk) => this.log(chunk));
    this.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    this.child = child;
    this.paused = false;
  }

  alive() {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  pause() {
    process.kill(this.child.pid, 'SIGSTOP');
    this.paused = true;
  }

  resume() {
    if (!this.paused) return;
    process.kill(this.child.pid, 'SIGCONT');
    this.paused = false;
  }

  async stop() {
    if (!this.alive()) return;
    this.resume();
    this.child.kill('SIGTERM');
    const exited = await Promise.race([this.exited, sleep(60_000).then(() => null)]);
    if (!exited) {
      this.child.kill('SIGKILL');
      await this.exited;
    }
  }

  /** The PATH `orbit run` actually ended up with, after its own login-shell and engine-dir resolution. */
  effectivePath() {
    const environ = readFileSync(`/proc/${this.child.pid}/environ`, 'utf8').split('\0');
    return (environ.find((entry) => entry.startsWith('PATH=')) ?? 'PATH=').slice('PATH='.length);
  }
}

/** The file `name` resolves to on a PATH, the way exec.LookPath finds it. */
export function lookPath(searchPath, name) {
  for (const dir of searchPath.split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

// ── the database, sampled ──────────────────────────────────────────────────────────────────────

const iso = (column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const OPERATION_COLUMNS = `
  id::text AS "id", owner_id::text AS "ownerId", runner_id::text AS "runnerId",
  account_fingerprint AS "accountFingerprint", client_request_id::text AS "clientRequestId",
  provider_idempotency_key::text AS "providerIdempotencyKey", consume_state AS "consumeState",
  consume_outcome AS "consumeOutcome", refresh_state AS "refreshState", failure_code AS "failureCode",
  last_error_code AS "lastErrorCode", claim_lease_owner::text AS "claimLeaseOwner",
  claim_generation AS "claimGeneration", ${iso('claimed_at')} AS "claimedAt",
  claims_with_unknown_call AS "claimsWithUnknownCall", ${iso('created_at')} AS "createdAt",
  ${iso('updated_at')} AS "updatedAt", ${iso('consume_confirmed_at')} AS "consumeConfirmedAt",
  ${iso('completed_at')} AS "completedAt"`;

const RANK = {
  PENDING: 0,
  CONSUMING: 1,
  REFRESHING: 2,
  SUCCEEDED: 3,
  REFRESH_FAILED: 3,
  NOTHING_TO_RESET: 3,
  NO_CREDIT: 3,
  NOT_ATTEMPTED: 3,
  UNRESOLVED: 3,
};
const IMMUTABLE = ['id', 'ownerId', 'runnerId', 'accountFingerprint', 'clientRequestId', 'providerIdempotencyKey', 'createdAt'];

/** Every operation row and the stored reset block, every 150ms, kept only when they change. */
export class DbWatch {
  constructor({ client, shared, runnerId }) {
    this.client = client;
    this.shared = shared;
    this.runnerId = runnerId;
    this.traces = new Map();
    this.blocks = [];
    this.moved = new Map();
    this.errors = [];
    this.running = false;
  }

  async sample() {
    const { rows } = await this.client.query(`SELECT ${OPERATION_COLUMNS} FROM codex_rate_limit_reset_operation ORDER BY created_at, id`);
    const at = Date.now();
    for (const row of rows) {
      const trace = this.traces.get(row.id) ?? [];
      if (trace.length === 0 || JSON.stringify(trace.at(-1).row) !== JSON.stringify(row)) {
        trace.push({ at, row, status: this.shared.codexResetOperationStatus(row) });
      }
      this.traces.set(row.id, trace);
    }
    const runner = await this.client.query('SELECT plan_usage AS "planUsage" FROM runner WHERE id = $1', [this.runnerId]);
    const block = this.shared.codexRateLimitResetOf(runner.rows[0]?.planUsage ?? null) ?? null;
    if (block && JSON.stringify(block) !== JSON.stringify(this.blocks.at(-1)?.block)) this.blocks.push({ at, block });
    return rows;
  }

  start() {
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        await this.sample().catch((error) => this.errors.push(error.message));
        await sleep(150);
      }
    })();
  }

  async stop() {
    this.running = false;
    await this.loop;
  }

  /** A column this harness moves on purpose (time that is waited for in production); it is not a regression. */
  allowMove(operationId, field) {
    const fields = this.moved.get(operationId) ?? new Set();
    fields.add(field);
    this.moved.set(operationId, fields);
  }

  /** The first value a column showed for an operation, before any move. */
  firstSeen(operationId, field) {
    return (this.traces.get(operationId) ?? []).map((sample) => sample.row[field]).find((value) => value !== null) ?? null;
  }

  violations() {
    const found = [];
    for (const [id, trace] of this.traces) {
      const moved = this.moved.get(id) ?? new Set();
      for (let i = 1; i < trace.length; i += 1) {
        const [before, after] = [trace[i - 1], trace[i]];
        const where = `operation ${id} sample ${i} (${before.status} -> ${after.status})`;
        if (RANK[after.status] === undefined || RANK[after.status] < RANK[before.status]) found.push(`${where}: status moved backwards or is unknown`);
        for (const field of IMMUTABLE) {
          if (!moved.has(field) && after.row[field] !== before.row[field]) found.push(`${where}: ${field} changed`);
        }
        if (after.row.claimGeneration < before.row.claimGeneration) found.push(`${where}: claim generation went down`);
        if (before.row.consumeOutcome !== null && after.row.consumeOutcome !== before.row.consumeOutcome) found.push(`${where}: outcome rewritten`);
        if (before.row.consumeConfirmedAt !== null && !moved.has('consumeConfirmedAt') && after.row.consumeConfirmedAt !== before.row.consumeConfirmedAt) {
          found.push(`${where}: consume confirmation rewritten`);
        }
        if (before.row.completedAt !== null && JSON.stringify(after.row) !== JSON.stringify(before.row)) found.push(`${where}: a settled operation changed`);
      }
    }
    for (let i = 1; i < this.blocks.length; i += 1) {
      const [older, newer] = [this.blocks[i - 1].block, this.blocks[i].block];
      const [a, b] = [Date.parse(older.fetchedAt), Date.parse(newer.fetchedAt)];
      const forwards = b > a || (b === a && older.generation === newer.generation && newer.sequence > older.sequence);
      if (!forwards) {
        found.push(
          `stored block ${i} (${newer.fetchedAt} ${newer.generation}#${newer.sequence}) replaced a block that was not older (${older.fetchedAt} ${older.generation}#${older.sequence})`,
        );
      }
    }
    return found;
  }
}

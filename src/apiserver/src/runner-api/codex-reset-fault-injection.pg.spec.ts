/**
 * Fault injection for Codex rate-limit reset operations, across the real control plane and the real runner
 * (docs/codex-rate-limit-reset-runbook.md §5; scripts/test-codex-reset-fault-injection.sh).
 *
 * WHAT IS REAL
 * ------------
 *   * The control plane: RunnerApiController's heartbeat and result routes over a disposable PostgreSQL, with the
 *     real admission service, relay, planUsage compare-and-set, 0255 guard trigger, logger and metrics.
 *   * Each runner process: this repository's Go runner — its Transport, usage probe, reset relay and consume — in
 *     the fault-process test binary (src/runner-go/codex_rate_limit_reset_fault_process_test.go), driven one command
 *     at a time and killed with SIGKILL to crash. A process's timeouts, call freshness and backoffs are shortened;
 *     its deadlines, windows and rules are the runner's own.
 *   * Its Codex: the consume tests' programmable fake app-server. Its credits and redeemed keys live in a file and
 *     every request it hears is logged with a timestamp, so the provider's ledger is the ground truth each scenario
 *     is checked against.
 *   * Between them, a proxy that drops a request or its answer, sends it twice, holds it, or answers 503.
 *
 * Time the control plane counts in minutes is moved on the operation row instead of waited for: `claimed_at` by
 * UPDATE, and the immutable `created_at` / `consume_confirmed_at` by an UPDATE made with the guard trigger
 * bypassed for that one statement. Nothing else about a row is ever written by this file.
 *
 * WHAT EVERY SCENARIO ENDS IN (Scene.finish)
 * ------------------------------------------
 *   1. The operation settled in the status the scenario expects, and another round of reads and heartbeats — then
 *      stopping every process — changes nothing about it.
 *   2. Every sample of the row moved only forwards: status rank, claim generation, recorded outcome and
 *      confirmation, and the key, request id, runner, owner and account never changed.
 *   3. The provider's ledger: every consume call carried exactly the operation's key, as many calls as expected, at
 *      most one credit spent and one key redeemed, and no consume call after the consume was confirmed.
 *   4. The key crossed the wire only inside CONSUME commands: never in a result, a receipt or a REFRESH command.
 *   5. Every stored reset block was accepted over the one before it: no older read ever took a newer one back.
 *   6. The control plane's `codex-reset` lines for the operation hold its admission, delivery and receipt stages and
 *      a receipt for every result; the runners' `consume/calling` lines count exactly the calls the provider heard.
 *   7. No log line of either side, and nothing a process answered, carries the provider key, the runner token, an
 *      account id, the email, the account fingerprint, the fingerprint key or a runner environment value.
 * With ORBIT_CODEX_RESET_FAULT_REPORT set, each scenario appends what it found there as one JSON line.
 * ORBIT_CODEX_RESET_FAULT_ONLY=F13,F22 registers only those scenarios (the rest are not skipped: they do not
 * exist in that run), and ORBIT_CODEX_RESET_FAULT_DEBUG_DIR keeps every scenario's process logs and exchanges.
 *
 * Needs COORDINATOR_PG_URL (scripts/run-pg-spec.sh provides a disposable one) and Go; without the URL every case
 * reports as skipped, which that script counts as red. Nothing here reaches a real Codex account or credit.
 */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ConflictException, Module, ValidationPipe, type INestApplication, type LoggerService } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { PrismaClient } from '@prisma/client';
import {
  CODEX_ACCOUNT_READ_METHOD,
  CODEX_RATE_LIMIT_RESET_CONSUME_METHOD,
  CODEX_RATE_LIMITS_READ_METHOD,
  codexRateLimitResetOf,
  codexResetOperationStatus,
  codexResetSnapshotAccepted,
  orderCodexResetSnapshot,
  type CodexRateLimitResetOperationState,
  type PlanUsage,
  type PlanUsageRateLimitReset,
} from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AttemptBudgetMeterService } from '../projects/attempt-budget-meter.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { codexResetMetricsSnapshot, resetCodexResetMetrics } from '../runners/codex-reset-metrics';
import { CodexRateLimitResetRepository } from '../runners/codex-rate-limit-reset.repository';
import { CodexRateLimitResetService } from '../runners/codex-rate-limit-reset.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { ListEventsService } from '../task-lists/list-events.service';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { TasksService } from '../tasks/tasks.service';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;
const REPORT = process.env.ORBIT_CODEX_RESET_FAULT_REPORT;
const DEBUG_DIR = process.env.ORBIT_CODEX_RESET_FAULT_DEBUG_DIR;
const ONLY = process.env.ORBIT_CODEX_RESET_FAULT_ONLY
  ? new Set(process.env.ORBIT_CODEX_RESET_FAULT_ONLY.split(',').map((id) => id.trim()))
  : null;

const REPO = path.resolve(__dirname, '../../../..');
const RUNNER_GO = path.join(REPO, 'src/runner-go');
const ACCOUNT_ID = 'acct_fault_primary';
const OTHER_ACCOUNT_ID = 'acct_fault_other';
const EMAIL = 'fault-primary@example.invalid';
/** An environment value every runner process carries and no line may repeat. */
const ENV_SENTINEL = 'orbit-fault-env-sentinel-3f9c2a7e61';
const CONSUME = CODEX_RATE_LIMIT_RESET_CONSUME_METHOD;
const RATE_LIMITS_READ = CODEX_RATE_LIMITS_READ_METHOD;
/** A process's shortened budgets: the runner's rules, on a clock a test can wait for. */
const PROCESS_TUNING = {
  ORBIT_CODEX_RESET_FAULT_CONSUME_TIMEOUT_MS: '1500',
  ORBIT_CODEX_RESET_FAULT_ATTEMPT_TIMEOUT_MS: '10000',
  ORBIT_CODEX_RESET_FAULT_CALL_FRESHNESS_MS: '3000',
  ORBIT_CODEX_RESET_FAULT_BACKOFF_SCALE: '0.1',
};
const CALL_FRESHNESS_MS = Number(PROCESS_TUNING.ORBIT_CODEX_RESET_FAULT_CALL_FRESHNESS_MS);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type State = CodexRateLimitResetOperationState;

// ── the control plane ──────────────────────────────────────────────────────────────────────────

interface LogEntry {
  level: string;
  message: string;
  params: string[];
}

/** Every line the served routes and the admission service log, as the server would have written it. */
class CaptureLogger implements LoggerService {
  readonly entries: LogEntry[] = [];
  private keep(level: string, message: unknown, params: unknown[]): void {
    const text = (part: unknown) => (typeof part === 'string' ? part : (JSON.stringify(part) ?? String(part)));
    this.entries.push({ level, message: text(message), params: params.map(text) });
  }
  log(message: unknown, ...params: unknown[]): void {
    this.keep('log', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.keep('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.keep('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.keep('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.keep('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.keep('fatal', message, params);
  }
  text(): string {
    return this.entries.map((entry) => [entry.level, entry.message, ...entry.params].join(' ')).join('\n');
  }
}

async function boot(prisma: PrismaClient, port: number, logger: LoggerService): Promise<INestApplication> {
  const realtime = {
    drainCancellations: async () => [],
    drainArtifactRequests: async () => [],
    publishSessionUpdated: () => undefined,
  };
  @Module({
    controllers: [RunnerApiController],
    providers: [
      RunnerAuthGuard,
      { provide: PrismaService, useValue: prisma },
      { provide: QueueService, useValue: {} },
      { provide: RealtimeService, useValue: realtime },
      { provide: PushService, useValue: {} },
      { provide: RunnerOrchestrationAuthorizer, useValue: {} },
      { provide: ReferenceExpansionService, useValue: {} },
      { provide: ListEventsService, useValue: {} },
      { provide: AttemptBudgetMeterService, useValue: {} },
      { provide: ProjectAcceptanceService, useValue: {} },
      { provide: TasksService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
    ],
  })
  class RunnerRoutes {}

  const app = await NestFactory.create(RunnerRoutes, { logger, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const adapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
  await app.listen(port, '127.0.0.1');
  return app;
}

// ── the proxy ──────────────────────────────────────────────────────────────────────────────────

type Route = 'heartbeat' | 'result' | 'other';
type Action = 'drop-request' | 'drop-response' | 'duplicate' | 'hold' | 'unavailable';

interface Exchange {
  seq: number;
  at: number;
  route: Route;
  process: string | null;
  request: Json;
  raw: string;
  fault: Action | null;
  status: number | null;
  response: Json;
}

interface RuleSpec {
  route: Route;
  action: Action;
  times?: number;
  when?: (request: Json) => boolean;
  /** Decided on the control plane's answer, after forwarding: drop-response only. */
  whenResponse?: (response: Json) => boolean;
}

class Rule {
  hits = 0;
  private disabled = false;
  private released = false;
  private readonly held: Array<() => void> = [];

  constructor(readonly spec: RuleSpec) {}

  matches(route: Route, request: Json): boolean {
    return !this.disabled && this.spec.route === route && this.hits < (this.spec.times ?? 1) && (!this.spec.when || this.spec.when(request));
  }

  async hold(): Promise<void> {
    if (!this.released) await new Promise<void>((resume) => this.held.push(resume));
  }

  release(): void {
    this.released = true;
    for (const resume of this.held.splice(0)) resume();
  }

  disable(): void {
    this.disabled = true;
    this.release();
  }

  waitHits(n = 1): Promise<void> {
    return eventually(`a ${this.spec.action} fault on ${this.spec.route} was hit ${n} time(s)`, async () => this.hits >= n);
  }
}

interface Forwarded {
  status: number;
  text: string;
  contentType: string;
}

class FaultProxy {
  readonly exchanges: Exchange[] = [];
  private readonly rules: Rule[] = [];
  private server?: Server;
  private seq = 0;

  constructor(private readonly upstream: () => string) {}

  async listen(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const rule of this.rules) rule.disable();
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  rule(spec: RuleSpec): Rule {
    const rule = new Rule(spec);
    this.rules.push(rule);
    return rule;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await new Promise<string>((resolve) => {
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (text += chunk));
      req.on('end', () => resolve(text));
    });
    const route: Route = req.url?.endsWith('/runner/heartbeat')
      ? 'heartbeat'
      : req.url?.endsWith('/runner/codex-rate-limit-reset-result')
        ? 'result'
        : 'other';
    let request: Json = null;
    try {
      request = JSON.parse(raw);
    } catch {
      request = null;
    }
    const exchange: Exchange = {
      seq: ++this.seq,
      at: Date.now(),
      route,
      process: typeof request?.leaseOwner === 'string' ? request.leaseOwner : null,
      request,
      raw,
      fault: null,
      status: null,
      response: null,
    };
    this.exchanges.push(exchange);
    const rule = this.rules.find((candidate) => !candidate.spec.whenResponse && candidate.matches(route, request));
    if (rule) {
      rule.hits += 1;
      exchange.fault = rule.spec.action;
    }
    switch (rule?.spec.action) {
      case 'drop-request':
        req.socket.destroy();
        return;
      case 'unavailable':
        this.answer(res, exchange, { status: 503, text: '{"statusCode":503,"message":"fault injection: unavailable"}', contentType: 'application/json' });
        return;
      case 'hold':
        await rule.hold();
        break;
      case 'duplicate':
        await this.forward(req, raw).catch(() => undefined);
        break;
      default:
        break;
    }
    let forwarded: Forwarded;
    try {
      forwarded = await this.forward(req, raw);
    } catch {
      this.answer(res, exchange, { status: 502, text: '{"statusCode":502,"message":"fault injection: unreachable"}', contentType: 'application/json' });
      return;
    }
    exchange.status = forwarded.status;
    try {
      exchange.response = JSON.parse(forwarded.text);
    } catch {
      exchange.response = null;
    }
    const late = this.rules.find(
      (candidate) => candidate.spec.whenResponse && candidate.matches(route, request) && candidate.spec.whenResponse(exchange.response),
    );
    if (late) {
      late.hits += 1;
      exchange.fault = late.spec.action;
    }
    if (late || rule?.spec.action === 'drop-response') {
      res.socket?.destroy();
      return;
    }
    this.answer(res, exchange, forwarded);
  }

  private answer(res: ServerResponse, exchange: Exchange, forwarded: Forwarded): void {
    exchange.status = forwarded.status;
    if (res.socket?.destroyed) return;
    res.writeHead(forwarded.status, { 'content-type': forwarded.contentType });
    res.end(forwarded.text);
  }

  private forward(req: IncomingMessage, raw: string): Promise<Forwarded> {
    return new Promise((resolve, reject) => {
      const target = new globalThis.URL(req.url ?? '/', this.upstream());
      const headers: IncomingHttpHeaders = { ...req.headers, host: target.host, 'content-length': String(Buffer.byteLength(raw)) };
      delete headers.connection;
      const outgoing = httpRequest(target, { method: req.method, headers, agent: false }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, text, contentType: String(response.headers['content-type'] ?? 'application/json') }),
        );
        response.on('error', reject);
      });
      outgoing.on('error', reject);
      outgoing.end(raw);
    });
  }
}

// ── the runner processes ───────────────────────────────────────────────────────────────────────

let faultBinary: Promise<string> | undefined;

/** The Go fault-process binary: as scripts/test-codex-reset-fault-injection.sh built it, or built here once. */
function faultProcessBinary(): Promise<string> {
  const prebuilt = process.env.ORBIT_CODEX_RESET_FAULT_BINARY;
  if (prebuilt) return Promise.resolve(prebuilt);
  faultBinary ??= new Promise((resolve, reject) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-reset-fault-go-'));
    const binary = path.join(dir, 'runner-go-fault.test');
    execFile('go', ['test', '-c', '-tags', 'codexresetfault', '-o', binary, '.'], { cwd: RUNNER_GO, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(`building the fault process failed: ${error.message}\n${stdout}${stderr}`)) : resolve(binary),
    );
  });
  return faultBinary;
}

interface Answer {
  id: number;
  ok?: boolean;
  error?: string;
  [field: string]: Json;
}

class RunnerProcess {
  leaseOwner = '';
  stdout = '';
  stderr = '';
  exited = false;
  private readonly waiting = new Map<number, (answer: Answer) => void>();
  private nextId = 1;
  private readonly exit: Promise<void>;
  private readonly ready: Promise<Answer>;

  constructor(
    readonly name: string,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    this.ready = new Promise((resolve) => this.waiting.set(0, resolve));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (this.stdout += chunk));
    let pending = '';
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
      pending += chunk;
      for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const at = line.indexOf('FAULTPROC ');
        if (at < 0) continue;
        const answer = JSON.parse(line.slice(at + 'FAULTPROC '.length)) as Answer;
        const resolve = this.waiting.get(answer.id);
        this.waiting.delete(answer.id);
        resolve?.(answer);
      }
    });
    this.exit = new Promise((resolve) =>
      child.on('exit', () => {
        this.exited = true;
        for (const resolve of this.waiting.values()) resolve({ id: -1, ok: false, error: 'exited' });
        this.waiting.clear();
        resolve();
      }),
    );
  }

  async started(): Promise<this> {
    const ready = await Promise.race([this.ready, sleep(60_000, null, { ref: false })]);
    assert.ok(ready?.ready, `${this.name} did not start:\n${this.stdout}\n${this.stderr}`);
    this.leaseOwner = ready.leaseOwner;
    return this;
  }

  send(cmd: string, fields: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<Answer> {
    if (this.exited) return Promise.resolve({ id: -1, ok: false, error: 'exited' });
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${this.name}: no answer to ${cmd} in ${timeoutMs}ms\n${this.stderr.slice(-3000)}`));
      }, timeoutMs);
      this.waiting.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.child.stdin.write(`${JSON.stringify({ id, cmd, ...fields })}\n`);
    });
  }

  heartbeat(fields: { draining?: boolean; drainingOnReceipt?: boolean; capable?: boolean; leaseOwner?: boolean } = {}): Promise<Answer> {
    return this.send('heartbeat', fields);
  }

  probe(): Promise<Answer> {
    return this.send('probe');
  }

  async idle(timeoutMs = 30_000): Promise<boolean> {
    return (await this.send('idle', { timeoutMs }, timeoutMs + 15_000)).idle === true;
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    await this.send('stop', {}, 60_000).catch(() => undefined);
    this.child.stdin.end();
    await Promise.race([this.exit, sleep(30_000, undefined, { ref: false })]);
    if (!this.exited) await this.crash();
  }

  async crash(): Promise<void> {
    if (this.exited) return;
    this.child.kill('SIGKILL');
    await this.exit;
  }

  /** The `codex-reset` lines this process logged, decoded. */
  lines(): Json[] {
    return resetLines(this.stdout.split('\n'));
  }
}

function resetLines(texts: readonly string[]): Json[] {
  const out: Json[] = [];
  for (const text of texts) {
    const at = text.indexOf('codex-reset {');
    if (at >= 0) out.push(JSON.parse(text.slice(at + 'codex-reset '.length)));
  }
  return out;
}

// ── a scenario ─────────────────────────────────────────────────────────────────────────────────

interface Machine {
  id: string;
  ownerId: string;
  token: string;
}

interface Expect {
  status: string;
  failureCode?: string | null;
  outcome?: string | null;
  claimGeneration?: number;
  consumeCalls: number;
  spent: number;
  /** Stages the control plane's lines for the operation must hold; admission, delivery and receipt by default. */
  serverStages?: string[];
}

const RANK: Readonly<Record<string, number>> = {
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

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

class Scene {
  readonly processes: RunnerProcess[] = [];
  readonly trace: State[] = [];
  readonly blocks: PlanUsageRateLimitReset[] = [];
  readonly faults: string[] = [];
  op!: State;
  initialCredits = 0;
  /** The first consumeConfirmedAt the row showed, before any time was moved. */
  confirmedAt: string | null = null;
  private readonly moved = new Set<keyof State>();
  private sampling = false;
  private sampler?: Promise<void>;

  constructor(
    readonly name: string,
    readonly prisma: PrismaClient,
    readonly sql: Client,
    readonly admission: CodexRateLimitResetService,
    readonly logs: CaptureLogger,
    readonly proxy: FaultProxy,
    readonly origin: string,
    readonly restartControlPlane: () => Promise<void>,
    readonly machine: Machine,
    readonly dir: string,
  ) {}

  get providerDir(): string {
    return path.join(this.dir, 'provider');
  }

  get orbitHome(): string {
    return path.join(this.dir, 'machine', 'orbit');
  }

  note(fault: string): void {
    this.faults.push(fault);
  }

  /** A runner process of this machine: its own leaseOwner, the machine's home and fingerprint key, the fake Codex. */
  async start(name: string): Promise<RunnerProcess> {
    const binary = await faultProcessBinary();
    const child = spawn(binary, ['-test.run', '^TestCodexResetFaultProcess$', '-test.v', '-test.count', '1'], {
      cwd: RUNNER_GO,
      env: {
        PATH: `${path.join(this.dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: path.join(this.dir, 'machine', 'home'),
        ORBIT_HOME: this.orbitHome,
        CODEX_HOME: path.join(this.dir, 'machine', 'codex'),
        ORBIT_CODEX_RESET_FAULT_URL: this.origin,
        ORBIT_CODEX_RESET_FAULT_TOKEN: this.machine.token,
        ORBIT_FAULT_ENV_SENTINEL: ENV_SENTINEL,
        ...PROCESS_TUNING,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const runner = new RunnerProcess(name, child);
    this.processes.push(runner);
    return runner.started();
  }

  live(): RunnerProcess[] {
    return this.processes.filter((runner) => !runner.exited);
  }

  /** The fake provider's state after applying `patch` (codexResetProviderState fields) under its lock. */
  async provider(patch: Record<string, unknown> = {}): Promise<Json> {
    const binary = await faultProcessBinary();
    const stderr = await new Promise<string>((resolve, reject) =>
      execFile(
        binary,
        ['-test.run', '^TestCodexResetFaultProvider$', '-test.count', '1'],
        {
          cwd: RUNNER_GO,
          env: {
            PATH: process.env.PATH ?? '',
            ORBIT_CODEX_RESET_FAULT_PROVIDER_DIR: this.providerDir,
            ORBIT_CODEX_RESET_FAULT_PROVIDER_PATCH: JSON.stringify(patch),
          },
        },
        (error, _stdout, errText) => (error ? reject(new Error(`patching the provider failed: ${error.message}\n${errText}`)) : resolve(errText)),
      ),
    );
    const line = stderr.split('\n').find((text) => text.startsWith('FAULTPROVIDER '));
    assert.ok(line, `the provider helper answered nothing:\n${stderr}`);
    if (Object.keys(patch).length > 0) this.note(`provider ${Object.keys(patch).join(', ')}`);
    return JSON.parse(line.slice('FAULTPROVIDER '.length));
  }

  /** Every request the fake app-servers heard, in order. */
  ledger(): Json[] {
    const file = path.join(this.providerDir, 'events.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }

  consumeCalls(): Json[] {
    return this.ledger().filter((event) => event.src === 'app' && event.method === CONSUME);
  }

  async readBlock(): Promise<PlanUsageRateLimitReset | undefined> {
    const runner = await this.prisma.runner.findUniqueOrThrow({ where: { id: this.machine.id }, select: { planUsage: true } });
    return codexRateLimitResetOf(runner.planUsage as PlanUsage | null);
  }

  async row(id = this.op.id): Promise<State> {
    const { rows } = await this.sql.query<State>(
      `SELECT id::text AS "id", owner_id::text AS "ownerId", runner_id::text AS "runnerId",
              account_fingerprint AS "accountFingerprint", client_request_id::text AS "clientRequestId",
              provider_idempotency_key::text AS "providerIdempotencyKey", consume_state AS "consumeState",
              consume_outcome AS "consumeOutcome", refresh_state AS "refreshState", failure_code AS "failureCode",
              last_error_code AS "lastErrorCode", claim_lease_owner::text AS "claimLeaseOwner",
              claim_generation AS "claimGeneration", ${iso('claimed_at')} AS "claimedAt",
              claims_with_unknown_call AS "claimsWithUnknownCall", ${iso('created_at')} AS "createdAt",
              ${iso('updated_at')} AS "updatedAt", ${iso('consume_confirmed_at')} AS "consumeConfirmedAt",
              ${iso('completed_at')} AS "completedAt"
         FROM codex_rate_limit_reset_operation WHERE id = $1`,
      [id],
    );
    assert.equal(rows.length, 1, `operation ${id} is not stored`);
    return rows[0];
  }

  /** A confirmation against the stored block's account; the operation it creates is the scenario's. */
  async confirm(): Promise<State> {
    const created = await this.tryConfirm();
    assert.ok(created.created, `the confirmation was refused: ${created.refusal}`);
    this.op = created.created;
    this.initialCredits = (await this.provider()).availableCount;
    this.sampling = true;
    this.sampler = this.sample();
    return this.op;
  }

  async tryConfirm(): Promise<{ created?: State; refusal?: string }> {
    const block = await this.readBlock();
    assert.ok(block?.accountFingerprint, 'no stored block names the account yet: probe and heartbeat first');
    try {
      const created = await this.admission.create(this.machine.ownerId, this.machine.id, {
        clientRequestId: randomUUID(),
        accountFingerprint: block.accountFingerprint,
      });
      return { created: await this.row(created.operation.id) };
    } catch (error) {
      if (error instanceof ConflictException) return { refusal: (error.getResponse() as { code: string }).code };
      throw error;
    }
  }

  /** Moves the operation's clock: `claimed_at` as an ordinary write, the immutable timestamps past the guard. */
  async age(column: 'claimed_at' | 'created_at' | 'consume_confirmed_at', seconds: number): Promise<void> {
    this.note(`${column} moved back ${seconds}s`);
    if (column === 'claimed_at') {
      await this.sql.query(`UPDATE codex_rate_limit_reset_operation SET claimed_at = claimed_at - make_interval(secs => $2) WHERE id = $1`, [
        this.op.id,
        seconds,
      ]);
      return;
    }
    this.moved.add(column === 'created_at' ? 'createdAt' : 'consumeConfirmedAt');
    await this.sql.query('BEGIN');
    try {
      await this.sql.query(`SET LOCAL session_replication_role = replica`);
      await this.sql.query(`UPDATE codex_rate_limit_reset_operation SET ${column} = ${column} - make_interval(secs => $2) WHERE id = $1`, [
        this.op.id,
        seconds,
      ]);
      await this.sql.query('COMMIT');
    } catch (error) {
      await this.sql.query('ROLLBACK');
      throw error;
    }
  }

  async until(what: string, check: () => Promise<boolean> | boolean, timeoutMs = 45_000): Promise<void> {
    await eventually(`${this.name}: ${what}`, async () => check(), timeoutMs);
  }

  resultsSent(kind: string): Exchange[] {
    return this.proxy.exchanges.filter((exchange) => exchange.route === 'result' && exchange.request?.kind === kind);
  }

  /** Ends the sampling, whether or not the scenario got as far as finish(): a sampler left looping keeps the file alive. */
  async stopSampling(): Promise<void> {
    this.sampling = false;
    await this.sampler;
  }

  /** The row and the stored block, every 25ms while the scenario runs. */
  private async sample(): Promise<void> {
    while (this.sampling) {
      const row = await this.row().catch(() => undefined);
      if (row && JSON.stringify(row) !== JSON.stringify(this.trace.at(-1))) {
        this.trace.push(row);
        if (this.confirmedAt === null && row.consumeConfirmedAt !== null && !this.moved.has('consumeConfirmedAt')) {
          this.confirmedAt = row.consumeConfirmedAt;
        }
      }
      const block = await this.readBlock().catch(() => undefined);
      if (block && JSON.stringify(block) !== JSON.stringify(this.blocks.at(-1))) this.blocks.push(block);
      await sleep(25);
    }
  }

  /** Keeps what the scenario's processes, proxy and provider saw, when ORBIT_CODEX_RESET_FAULT_DEBUG_DIR asks. */
  keepForDebugging(): void {
    if (!DEBUG_DIR) return;
    const into = path.join(DEBUG_DIR, this.name.replace(/[^A-Za-z0-9]+/g, '-'));
    mkdirSync(into, { recursive: true });
    for (const runner of this.processes) {
      writeFileSync(path.join(into, `${runner.name}.stdout`), runner.stdout);
      writeFileSync(path.join(into, `${runner.name}.stderr`), runner.stderr);
    }
    writeFileSync(path.join(into, 'control-plane.log'), this.logs.text());
    writeFileSync(path.join(into, 'exchanges.json'), JSON.stringify(this.proxy.exchanges, null, 2));
    writeFileSync(path.join(into, 'rows.json'), JSON.stringify(this.trace, null, 2));
    const ledger = path.join(this.providerDir, 'events.jsonl');
    if (existsSync(ledger)) copyFileSync(ledger, path.join(into, 'ledger.jsonl'));
  }

  async finish(expect: Expect): Promise<void> {
    // 1. Settled, and stable under another round of reads and heartbeats and under every process stopping.
    for (const runner of this.live()) await runner.idle(3_000);
    const settled = await this.row();
    assert.notEqual(settled.completedAt, null, `${this.name}: the operation did not settle (${codexResetOperationStatus(settled)})`);
    const survivor = this.live().at(-1) ?? (await this.start('stability'));
    await survivor.probe();
    await survivor.heartbeat();
    await survivor.heartbeat();
    await survivor.idle(3_000);
    for (const runner of this.live()) await runner.stop();
    await this.stopSampling();
    const final = await this.row();
    assert.deepEqual(final, settled, `${this.name}: a settled operation changed on a later heartbeat or a stop`);
    assert.equal(codexResetOperationStatus(final), expect.status, `${this.name}: settled ${codexResetOperationStatus(final)}`);
    if (expect.failureCode !== undefined) assert.equal(final.failureCode, expect.failureCode, `${this.name}: failure code`);
    if (expect.outcome !== undefined) assert.equal(final.consumeOutcome, expect.outcome, `${this.name}: consume outcome`);
    if (expect.claimGeneration !== undefined) assert.equal(final.claimGeneration, expect.claimGeneration, `${this.name}: claim generation`);

    // 2. Only forwards, sample by sample.
    const trace = [this.op, ...this.trace, final];
    for (let i = 1; i < trace.length; i++) {
      const [before, after] = [trace[i - 1], trace[i]];
      const where = `${this.name}: sample ${i} (${codexResetOperationStatus(before)} -> ${codexResetOperationStatus(after)})`;
      assert.ok(RANK[codexResetOperationStatus(after)!] >= RANK[codexResetOperationStatus(before)!], `${where}: moved backwards`);
      for (const field of ['id', 'ownerId', 'runnerId', 'accountFingerprint', 'clientRequestId', 'providerIdempotencyKey', 'createdAt'] as const) {
        if (!this.moved.has(field)) assert.equal(after[field], before[field], `${where}: ${field} changed`);
      }
      assert.ok(after.claimGeneration >= before.claimGeneration, `${where}: claim generation went down`);
      if (before.consumeOutcome !== null) assert.equal(after.consumeOutcome, before.consumeOutcome, `${where}: outcome rewritten`);
      if (before.consumeConfirmedAt !== null && !this.moved.has('consumeConfirmedAt')) {
        assert.equal(after.consumeConfirmedAt, before.consumeConfirmedAt, `${where}: confirmation rewritten`);
      }
      if (before.completedAt !== null) assert.deepEqual(after, before, `${where}: a settled operation changed`);
    }

    // 3. The provider's ledger.
    const key = final.providerIdempotencyKey;
    const calls = this.consumeCalls();
    for (const call of calls) assert.deepEqual(call.params, { idempotencyKey: key }, `${this.name}: a consume call sent ${JSON.stringify(call.params)}`);
    assert.equal(calls.length, expect.consumeCalls, `${this.name}: ${calls.length} consume calls`);
    const provider = await this.provider();
    const spent = this.initialCredits - provider.availableCount;
    assert.equal(spent, expect.spent, `${this.name}: ${spent} credits spent`);
    assert.ok(
      spent <= 1 && provider.redeemed.length <= 1 && provider.redeemed.every((redeemed: string) => redeemed === key),
      `${this.name}: redeemed ${provider.redeemed.length}`,
    );
    const confirmedAt = this.confirmedAt ?? (this.moved.has('consumeConfirmedAt') ? null : final.consumeConfirmedAt);
    const millis = (at: string) => Date.parse(at.replace(/(\.\d{3})\d*Z$/, '$1Z'));
    const afterConfirmation = confirmedAt === null ? [] : calls.filter((call) => millis(call.at) > Date.parse(confirmedAt));
    assert.equal(afterConfirmation.length, 0, `${this.name}: consume called after the consume was confirmed at ${confirmedAt}: ${JSON.stringify(afterConfirmation)}`);

    // 4. The key on the wire: only inside CONSUME commands.
    for (const exchange of this.proxy.exchanges) {
      const command = exchange.response?.codexRateLimitResetRequest;
      const carriers = exchange.route === 'heartbeat' && command?.phase === 'CONSUME' && command.providerIdempotencyKey === key ? 1 : 0;
      const seen = `${exchange.raw}${JSON.stringify(exchange.response)}`.split(key).length - 1;
      assert.equal(seen, carriers, `${this.name}: the key crossed the wire outside a CONSUME command (exchange ${exchange.seq}, ${exchange.route})`);
    }

    // 5. The stored block only moved forwards.
    for (let i = 1; i < this.blocks.length; i++) {
      const order = orderCodexResetSnapshot(this.blocks[i - 1], this.blocks[i], this.blocks[i].generation, new Date());
      assert.ok(codexResetSnapshotAccepted(order), `${this.name}: stored block ${i} replaced an equal or newer one (${order})`);
    }

    // 6. Both halves of the history, under the operation's id.
    const server = resetLines(this.logs.entries.map((entry) => entry.message)).filter((line) => line.operationId === final.id);
    const stages = new Set(server.map((line) => line.stage));
    for (const stage of expect.serverStages ?? ['admission', 'delivery', 'receipt']) {
      assert.ok(stages.has(stage), `${this.name}: no ${stage} line for the operation among ${[...stages].join(', ')}`);
    }
    const results = server.filter((line) => (line.stage === 'consume' || line.stage === 'refresh') && ['applied', 'restated', 'refused'].includes(line.event));
    const receipts = server.filter((line) => line.stage === 'receipt' && line.kind !== undefined);
    assert.equal(receipts.length, results.length, `${this.name}: ${results.length} results but ${receipts.length} receipts in the control plane's lines`);
    const runnerLines: Record<string, string[]> = {};
    for (const runner of this.processes) {
      const lines = runner.lines().filter((line) => line.operationId === final.id);
      runnerLines[runner.name] = lines.map((line) => `${line.stage}/${line.event}${line.reason ? `:${line.reason}` : ''}${line.code ? `:${line.code}` : ''}`);
      if (lines.some((line) => line.stage === 'consume' && line.event === 'called')) {
        const acted = new Set(lines.map((line) => line.stage));
        for (const stage of ['delivery', 'consume', 'receipt']) assert.ok(acted.has(stage), `${this.name}: runner ${runner.name} logged no ${stage} line`);
      }
    }
    // `calling` is written before the call, so a process killed while it waited for the answer still counts.
    const callingByRunners = Object.values(runnerLines).flat().filter((line) => line === 'consume/calling').length;
    assert.equal(callingByRunners, calls.length, `${this.name}: the runners logged ${callingByRunners} consume calls, the provider heard ${calls.length}`);

    // 7. Nothing secret, anywhere either side wrote.
    const forbidden = new Map<string, string>([
      ['the provider key', key],
      ['the runner token', this.machine.token],
      ['the account id', ACCOUNT_ID],
      ['the other account id', OTHER_ACCOUNT_ID],
      ['the account email', EMAIL],
      ['a runner environment value', ENV_SENTINEL],
      ['the account fingerprint', final.accountFingerprint],
    ]);
    const keyFile = path.join(this.orbitHome, 'codex-account-fingerprint.key');
    if (existsSync(keyFile)) {
      const fingerprintKey = readFileSync(keyFile);
      forbidden.set('the fingerprint key (hex)', fingerprintKey.toString('hex'));
      forbidden.set('the fingerprint key (base64)', fingerprintKey.toString('base64'));
    }
    const texts: Array<[string, string]> = [
      ['the control plane log', this.logs.text()],
      ...this.processes.flatMap((runner): Array<[string, string]> => [
        [`runner ${runner.name} log`, runner.stdout],
        [`runner ${runner.name} answers`, runner.stderr],
      ]),
    ];
    for (const [where, text] of texts) {
      for (const [what, value] of forbidden) assert.equal(text.includes(value), false, `${this.name}: ${what} reached ${where}`);
    }

    const metrics = codexResetMetricsSnapshot();
    const statuses = trace.map((row) => codexResetOperationStatus(row)).filter((status, i, all) => i === 0 || status !== all[i - 1]);
    const entry = {
      scenario: this.name,
      faults: this.faults,
      final: {
        status: codexResetOperationStatus(final),
        failureCode: final.failureCode,
        consumeOutcome: final.consumeOutcome,
        claimGeneration: final.claimGeneration,
        claimsWithUnknownCall: final.claimsWithUnknownCall,
      },
      statusTrace: statuses,
      rowSamples: trace.length,
      consumeCalls: calls.length,
      consumeCallsAfterConfirmation: afterConfirmation.length,
      everyCallCarriedTheOperationKey: true,
      creditsSpent: spent,
      storedBlocks: this.blocks.length,
      controlPlaneLog: server.map((line) => `${line.stage}/${line.event}${line.code ? `:${line.code}` : ''}${line.status ? `->${line.status}` : ''}`),
      runnerLog: runnerLines,
      anomalies: metrics.orbit_codex_reset_anomalies_total,
      settlements: metrics.orbit_codex_reset_settlements_total,
      snapshotWrites: metrics.orbit_codex_reset_snapshot_writes_total,
      redaction: { valuesChecked: forbidden.size, textsChecked: texts.length, leaks: 0 },
    };
    const written = JSON.stringify(entry);
    for (const [what, value] of forbidden) assert.equal(written.includes(value), false, `${this.name}: ${what} reached the report`);
    if (REPORT) appendFileSync(REPORT, `${written}\n`);
  }
}

async function eventually(what: string, check: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await sleep(20);
  }
}

/**
 * One scenario's world: its control plane over the disposable database, its proxy, its runner machine — a user,
 * a runner row and token, a machine home the processes share, and the fake Codex with two credits — and process
 * A, which has read the account and heartbeated, so a confirmation can be made.
 */
async function setup(t: TestContext, name: string): Promise<{ scene: Scene; a: RunnerProcess }> {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = prismaClientFor(url);
  const db = prisma as unknown as PrismaService;
  const admission = new CodexRateLimitResetService(db, new CodexRateLimitResetRepository(db));
  const logs = new CaptureLogger();
  let served = prismaClientFor(url);
  let app = await boot(served, 0, logs);
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const upstream = `http://127.0.0.1:${port}`;
  const proxy = new FaultProxy(() => upstream);
  const origin = await proxy.listen();
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-reset-fault-'));
  resetCodexResetMetrics();

  const ownerId = randomUUID();
  await prisma.user.create({ data: { id: ownerId, email: `${ownerId}@codex-reset-fault.test`, name: 'codex reset fault', passwordHash: 'x' } });
  const machine: Machine = { id: randomUUID(), ownerId, token: `codex-reset-fault-${randomUUID()}` };
  await prisma.runner.create({ data: { id: machine.id, ownerId, name: `codex-reset-fault-${machine.id}`, tokenHash: sha256(machine.token) } });

  const scene = new Scene(
    name,
    prisma,
    sql,
    admission,
    logs,
    proxy,
    origin,
    async () => {
      await app.close();
      await served.$disconnect().catch(() => undefined);
      served = prismaClientFor(url);
      app = await boot(served, port, logs);
    },
    machine,
    dir,
  );
  t.after(async () => {
    await scene.stopSampling();
    for (const runner of scene.processes) await runner.crash();
    scene.keepForDebugging();
    await proxy.close();
    await app.close();
    await served.$disconnect().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  for (const sub of ['bin', 'provider', 'machine/home', 'machine/orbit', 'machine/codex']) mkdirSync(path.join(dir, sub), { recursive: true });
  writeFileSync(
    path.join(scene.providerDir, 'provider.json'),
    JSON.stringify({
      account: { type: 'chatgpt', email: EMAIL, planType: 'pro' },
      accountId: ACCOUNT_ID,
      noResetCredits: false,
      availableCount: 2,
      resettable: true,
      redeemed: [],
      answers: [],
      faults: [],
    }),
  );
  const binary = await faultProcessBinary();
  writeFileSync(
    path.join(dir, 'bin', 'codex'),
    `#!/bin/sh\nORBIT_FAKE_CODEX_RESET_PROVIDER='${scene.providerDir}' exec '${binary}' "$@"\n`,
    { mode: 0o755 },
  );

  const a = await scene.start('A');
  assert.equal((await a.probe()).ok, true, 'process A could not read the account');
  assert.equal((await a.heartbeat()).command, null, 'a runner with no operation is handed nothing');
  return { scene, a };
}

function command(answer: Answer, phase: 'CONSUME' | 'REFRESH', claimGeneration: number): void {
  assert.equal(answer.ok, true, `the heartbeat failed: ${answer.error}`);
  assert.ok(answer.command, 'the heartbeat carried no command');
  assert.deepEqual([answer.command.phase, answer.command.claimGeneration, answer.command.carriesKey], [phase, claimGeneration, phase === 'CONSUME']);
}

/**
 * Waits for `runner`'s steps to end while it keeps heartbeating, as the runner's own loop does every 30 seconds: a
 * step whose claim is still this process's gets it delivered again, and calls only while it does.
 */
async function settles(runner: RunnerProcess, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await runner.idle(1_000)) return;
    await runner.heartbeat();
  }
  const recent = runner
    .lines()
    .slice(-15)
    .map((line) => JSON.stringify(line))
    .join('\n');
  assert.fail(`${runner.name}'s step did not end in ${timeoutMs}ms; its last reset lines:\n${recent}`);
}

/** Registers one scenario, unless ORBIT_CODEX_RESET_FAULT_ONLY names others: then it is not part of this run at all. */
function scenario(name: string, run: (t: TestContext) => Promise<void>): void {
  const id = /^\((F\d+)\)/.exec(name)?.[1];
  if (ONLY && (!id || !ONLY.has(id))) return;
  test(name, { skip, timeout: 240_000 }, run);
}

// ── the scenarios ──────────────────────────────────────────────────────────────────────────────

scenario('(F1) baseline: one process claims, consumes once under the key and refreshes', async (t) => {
  const { scene, a } = await setup(t, 'F1 baseline');
  await scene.confirm();
  command(await a.heartbeat(), 'CONSUME', 1);
  await settles(a);
  await scene.finish({ status: 'SUCCEEDED', outcome: 'reset', consumeCalls: 1, spent: 1, serverStages: ['admission', 'delivery', 'consume', 'refresh', 'receipt'] });
});

scenario('(F2) a lost command: the claim was written, its response never arrived, the next heartbeat delivers it again', async (t) => {
  const { scene, a } = await setup(t, 'F2 command lost');
  await scene.confirm();
  const lost = scene.proxy.rule({ route: 'heartbeat', action: 'drop-response', whenResponse: (response) => response?.codexRateLimitResetRequest?.phase === 'CONSUME' });
  scene.note('heartbeat response carrying CONSUME dropped');
  assert.equal((await a.heartbeat()).ok, false);
  assert.equal(lost.hits, 1);
  const claimed = await scene.row();
  assert.deepEqual([claimed.consumeState, claimed.claimGeneration, scene.consumeCalls().length], ['CLAIMED', 1, 0]);
  command(await a.heartbeat(), 'CONSUME', 1);
  await settles(a);
  await scene.finish({ status: 'SUCCEEDED', claimGeneration: 1, consumeCalls: 1, spent: 1 });
});

scenario('(F3) a command delivered again and again while its step runs starts nothing new', async (t) => {
  const { scene, a } = await setup(t, 'F3 command duplicated');
  await scene.confirm();
  const held = scene.proxy.rule({ route: 'result', action: 'hold', when: (body) => body?.kind === 'CONSUME_OUTCOME' });
  scene.note('CONSUME_OUTCOME held while the command is delivered 3 more times');
  command(await a.heartbeat(), 'CONSUME', 1);
  await held.waitHits();
  for (let beat = 0; beat < 3; beat++) command(await a.heartbeat(), 'CONSUME', 1);
  held.release();
  await settles(a);
  const started = a.lines().filter((line) => line.stage === 'delivery' && line.event === 'started' && line.phase === 'CONSUME');
  assert.equal(started.length, 1, `${started.length} CONSUME steps started`);
  await scene.finish({ status: 'SUCCEEDED', consumeCalls: 1, spent: 1 });
});

scenario('(F4) a result lost on the way, then refused 503: sent again byte for byte and applied once', async (t) => {
  const { scene, a } = await setup(t, 'F4 result lost');
  await scene.confirm();
  scene.proxy.rule({ route: 'result', action: 'drop-request', when: (body) => body?.kind === 'CONSUME_OUTCOME' });
  scene.proxy.rule({ route: 'result', action: 'unavailable', times: 2, when: (body) => body?.kind === 'CONSUME_OUTCOME' });
  scene.note('CONSUME_OUTCOME dropped once, then answered 503 twice');
  command(await a.heartbeat(), 'CONSUME', 1);
  await settles(a);
  const sent = scene.resultsSent('CONSUME_OUTCOME');
  assert.equal(sent.length, 4);
  assert.ok(sent.every((exchange) => exchange.raw === sent[0].raw), 'a resend differs from the first');
  assert.deepEqual(sent.map((exchange) => exchange.response?.disposition ?? null), [null, null, null, 'APPLIED']);
  await scene.finish({ status: 'SUCCEEDED', consumeCalls: 1, spent: 1 });
});

scenario('(F5) a lost receipt: the result was applied, its resend is a DUPLICATE, and the refresh follows', async (t) => {
  const { scene, a } = await setup(t, 'F5 receipt lost');
  await scene.confirm();
  scene.proxy.rule({ route: 'result', action: 'drop-response', when: (body) => body?.kind === 'CONSUME_OUTCOME' });
  scene.note('the answer to CONSUME_OUTCOME dropped after it was applied');
  command(await a.heartbeat(), 'CONSUME', 1);
  await settles(a);
  assert.deepEqual(scene.resultsSent('CONSUME_OUTCOME').map((exchange) => exchange.response?.disposition), ['APPLIED', 'DUPLICATE']);
  await scene.finish({ status: 'SUCCEEDED', consumeCalls: 1, spent: 1 });
});

scenario('(F6) duplicated, reordered and late results after the outcome never move the operation', async (t) => {
  const { scene, a } = await setup(t, 'F6 late results');
  await scene.confirm();
  command(await a.heartbeat(), 'CONSUME', 1);
  await settles(a);
  const settled = await scene.row();
  assert.equal(codexResetOperationStatus(settled), 'SUCCEEDED');
  const sent = scene.proxy.exchanges.filter((exchange) => exchange.route === 'result').map((exchange) => exchange.request);
  const claim = sent[0];
  const envelope = { protocolVersion: 1, operationId: claim.operationId, leaseOwner: claim.leaseOwner, claimGeneration: claim.claimGeneration };
  const late = [
    ...sent,
    { ...envelope, phase: 'CONSUME', kind: 'CONSUME_RETRYING', code: 'PROVIDER_TIMEOUT' },
    { ...envelope, phase: 'CONSUME', kind: 'CONSUME_OUTCOME', outcome: 'nothingToReset' },
    { ...envelope, phase: 'CONSUME', kind: 'CONSUME_OUTCOME', outcome: 'alreadyRedeemed' },
    { ...envelope, phase: 'REFRESH', kind: 'REFRESH_FAILED', code: 'READ_FAILED' },
    { ...envelope, phase: 'CONSUME', kind: 'RELEASED', code: 'RUNNER_DRAINING' },
  ];
  const deck = [...late, ...late.slice().reverse(), ...late.filter((_, i) => i % 2 === 0)];
  scene.note(`${deck.length} late results replayed: every result sent, conflicting and stale ones, reversed and repeated`);
  for (const body of deck) {
    const answer = await post(scene.origin, scene.machine.token, body);
    assert.ok(
      (answer.status === 200 && answer.json.disposition === 'DUPLICATE' && answer.json.next === 'STOP') ||
        (answer.status === 409 && ['OPERATION_SETTLED', 'OUTCOME_CONFLICT'].includes(answer.json.code)),
      `a late ${body.kind} was answered ${answer.status} ${JSON.stringify(answer.json)}`,
    );
    assert.deepEqual(await scene.row(), settled, `a late ${body.kind} wrote the settled operation`);
  }
  await scene.finish({ status: 'SUCCEEDED', consumeCalls: 1, spent: 1 });
});

scenario('(F7) an app-server that never answers the consume: the call times out and is retried under the same key', async (t) => {
  const { scene, a } = await setup(t, 'F7 app-server timeout');
  await scene.provider({ faults: [{ method: CONSUME, do: 'hang' }] });
  await scene.confirm();
  command(await a.heartbeat(), 'CONSUME', 1);
  await settles(a);
  assert.deepEqual(scene.resultsSent('CONSUME_RETRYING').map((exchange) => exchange.request.code), ['PROVIDER_TIMEOUT']);
  await scene.finish({ status: 'SUCCEEDED', outcome: 'reset', consumeCalls: 2, spent: 1 });
});

scenario('(F8) an app-server that dies after the provider spent: retried, answered alreadyRedeemed, one credit', async (t) => {
  const { scene, a } = await setup(t, 'F8 app-server disconnect');
  await scene.provider({ faults: [{ method: CONSUME, do: 'spendThenExit' }] });
  await scene.confirm();
  command(await a.heartbeat(), 'CONSUME', 1);
  await settles(a);
  assert.deepEqual(scene.resultsSent('CONSUME_RETRYING').map((exchange) => exchange.request.code), ['APP_SERVER_UNAVAILABLE']);
  await scene.finish({ status: 'SUCCEEDED', outcome: 'alreadyRedeemed', consumeCalls: 2, spent: 1 });
});

scenario('(F9) the runner killed before its consume call: the successor takes the claim over and consumes once', async (t) => {
  const { scene, a } = await setup(t, 'F9 crash before consume');
  await scene.provider({ faults: [{ method: CODEX_ACCOUNT_READ_METHOD, do: 'hang' }] });
  await scene.confirm();
  command(await a.heartbeat(), 'CONSUME', 1);
  await scene.until('the step is stuck reading the account', () => scene.ledger().some((event) => event.method === CODEX_ACCOUNT_READ_METHOD && event.answer === 'hang'));
  await a.crash();
  scene.note('process A killed (SIGKILL) before calling consume');
  await scene.age('claimed_at', 61);
  const b = await scene.start('B');
  await b.probe();
  command(await b.heartbeat(), 'CONSUME', 2);
  await settles(b);
  await scene.finish({ status: 'SUCCEEDED', outcome: 'reset', claimGeneration: 2, consumeCalls: 1, spent: 1 });
});

scenario('(F10) the runner killed after the provider spent but before it heard: the successor is answered alreadyRedeemed', async (t) => {
  const { scene, a } = await setup(t, 'F10 crash after spend');
  await scene.provider({ faults: [{ method: CONSUME, do: 'spendThenHang' }] });
  await scene.confirm();
  command(await a.heartbeat(), 'CONSUME', 1);
  await scene.until('the provider spent the credit', () => scene.consumeCalls().some((event) => event.answer === 'spendThenHang'));
  await a.crash();
  scene.note('process A killed (SIGKILL) after the provider spent, before any result');
  await scene.age('claimed_at', 61);
  const b = await scene.start('B');
  await b.probe();
  command(await b.heartbeat(), 'CONSUME', 2);
  await settles(b);
  await scene.finish({ status: 'SUCCEEDED', outcome: 'alreadyRedeemed', claimGeneration: 2, consumeCalls: 2, spent: 1 });
});

scenario('(F11) the runner killed after its consume was confirmed: the successor only refreshes, and no key reaches it', async (t) => {
  const { scene, a } = await setup(t, 'F11 crash after confirmation');
  await scene.confirm();
  const held = scene.proxy.rule({ route: 'result', action: 'hold', when: (body) => body?.kind === 'REFRESHED' });
  command(await a.heartbeat(), 'CONSUME', 1);
  await held.waitHits();
  assert.equal(codexResetOperationStatus(await scene.row()), 'REFRESHING');
  await a.crash();
  scene.note('process A killed (SIGKILL) with its consume CONFIRMED and its REFRESHED held');
  await scene.age('claimed_at', 61);
  const b = await scene.start('B');
  await b.probe();
  command(await b.heartbeat(), 'REFRESH', 2);
  await settles(b);
  held.release();
  await scene.until('the held REFRESHED of the dead process was answered', () => scene.resultsSent('REFRESHED').every((exchange) => exchange.status !== null));
  assert.equal(b.lines().some((line) => line.stage === 'consume'), false, 'the successor ran a consume step');
  await scene.finish({ status: 'SUCCEEDED', claimGeneration: 2, consumeCalls: 1, spent: 1 });
});

scenario('(F12) the control plane restarted before and after the confirmation: nothing is lost and nothing repeats', async (t) => {
  const { scene, a } = await setup(t, 'F12 apiserver restarts');
  await scene.confirm();
  const outcome = scene.proxy.rule({ route: 'result', action: 'hold', when: (body) => body?.kind === 'CONSUME_OUTCOME' });
  const refreshed = scene.proxy.rule({ route: 'result', action: 'hold', when: (body) => body?.kind === 'REFRESHED' });
  command(await a.heartbeat(), 'CONSUME', 1);
  await outcome.waitHits();
  await scene.restartControlPlane();
  scene.note('control plane restarted while CONSUME_OUTCOME was in flight');
  outcome.release();
  await refreshed.waitHits();
  assert.equal(codexResetOperationStatus(await scene.row()), 'REFRESHING');
  await scene.restartControlPlane();
  scene.note('control plane restarted while REFRESHED was in flight');
  refreshed.release();
  await settles(a);
  await scene.finish({ status: 'SUCCEEDED', consumeCalls: 1, spent: 1 });
});

scenario('(F13) a refresh that fails twice is read again; the confirmed consume is not touched', async (t) => {
  const { scene, a } = await setup(t, 'F13 refresh failure');
  await scene.provider({ faults: [{ method: RATE_LIMITS_READ, skip: 1, do: 'error' }, { method: RATE_LIMITS_READ, do: 'error' }] });
  await scene.confirm();
  command(await a.heartbeat(), 'CONSUME', 1);
  await settles(a);
  assert.deepEqual(scene.resultsSent('REFRESH_FAILED').map((exchange) => exchange.request.code), ['READ_FAILED', 'READ_FAILED']);
  await scene.finish({ status: 'SUCCEEDED', outcome: 'reset', consumeCalls: 1, spent: 1 });
});

scenario('(F14) a refresh failing past its deadline settles REFRESH_FAILED, keeps the consume, and admission waits for a later read', async (t) => {
  const { scene, a } = await setup(t, 'F14 refresh deadline');
  await scene.provider({
    faults: [{ method: RATE_LIMITS_READ, skip: 1, do: 'error' }, ...Array.from({ length: 60 }, () => ({ method: RATE_LIMITS_READ, do: 'error' }))],
  });
  await scene.confirm();
  command(await a.heartbeat(), 'CONSUME', 1);
  await scene.until('the refresh is failing', async () => (await scene.row()).lastErrorCode === 'READ_FAILED');
  await scene.age('consume_confirmed_at', 601);
  assert.equal((await a.heartbeat()).command, null, 'the holder was handed a REFRESH past the refresh deadline');
  await scene.age('claimed_at', 61);
  await a.heartbeat();
  const settled = await scene.row();
  assert.deepEqual([codexResetOperationStatus(settled), settled.failureCode, settled.consumeOutcome], ['REFRESH_FAILED', 'REFRESH_EXPIRED', 'reset']);
  await settles(a, 60_000);
  assert.equal((await scene.tryConfirm()).refusal, 'SNAPSHOT_STALE', 'a new confirmation was taken on a read from before the unrefreshed spend');
  await scene.provider({ faults: [] });
  await scene.finish({ status: 'REFRESH_FAILED', failureCode: 'REFRESH_EXPIRED', outcome: 'reset', consumeCalls: 1, spent: 1 });
  const next = await scene.tryConfirm();
  assert.ok(next.created, `after a later read the confirmation was still refused: ${next.refusal}`);
});

scenario('(F15) the account switched before any claim: settled NOT_ATTEMPTED, nothing called', async (t) => {
  const { scene, a } = await setup(t, 'F15 account switch before claim');
  await scene.confirm();
  await scene.provider({ accountId: OTHER_ACCOUNT_ID });
  await a.probe();
  assert.equal((await a.heartbeat()).command, null);
  // No process was ever handed the command, so no result and no receipt exist to log.
  await scene.finish({ status: 'NOT_ATTEMPTED', failureCode: 'ACCOUNT_CHANGED', consumeCalls: 0, spent: 0, serverStages: ['admission', 'delivery'] });
});

scenario('(F16) the account switched after a call that may have spent: never NOT_ATTEMPTED, settled UNRESOLVED', async (t) => {
  const { scene, a } = await setup(t, 'F16 account switch after a possible spend');
  await scene.provider({ faults: [{ method: CONSUME, do: 'spendThenHang' }] });
  await scene.confirm();
  const retrying = scene.proxy.rule({ route: 'result', action: 'hold', when: (body) => body?.kind === 'CONSUME_RETRYING' });
  command(await a.heartbeat(), 'CONSUME', 1);
  await retrying.waitHits();
  await scene.provider({ accountId: OTHER_ACCOUNT_ID });
  retrying.release();
  await settles(a);
  assert.equal(scene.resultsSent('CONSUME_NOT_CALLED').length, 0, 'the claim that called reported CONSUME_NOT_CALLED');
  const waiting = await scene.row();
  assert.deepEqual([codexResetOperationStatus(waiting), waiting.claimsWithUnknownCall], ['CONSUMING', 1]);
  assert.ok(a.lines().some((line) => line.stage === 'consume' && line.event === 'stopped' && line.reason === 'not_called_after_a_call'));
  assert.equal((await a.heartbeat()).command, null, 'a process reading another account was handed the command');
  await scene.age('claimed_at', 61);
  await a.heartbeat();
  await scene.finish({ status: 'UNRESOLVED', failureCode: 'ACCOUNT_CHANGED', consumeCalls: 1, spent: 1 });
});

scenario('(F17) the account switched after the consume was confirmed: only the refresh fails', async (t) => {
  const { scene, a } = await setup(t, 'F17 account switch after confirmation');
  await scene.confirm();
  const outcome = scene.proxy.rule({ route: 'result', action: 'hold', when: (body) => body?.kind === 'CONSUME_OUTCOME' });
  command(await a.heartbeat(), 'CONSUME', 1);
  await outcome.waitHits();
  await scene.provider({ accountId: OTHER_ACCOUNT_ID });
  outcome.release();
  await settles(a);
  await scene.finish({ status: 'REFRESH_FAILED', failureCode: 'ACCOUNT_MISMATCH', outcome: 'reset', consumeCalls: 1, spent: 1 });
});

scenario('(F18) lease: no leaseOwner or capability claims nothing, and a second live process never takes a claim its holder renews', async (t) => {
  const { scene, a } = await setup(t, 'F18 lease');
  await scene.provider({ faults: [{ method: CONSUME, do: 'hang' }] });
  await scene.confirm();
  assert.equal((await a.heartbeat({ leaseOwner: false })).command, null, 'a heartbeat without a leaseOwner was handed the command');
  assert.equal((await a.heartbeat({ capable: false })).command, null, 'a heartbeat without the capability was handed the command');
  assert.equal((await scene.row()).claimGeneration, 0);
  const b = await scene.start('B');
  await b.probe();
  command(await a.heartbeat(), 'CONSUME', 1);
  for (let round = 1; round <= 3; round++) {
    await scene.age('claimed_at', 61);
    command(await a.heartbeat(), 'CONSUME', 1);
    assert.equal((await b.heartbeat()).command, null, `round ${round}: a second live process took over a claim its holder renewed`);
  }
  scene.note('B heartbeated 3 times, each right after A renewed a claim aged past the takeover window');
  await settles(a, 60_000);
  assert.equal(b.lines().some((line) => line.stage === 'consume'), false, 'the second process ran a consume step');
  await scene.finish({ status: 'SUCCEEDED', claimGeneration: 1, consumeCalls: 2, spent: 1 });
});

scenario('(F19) draining: an unstarted claim is handed back and taken at once by the successor', async (t) => {
  const { scene, a } = await setup(t, 'F19 draining hands back');
  await scene.confirm();
  command(await a.heartbeat({ drainingOnReceipt: true }), 'CONSUME', 1);
  scene.note('A began draining between sending its heartbeat and reading the command');
  assert.equal(await a.idle(30_000), true, "A's release did not end");
  const released = await scene.row();
  assert.deepEqual([released.claimLeaseOwner, released.claimsWithUnknownCall, released.lastErrorCode], [null, 0, 'RUNNER_DRAINING']);
  const b = await scene.start('B');
  await b.probe();
  command(await b.heartbeat(), 'CONSUME', 2);
  await settles(b);
  await scene.finish({ status: 'SUCCEEDED', claimGeneration: 2, consumeCalls: 1, spent: 1 });
});

scenario('(F20) draining after a call: the holder is handed nothing, stops calling, and its successor settles the operation', async (t) => {
  const { scene, a } = await setup(t, 'F20 draining stops calls');
  await scene.provider({ faults: [{ method: CONSUME, do: 'hang' }] });
  await scene.confirm();
  const retrying = scene.proxy.rule({ route: 'result', action: 'hold', when: (body) => body?.kind === 'CONSUME_RETRYING' });
  command(await a.heartbeat(), 'CONSUME', 1);
  await retrying.waitHits();
  assert.equal((await a.heartbeat({ draining: true })).command, null, 'a draining holder was handed the command');
  await sleep(CALL_FRESHNESS_MS + 500);
  retrying.release();
  scene.note('A draining after its first call timed out; its claim is not delivered to it again');
  await scene.until('A waits for a delivery that never comes', () => a.lines().some((line) => line.event === 'awaiting_delivery'));
  assert.equal(scene.consumeCalls().length, 1);
  await scene.age('claimed_at', 61);
  const b = await scene.start('B');
  await b.probe();
  command(await b.heartbeat(), 'CONSUME', 2);
  await settles(b);
  await scene.finish({ status: 'SUCCEEDED', claimGeneration: 2, consumeCalls: 2, spent: 1 });
  assert.equal(a.lines().filter((line) => line.stage === 'consume' && line.event === 'calling').length, 1, 'the draining process called again');
});

scenario("(F21) an old process's older read, delivered late, never takes the stored block back", async (t) => {
  const { scene, a } = await setup(t, 'F21 old snapshot race');
  await scene.confirm();
  const b = await scene.start('B');
  await b.probe();
  const late = scene.proxy.rule({ route: 'heartbeat', action: 'hold', when: (body) => body?.leaseOwner === a.leaseOwner });
  const pending = a.heartbeat();
  await late.waitHits();
  scene.note("A's heartbeat, carrying A's older read, held until B has consumed and refreshed");
  command(await b.heartbeat(), 'CONSUME', 1);
  await settles(b);
  const refreshedBlock = await scene.readBlock();
  assert.equal(refreshedBlock?.generation, b.leaseOwner);
  assert.equal(refreshedBlock?.rateLimitResetCredits?.availableCount, 1);
  late.release();
  assert.equal((await pending).command, null);
  assert.deepEqual(await scene.readBlock(), refreshedBlock, "the old process's older read took the stored block back");
  const rejected = codexResetMetricsSnapshot().orbit_codex_reset_snapshot_writes_total.filter(
    (series) => series.labels.source === 'heartbeat' && series.labels.order === 'REJECT_OLDER',
  );
  assert.ok(rejected.length === 1 && rejected[0].value >= 1, 'the older read was not counted as REJECT_OLDER');
  await scene.finish({ status: 'SUCCEEDED', consumeCalls: 1, spent: 1 });
});

scenario('(F22) a partitioned holder is taken over; back online it is refused and never calls after the confirmation', async (t) => {
  const { scene, a } = await setup(t, 'F22 partitioned holder');
  await scene.provider({ faults: [{ method: CONSUME, do: 'hang' }] });
  await scene.confirm();
  command(await a.heartbeat(), 'CONSUME', 1);
  // From its claim on, A's results and heartbeats never reach the control plane.
  const partition = [
    scene.proxy.rule({ route: 'result', action: 'drop-request', times: 10_000, when: (body) => body?.leaseOwner === a.leaseOwner }),
    scene.proxy.rule({ route: 'heartbeat', action: 'drop-request', times: 10_000, when: (body) => body?.leaseOwner === a.leaseOwner }),
  ];
  scene.note('A partitioned from the control plane right after its claim');
  await partition[0].waitHits();
  await scene.age('claimed_at', 61);
  const b = await scene.start('B');
  await b.probe();
  command(await b.heartbeat(), 'CONSUME', 2);
  await settles(b);
  for (const rule of partition) rule.disable();
  scene.note('partition healed after B confirmed');
  await scene.until("A's resent result reached the control plane", () =>
    scene.proxy.exchanges.some((exchange) => exchange.process === a.leaseOwner && exchange.route === 'result' && exchange.status === 409),
  );
  await settles(a);
  assert.ok(a.lines().some((line) => line.stage === 'receipt' && line.event === 'refused' && line.code === 'OPERATION_SETTLED'));
  await scene.finish({ status: 'SUCCEEDED', claimGeneration: 2, consumeCalls: 2, spent: 1 });
});

scenario('(F23) a consume that never gets an outcome settles UNRESOLVED at its deadline, and admission waits for a later read', async (t) => {
  const { scene, a } = await setup(t, 'F23 consume deadline');
  await scene.provider({ faults: Array.from({ length: 400 }, () => ({ method: 'initialize', do: 'exit' })) });
  await scene.confirm();
  command(await a.heartbeat(), 'CONSUME', 1);
  await scene.until('the step keeps failing to start Codex', async () => (await scene.row()).lastErrorCode === 'APP_SERVER_UNAVAILABLE');
  await scene.age('created_at', 601);
  assert.equal((await a.heartbeat()).command, null, 'the holder was handed a CONSUME past the consume deadline');
  await scene.age('claimed_at', 61);
  await a.heartbeat();
  const settled = await scene.row();
  assert.deepEqual([codexResetOperationStatus(settled), settled.failureCode], ['UNRESOLVED', 'CONSUME_EXPIRED']);
  await settles(a, 60_000);
  assert.equal((await scene.tryConfirm()).refusal, 'SNAPSHOT_STALE', 'a new confirmation was taken on a read from before the unresolved consume settled');
  await scene.provider({ faults: [] });
  await scene.finish({ status: 'UNRESOLVED', failureCode: 'CONSUME_EXPIRED', consumeCalls: 0, spent: 0 });
  const next = await scene.tryConfirm();
  assert.ok(next.created, `after a later read the confirmation was still refused: ${next.refusal}`);
});

/** One result POSTed as the runner would, through the proxy. */
function post(origin: string, token: string, body: unknown): Promise<{ status: number; json: Json }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      `${origin}/api/runner/codex-rate-limit-reset-result`,
      {
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${token}` },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          let json: Json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

/**
 * A heartbeat the runner link's gateway forwarded, answered from runner_presence (link-heartbeat.ts, migration 0447;
 * docs/runner-link-design.md §5.7, §6.5), over a real PostgreSQL migrated from empty. The controller, RealtimeService
 * (its LISTEN connection included), the writers and the queues are the real classes; the hint bus is a double that
 * records what would go out on NATS. Each beat is counted statement by statement on the controller's client.
 *
 *   1. the first link beat reconciles in full; the next, with nothing changed, is one statement and one commit;
 *   2. a beat whose reports alone moved writes them in one more statement — the same rows the full reconcile
 *      writes, merged-branch reconcile and plan usage compare-and-set included — and hands nothing out;
 *   3. every kind of command a heartbeat delivers reaches the beat after its writer marks the runner changed, and
 *      is not handed out again once it is settled; a claimed one is handed out once;
 *   4. a cancellation and a lease lost to any writer are reconciled within one beat;
 *   5. with nothing marked, the runner still reconciles in full once in each five minutes;
 *   6. what the runner row holds is not rewritten while the facts written there are unchanged;
 *   7. a revoked runner, a disabled account and a body naming a landing are refused, with nothing written;
 *   8. a presence table a crash or a failover emptied: the next beat reconciles in full;
 *   9. an HTTPS heartbeat is answered as it always was, and a link heartbeat after it reconciles in full;
 *  10. a managed runner is admitted with its instance and reconciles in full on every beat.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/link-heartbeat.pg.spec.ts
 *
 * Not destructive: every row belongs to the accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CreatorType, type PrismaClient, RunStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import type { HttpException } from '@nestjs/common';
import type { PlanUsageRateLimitReset, RunnerHeartbeatRequest, RunnerHeartbeatResponse } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import type { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { cursorKeyCheckRelay } from '../providers/cursor-key-check-relay';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerHints, type HintBus } from '../realtime/runner-hints';
import { notifyRunnerWakeOnCommit } from '../realtime/runner-wake';
import { CodexRateLimitResetRepository } from '../runners/codex-rate-limit-reset.repository';
import { CodexRateLimitResetService } from '../runners/codex-rate-limit-reset.service';
import { RunnerPresenceService } from '../runners/runner-presence';
import { RunnersService } from '../runners/runners.service';
import { countingPrismaClientFor } from '../test-support/counting-prisma-client';
import { enqueueWikiJob } from '../wiki-worker/wiki-jobs';
import { WikiRepoOps } from '../wiki-worker/wiki-repo-ops';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { IntegrationJobRelay } from './integration-job-relay';
import { LINK_RECONCILE_EVERY_MS } from './link-heartbeat';
import { RunnerApiController } from './runner-api.controller';
import type { RunnerLinkContext } from './runner-link-call';
import { runnerLinkCredential } from './runner-link-token';

const URL_ = process.env.COORDINATOR_PG_URL;

/** What a link runner of today declares (the loadgen's list, src/link-gateway/cmd/loadgen/synth.go), and the rest. */
const CAPABILITIES = [
  'session-orchestration-credential-v1', 'session-terminal-handoff-v1', 'session-worktree-ops-v1',
  'session-merge-recovery-v1', 'source-pin/v1', 'codex-rate-limit-reset-v1', 'integration-job/v1',
  'integration-progress/v2', 'codex-account-login/v1', 'codex-account-remove/v1', 'claude-account-login/v1',
  'claude-account-remove/v1', 'wiki-repo-op/v1', 'wiki-repo-op-read/v1', 'cursor-key-check/v1',
].join(',');
const FINGERPRINT = `cxa1_${'1'.repeat(32)}`;

type Answer = RunnerHeartbeatResponse & { linkHints?: { inboxSessionIds: string[]; claim: boolean } };
interface Beat {
  answer: Answer;
  /** Every statement the controller's client sent for the beat, in order. */
  statements: string[];
}

/** A full reconcile always names the directories to scan; a quiet answer never does (link-heartbeat.ts). */
const isFull = (answer: Answer) => 'agentDirs' in answer;

test('a link heartbeat answered from runner_presence', { skip: !URL_, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  // RealtimeService's LISTEN connection reads it: a wake written inside a transaction reaches it at its commit.
  process.env.DATABASE_URL ??= url;
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const counting = countingPrismaClientFor(url);

  // ── the control plane, as RunnerApiModule assembles it ───────────────────────────────────────────────
  const hinted: Array<{ subject: string; message: string }> = [];
  const bus: HintBus = {
    up: true,
    publish: (subject, message) => void hinted.push({ subject, message }),
    subscribe: () => () => undefined,
    request: async () => null,
    close: async () => undefined,
  };
  const hints = new RunnerHints(prisma as never, 'nats://nats.invalid:4222', () => bus, Date.now, true);
  hints.onModuleInit();
  const push = { notifyEngineSignedOut: () => undefined };
  const realtime = new RealtimeService(prisma as unknown as PrismaService, push as never, hints);
  await realtime.onModuleInit();
  const db = counting.prisma as unknown as PrismaService;
  const door = new RunnerApiController(
    db, { notifySessionQueued: () => undefined } as never, realtime, push as never, {} as never, {} as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    new IntegrationJobRelay(db), undefined, undefined, undefined, undefined, new WikiRepoOps(db), undefined, undefined,
    new RunnerPresenceService(db), undefined,
  );
  const service = prisma as unknown as PrismaService;
  const runners = new RunnersService(service, realtime);
  const workspaces = new WorkspacesService(service, undefined, realtime);
  const codexResets = new CodexRateLimitResetService(service, new CodexRateLimitResetRepository(service), realtime);
  const wikiOps = new WikiRepoOps(service);
  t.after(async () => {
    realtime.onModuleDestroy();
    await hints.onModuleDestroy();
    await counting.prisma.$disconnect().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── one account, one machine on the link, one workspace, two sessions the process supervises ─────────
  const ownerId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `link-heartbeat-${ownerId}@runner-link.invalid`, name: 'The account owner', passwordHash: 'x' },
  });
  const token = `link-heartbeat-${randomUUID()}`;
  const runnerId = randomUUID();
  await prisma.runner.create({
    data: { id: runnerId, ownerId, name: 'workstation', tokenHash: sha256(token), status: 'ONLINE', lastHeartbeatAt: new Date() },
  });
  const workDir = '/home/u/src/app';
  const workspaceId = (await prisma.workspace.create({
    data: { ownerId, name: 'app', runnerId, workDir, enableWorktree: true },
  })).id;
  const process_ = randomUUID();
  const session = async (status: RunStatus, extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id, ownerId, creatorId: ownerId, title: 'a session', prompt: 'work', provider: 'claude', status, workspaceId,
        dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false, assignedRunnerId: runnerId, numTurns: 1,
        inboxLeaseOwner: process_, branch: `orbit/${id.slice(0, 8)}`, ...extra,
      },
    });
    return id;
  };
  const busy = await session(RunStatus.RUNNING);
  const idle = await session(RunStatus.AWAITING_INPUT);

  const planUsage = (sequence: number, block?: PlanUsageRateLimitReset) => ({
    codex: {
      provider: 'codex', fiveHourUsedPercent: sequence,
      ...(block ? { rateLimitReset: block } : {}),
    },
  });
  const read = (sequence: number): PlanUsageRateLimitReset => ({
    protocolVersion: 1, support: 'SUPPORTED', accountFingerprint: FINGERPRINT,
    rateLimitResetCredits: { availableCount: 2, credits: null }, fetchedAt: new Date().toISOString(),
    generation: process_, sequence,
  });
  /** What the runner reports, beat after beat, unless a case says otherwise. */
  let body: RunnerHeartbeatRequest = {
    status: 'ONLINE',
    idleCapacity: 2,
    version: '0.1.240',
    leaseOwner: process_,
    supervisedSessionIds: [busy, idle],
    commands: [{ name: 'review', description: 'Review the change' }],
    skills: [{ name: 'dataviz', description: 'Charts' }],
    modelCatalog: { claude: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }] },
    engines: [
      { engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' },
      { engine: 'codex', installed: true, auth: 'yes', version: '0.164.0', accounts: [{ id: 'default', auth: 'yes' }, { id: '0a0b0c0d', auth: 'yes' }] },
    ],
    runtimeDefaultModels: { claude: 'claude-opus-5-5' },
    runsAsRoot: false,
    reposRoot: '/home/u/orbit-repos',
    selfUpdate: { state: 'enabled', installDir: '/home/u/.local/bin' },
    repos: [{ root: workDir, branch: 'main', state: 'clean', agentIds: [workspaceId] }],
    agentDirProbes: [{ agentId: workspaceId, workDir, exists: true, isGitRepo: true, freeBytes: 50e9, totalBytes: 100e9 }],
    sessions: [{ sessionId: busy, isolationStatus: 'isolated', changedFiles: [], worktreeDirty: false, branchMerged: false }],
    planUsage: planUsage(1, read(1)),
  } as unknown as RunnerHeartbeatRequest;

  const link = (credential = runnerLinkCredential(sha256(token))): RunnerLinkContext => ({
    leaseOwner: process_, requestId: null, afterSeq: null, gatewayId: 'orbit-link-gateway-1', admission: { credential, ownerId },
  });
  /** One heartbeat over the link, as RunnerAuthGuard hands it on for AdmitsLinkCallItself, and what it cost. */
  const beat = async (overrides: Partial<RunnerHeartbeatRequest> = {}, context: RunnerLinkContext = link()): Promise<Beat> => {
    counting.statements.reset();
    const answer = await door.heartbeat(
      { id: runnerId, ownerId } as never, { ...body, ...overrides }, CAPABILITIES, 'claude,codex', 'linux', undefined, context, {},
    ) as Answer;
    return { answer, statements: [...counting.statements.sql] };
  };
  const presence = async () => (await sql.query(
    `SELECT "process_id"::text AS "processId", "gateway_id" AS "gatewayId", "link_state" AS "linkState",
            "facts_hash" AS "factsHash", "reconcile_hash" AS "reconcileHash", "changes"::text AS "changes",
            "reconciled_at" IS NOT NULL AS "reconciled", "last_beat_at"::text AS "lastBeatAt"
       FROM "runner_presence" WHERE "runner_id" = $1`, [runnerId])).rows[0];
  /** The runner row's current version: a rewrite of the row is a new tuple. */
  const runnerTuple = async () => (await sql.query(`SELECT ctid::text || ':' || xmin::text AS v FROM "runner" WHERE id = $1`, [runnerId])).rows[0]?.v;
  /** The CommandsHints this runner was sent since `from`. */
  const commandsHints = (from: number) =>
    hinted.slice(from).filter((h) => h.subject === `rnr.${runnerId}` && h.message === '{"hint":{"commands":{}}}').length;
  /** Waits for markRunnerChanged, which writes and hints after the writer has returned. */
  const marked = async (from: number) => {
    for (let i = 0; i < 100 && commandsHints(from) === 0; i += 1) await delay(20);
    assert.ok(commandsHints(from) > 0, 'the runner was hinted to beat once its change count moved');
  };
  /** Beats until the answer is quiet, at most four times: what it handed out on the way. */
  const settle = async (): Promise<Answer[]> => {
    const answers: Answer[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { answer } = await beat();
      answers.push(answer);
      if (!isFull(answer)) return answers;
    }
    assert.fail(`still reconciling in full after four beats: ${JSON.stringify(answers.at(-1))}`);
  };

  await t.test('1. the first link beat reconciles in full; the next, with nothing changed, is one statement', async () => {
    const first = await beat();
    assert.ok(isFull(first.answer), 'no record: the first beat reconciles in full');
    const recorded = await presence();
    assert.equal(recorded.linkState, 'LINK');
    assert.equal(recorded.processId, process_);
    assert.equal(recorded.gatewayId, 'orbit-link-gateway-1');
    assert.ok(recorded.factsHash && recorded.reconcileHash && recorded.reconciled, 'and records what it covered');

    const quiet = await beat();
    assert.equal(isFull(quiet.answer), false);
    assert.deepEqual(quiet.statements.length, 1, quiet.statements.join('\n---\n'));
    assert.match(quiet.statements[0], /^\s*WITH caller AS/);
    assert.equal(quiet.statements.some((s) => /^\s*(BEGIN|COMMIT)/i.test(s)), false, 'one autocommit statement: one commit');
    assert.deepEqual(
      { ...quiet.answer, linkHints: undefined },
      {
        cancelSessionIds: [], leaseLostSessionIds: [], maxConcurrent: 1, minFreeDiskMb: null,
        mergeRequests: [], commitRequests: [], artifactRequests: [], linkHints: undefined,
      },
    );
    assert.deepEqual(quiet.answer.linkHints?.inboxSessionIds, []);
    assert.ok((await presence()).lastBeatAt > recorded.lastBeatAt, 'and the beat is recorded');
  });

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** The columns a heartbeat's reports land in, for one machine, its workspace and two of its sessions. */
  const reportRows = async (machine: string, workspace: string, sessions: [string, string]) => {
    const runnerRow = (await sql.query(
      `SELECT status::text, version, available_commands, available_skills, model_catalog, runtime_default_models,
              repo_health, runs_as_root, repos_root, self_update, plan_usage
         FROM "runner" WHERE id = $1`, [machine])).rows[0];
    const workspaceRow = (await sql.query(
      `SELECT work_dir_exists, work_dir_is_git, work_dir_free_bytes::text, work_dir_total_bytes::text, repo_url
         FROM "workspace" WHERE id = $1`, [workspace])).rows[0];
    const sessionRows = [];
    for (const id of sessions) {
      sessionRows.push((await sql.query(
        `SELECT isolation_status, base_sha, changed_files, worktree_dirty, merge_targets, branch_merged, worktree_branch,
                branch_sha, merge_status, merge_operation_id IS NOT NULL AS "mergeOperation", merge_error, merged_source_sha
           FROM "session" WHERE id = $1`, [id])).rows[0]);
    }
    // The repository report names its workspace by id; the twin's is another id.
    const repoHealth = JSON.parse(JSON.stringify(runnerRow.repo_health ?? null)?.replaceAll(workspace, 'WORKSPACE') ?? 'null');
    return { runner: { ...runnerRow, repo_health: repoHealth }, workspace: workspaceRow, sessions: sessionRows };
  };

  await t.test('2. a beat whose reports alone moved writes them in one more statement, as the full reconcile writes them', async () => {
    // A twin machine whose identical reports go over HTTPS, which reconciles in full on every beat.
    const twinToken = `link-heartbeat-twin-${randomUUID()}`;
    const twin = randomUUID();
    await prisma.runner.create({ data: { id: twin, ownerId, name: 'twin', tokenHash: sha256(twinToken), status: 'ONLINE', lastHeartbeatAt: new Date() } });
    const twinWorkspace = (await prisma.workspace.create({ data: { ownerId, name: 'twin app', runnerId: twin, workDir, enableWorktree: true } })).id;
    const twinSession = async (status: RunStatus) => {
      const id = randomUUID();
      await prisma.session.create({
        data: {
          id, ownerId, creatorId: ownerId, title: 'twin', prompt: 'work', provider: 'claude', status, workspaceId: twinWorkspace,
          dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false, assignedRunnerId: twin, numTurns: 1,
          inboxLeaseOwner: process_, branch: `orbit/${id.slice(0, 8)}`,
        },
      });
      return id;
    };
    const [twinBusy, twinIdle] = [await twinSession(RunStatus.RUNNING), await twinSession(RunStatus.AWAITING_INPUT)];
    const forTwin = (report: RunnerHeartbeatRequest): RunnerHeartbeatRequest => JSON.parse(
      JSON.stringify(report).replaceAll(busy, twinBusy).replaceAll(idle, twinIdle).replaceAll(workspaceId, twinWorkspace),
    );
    const twinRow = () => prisma.runner.findUniqueOrThrow({ where: { id: twin } });
    const overHttps = async (report: RunnerHeartbeatRequest) =>
      door.heartbeat(await twinRow() as never, forTwin(report), CAPABILITIES, 'claude,codex', 'linux') as Promise<Answer>;
    await overHttps(body);

    // Both sessions hold a recorded merge: one landed the tip the runner reports, one landed another.
    for (const [mine, theirs, landed] of [[busy, twinBusy, 'a'.repeat(40)], [idle, twinIdle, 'b'.repeat(40)]] as const) {
      for (const id of [mine, theirs]) {
        await sql.query(
          `UPDATE "session" SET merge_status = 'merged', merged_source_sha = $2, merge_operation_id = gen_random_uuid(),
                  merge_operation_owner = $3, merge_error = 'kept until reconciled' WHERE id = $1`,
          [id, landed, process_],
        );
      }
    }
    body = {
      ...body,
      commands: [{ name: 'review', description: 'Review the change' }, { name: 'ship' }],
      planUsage: planUsage(2, read(2)),
      agentDirProbes: [{ agentId: workspaceId, workDir, exists: true, isGitRepo: true, freeBytes: 49e9, totalBytes: 100e9, repoUrl: 'git@example.invalid:app.git' }],
      sessions: [
        { sessionId: busy, isolationStatus: 'isolated', baseSha: 'c'.repeat(40), changedFiles: [{ path: 'a.ts', status: 'M' }],
          worktreeDirty: true, mergeTargets: ['main', 'release'], branchMerged: false, worktreeBranch: 'orbit/x', branchSha: 'a'.repeat(40) },
        { sessionId: idle, isolationStatus: 'isolated', changedFiles: [], branchMerged: false, branchSha: 'd'.repeat(40) },
      ],
    } as unknown as RunnerHeartbeatRequest;
    const reports = await beat();
    assert.equal(isFull(reports.answer), false, 'nothing is handed out for a report');
    assert.equal(reports.statements.length, 2, reports.statements.join('\n---\n'));
    assert.match(reports.statements[1], /UPDATE "runner_presence"/);
    await overHttps(body);
    const link = await reportRows(runnerId, workspaceId, [busy, idle]);
    const https = await reportRows(twin, twinWorkspace, [twinBusy, twinIdle]);
    assert.deepEqual(link, https, 'the reports land exactly where and as the full reconcile writes them');
    assert.equal(link.sessions[0].branch_merged, true, 'the merge that landed the reported tip stands');
    assert.equal(link.sessions[1].merge_status, null, 'the merge of another tip is cleared');
    assert.equal(link.workspace.repo_url, 'git@example.invalid:app.git', 'and the checkout taught its address');
    assert.equal((await beat()).statements.length, 1, 'recorded: the next beat is quiet again');
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * `write` queues something a heartbeat delivers, as its writer does, which marks the runner changed. The beat after
   * the mark reconciles in full and carries it (`pick`); what the beats after that carried, until quiet, comes back.
   */
  const deliveredAfter = async <T>(write: () => Promise<unknown>, pick: (a: Answer) => T | undefined) => {
    assert.equal(isFull((await beat()).answer), false, 'quiet before the write');
    const from = hinted.length;
    await write();
    await marked(from);
    const next = await beat();
    assert.ok(isFull(next.answer), 'the beat after the mark reconciles in full');
    const command = pick(next.answer);
    assert.ok(
      command !== undefined && command !== null && command !== false && !(Array.isArray(command) && command.length === 0),
      `the beat after the mark delivers it: ${JSON.stringify(next.answer)}`,
    );
    return command as T;
  };
  const exactlyOnce = async <T>(write: () => Promise<unknown>, pick: (a: Answer) => T | undefined) => {
    const command = await deliveredAfter(write, pick);
    const later = await settle();
    assert.equal(later.filter((a) => pick(a) !== undefined && pick(a) !== false && !(Array.isArray(pick(a)) && (pick(a) as unknown[]).length === 0)).length, 0,
      'handed out once: no later beat carries it');
    return command;
  };
  /** A command redelivered while it is pending (its contract), and never again once the runner settled it. */
  const untilSettled = async <T>(write: () => Promise<unknown>, pick: (a: Answer) => T | undefined, settleIt: () => Promise<unknown>) => {
    const command = await deliveredAfter(write, pick);
    const again = await beat();
    assert.ok(isFull(again.answer), 'while it is pending, every beat reconciles in full, as over HTTPS');
    assert.deepEqual(pick(again.answer), command, 'and redelivers it, as its contract says');
    await settleIt();
    const later = await settle();
    assert.equal(later.filter((a) => {
      const v = pick(a);
      return v !== undefined && !(Array.isArray(v) && v.length === 0);
    }).length, 0, 'once settled it is handed out no more');
    return command;
  };

  await t.test('3. every kind of command reaches the beat after its writer marks the runner, and is not handed out again', async (t3) => {
    await t3.test('installRequest (RunnersService.startInstall, startEngineUpdate)', async () => {
      const install = await untilSettled(() => runners.startInstall(ownerId, runnerId, 'kimi'), (a) => a.installRequest,
        () => sql.query(`UPDATE "runner" SET install_status = 'failed' WHERE id = $1`, [runnerId]));
      assert.equal(install?.engine, 'kimi');
      const update = await untilSettled(() => runners.startEngineUpdate(ownerId, runnerId), (a) => a.installRequest,
        () => sql.query(`UPDATE "runner" SET install_status = NULL, install_mode = NULL WHERE id = $1`, [runnerId]));
      assert.equal(update?.mode, 'update');
    });
    await t3.test('loginRequest (RunnersService.startLogin)', async () => {
      const login = await untilSettled(() => runners.startLogin(ownerId, runnerId, { engine: 'claude' }), (a) => a.loginRequest,
        () => sql.query(`UPDATE "runner" SET login_status = 'failed' WHERE id = $1`, [runnerId]));
      assert.equal(login?.action, 'start');
    });
    await t3.test('codexAccountRemoveRequest (RunnersService.removeAccount)', async () => {
      const removal = await untilSettled(() => runners.removeAccount(ownerId, runnerId, 'codex', '0a0b0c0d'), (a) => a.codexAccountRemoveRequest,
        () => sql.query(`UPDATE "runner" SET codex_account_remove_status = 'done' WHERE id = $1`, [runnerId]));
      assert.equal(removal?.account, '0a0b0c0d');
    });
    await t3.test('refreshModelCatalog, checkSelfUpdate (RunnersService): handed out once', async () => {
      assert.equal(await exactlyOnce(() => runners.requestModelCatalogRefresh(ownerId, runnerId), (a) => a.refreshModelCatalog), true);
      assert.equal(await exactlyOnce(() => runners.requestSelfUpdate(ownerId, runnerId), (a) => a.checkSelfUpdate), true);
    });
    await t3.test('claudeHistoryRequest (RunnersService.requestClaudeHistory): claimed once', async () => {
      const ask = await deliveredAfter(() => runners.requestClaudeHistory(ownerId, runnerId, workDir), (a) => a.claudeHistoryRequest);
      assert.equal(ask?.workDir, workDir);
      // Claimed: scanning, which keeps the runner reconciling until its answer lands, and is never handed out again.
      const scanning = await beat();
      assert.equal(scanning.answer.claudeHistoryRequest, undefined);
      await sql.query(`UPDATE "runner" SET claude_history_status = 'done' WHERE id = $1`, [runnerId]);
      assert.equal((await settle()).filter((a) => a.claudeHistoryRequest).length, 0);
    });
    await t3.test('agentDirs (WorkspacesService.update)', async () => {
      const dirs = await deliveredAfter(
        () => workspaces.update(ownerId, workspaceId, { workDir: '/home/u/src/app-moved' } as never),
        (a) => a.agentDirs?.find((d) => d.agentId === workspaceId)?.workDir,
      );
      assert.equal(dirs, '/home/u/src/app-moved');
      await settle();
      await workspaces.update(ownerId, workspaceId, { workDir } as never);
      await settle();
    });
    await t3.test('repoCleanupRequest (WorkspacesService.requestRepoCleanup)', async () => {
      // The runner reports the checkout wedged: a report, written without a full reconcile.
      body = { ...body, repos: [{ root: workDir, branch: 'main', state: 'rebase', agentIds: [workspaceId] }] } as never;
      assert.equal(isFull((await beat()).answer), false);
      const cleanup = await untilSettled(() => workspaces.requestRepoCleanup(ownerId, workspaceId), (a) => a.repoCleanupRequest,
        () => sql.query(`UPDATE "runner" SET repo_cleanup_status = 'done' WHERE id = $1`, [runnerId]));
      assert.equal(cleanup?.root, workDir);
      body = { ...body, repos: [{ root: workDir, branch: 'main', state: 'clean', agentIds: [workspaceId] }] } as never;
      await settle();
    });
    await t3.test('mergeRequests, commitRequests (SessionsService.mergeToMain, commitWorktree)', async () => {
      // As queueMerge writes one, and mergeToMain wakes the runner after the commit.
      const mergeOperation = randomUUID();
      const merge = await untilSettled(async () => {
        await sql.query(
          `UPDATE "session" SET merge_status = 'pending', merge_operation_id = $2, merge_operation_owner = NULL,
                  merge_requested_at = now() WHERE id = $1`, [idle, mergeOperation]);
        realtime.notifyRunnerWake(runnerId);
      }, (a) => a.mergeRequests?.find((m) => m.sessionId === idle)?.operationId,
      () => sql.query(`UPDATE "session" SET merge_status = 'merged', merged_source_sha = $2 WHERE id = $1`, [idle, 'e'.repeat(40)]));
      assert.equal(merge, mergeOperation);
      const commitOperation = randomUUID();
      const commit = await untilSettled(async () => {
        await sql.query(
          `UPDATE "session" SET commit_status = 'pending', commit_operation_id = $2, commit_operation_owner = NULL,
                  commit_requested_at = now() WHERE id = $1`, [idle, commitOperation]);
        realtime.notifyRunnerWake(runnerId);
      }, (a) => a.commitRequests?.find((c) => c.sessionId === idle)?.operationId,
      () => sql.query(`UPDATE "session" SET commit_status = NULL, commit_operation_id = NULL, commit_operation_owner = NULL WHERE id = $1`, [idle]));
      assert.equal(commit, commitOperation);
    });
    await t3.test('artifactRequests (SessionsService.getWorktreeFileForOwner)', async () => {
      const turn = randomUUID();
      const artifact = await untilSettled(async () => {
        await prisma.conversationTurn.create({
          data: { id: turn, sessionId: busy, seq: 900, clientTurnId: `worktree-file-${turn}`, kind: 'artifact', status: 'PENDING',
            content: JSON.stringify({ source: 'worktree', path: 'card.png' }) },
        });
        realtime.markSessionRunnerChanged(busy);
      }, (a) => a.artifactRequests?.find((r) => r.requestId === turn)?.path,
      () => prisma.conversationTurn.update({ where: { id: turn }, data: { status: 'ANSWERED', answeredAt: new Date() } }));
      assert.equal(artifact, 'card.png');
    });
    await t3.test('codexRateLimitResetRequest (CodexRateLimitResetService.create)', async () => {
      const created = { id: '' };
      const command = await deliveredAfter(async () => {
        const { operation } = await codexResets.create(ownerId, runnerId, { clientRequestId: randomUUID(), accountFingerprint: FINGERPRINT });
        created.id = operation.id;
      }, (a) => a.codexRateLimitResetRequest);
      assert.equal(command?.operationId, created.id);
      // An operation under way keeps the runner reconciling on every beat: each renews its claim.
      assert.ok(isFull((await beat()).answer));
      await sql.query(`DELETE FROM "codex_rate_limit_reset_operation" WHERE id = $1`, [created.id]);
      await settle();
    });
    await t3.test('integrationJobs (queueLandTask and its kin wake from inside the transaction that queues the job)', async () => {
      const projectId = randomUUID();
      await prisma.project.create({ data: { id: projectId, ownerId, title: 'a project' } });
      await prisma.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
      await establishProjectContractForPgTest(prisma, ownerId, projectId, 'link heartbeat');
      const codebase = await prisma.projectCodebase.create({
        data: {
          projectId, ownerId, canonicalRepoUrl: 'ssh://git@example.invalid/app', upstreamRef: 'refs/heads/main',
          integrationRef: `refs/heads/project/${projectId}`, integrationRefSource: 'EXPLICIT', refAuthority: 'REMOTE',
        },
      });
      const taskId = randomUUID();
      await prisma.task.create({
        data: { id: taskId, ownerId, projectId, title: 'done work', creatorType: CreatorType.USER, completionCriterion: 'EVIDENCE_JUDGMENT', creatorId: ownerId, status: TaskStatus.DONE },
      });
      const work = await prisma.session.create({
        data: {
          ownerId, creatorId: ownerId, title: 'the work', prompt: 'p', taskId, startsTaskWork: true, status: RunStatus.SUCCEEDED,
          workspaceId, assignedRunnerId: runnerId, finishedAt: new Date(),
        },
      });
      const jobId = randomUUID();
      const job = await deliveredAfter(async () => {
        await prisma.$transaction(async (tx) => {
          await tx.projectIntegrationJob.create({
            data: {
              id: jobId, projectId, ownerId, codebaseId: codebase.id, kind: 'LAND_TASK', taskId, sessionId: work.id, state: 'QUEUED',
              serialKey: `${projectId}:refs/heads/project/${projectId}`, targetRef: `refs/heads/project/${projectId}`,
              upstreamRef: 'refs/heads/main', sourceRef: `refs/heads/orbit/${taskId}`, idempotencyKey: `link-heartbeat:${jobId}`,
            },
          });
          await notifyRunnerWakeOnCommit(tx as never, runnerId);
        });
      }, (a) => a.integrationJobs?.find((j) => j.jobId === jobId));
      assert.equal(job?.leaseOwner, process_);
      // Claimed: RUNNING keeps the runner reconciling, and it is not handed out again.
      const running = await beat();
      assert.ok(isFull(running.answer));
      assert.equal(running.answer.integrationJobs, undefined, 'a claim is handed out once');
      await sql.query(`UPDATE "project_integration_job" SET state = 'CANCELLED', finished_at = now() WHERE id = $1`, [jobId]);
      assert.equal((await settle()).filter((a) => a.integrationJobs).length, 0);
    });
    await t3.test('wikiRepoOps (WikiRepoOps.enqueueWikiRepoOp wakes from inside its transaction)', async () => {
      const spaceId = randomUUID();
      await prisma.wikiSpace.create({
        data: {
          id: spaceId, ownerId, slug: `link-heartbeat-${spaceId.slice(0, 8)}`, title: 'A space', repoUrlNorm: 'github.com/example/app',
          rootCommitSha: 'a'.repeat(40), settings: { maintenance: { workspaceId } },
        },
      });
      const jobId = randomUUID();
      await enqueueWikiJob(service, { id: jobId, ownerId, spaceId, kind: 'maintain' });
      const opId = randomUUID();
      const op = await deliveredAfter(() => wikiOps.enqueueWikiRepoOp({ id: opId, jobId, kind: 'snapshot' }),
        (a) => a.wikiRepoOps?.find((o) => o.id === opId));
      assert.ok(op);
      const running = await beat();
      assert.ok(isFull(running.answer), 'a running operation keeps the runner reconciling');
      assert.equal(running.answer.wikiRepoOps, undefined, 'and is handed out once');
      await sql.query(`UPDATE "wiki_repo_op" SET state = 'cancelled', lease_owner = NULL, claimed_at = NULL, heartbeat_at = NULL, ended_at = now() WHERE id = $1`, [opId]);
      assert.equal((await settle()).filter((a) => a.wikiRepoOps).length, 0);
    });
    await t3.test('cursorKeyChecks: held in this process, handed out by the next beat, quiet or not, once', async () => {
      cursorKeyCheckRelay.waitMs = 200;
      const answered = cursorKeyCheckRelay.ask(runnerId, 'key_link_heartbeat');
      const next = await beat();
      assert.equal(isFull(next.answer), false);
      assert.equal(next.answer.cursorKeyChecks?.[0]?.apiKey, 'key_link_heartbeat');
      assert.equal((await beat()).answer.cursorKeyChecks, undefined);
      await answered;
    });
    await t3.test('maxConcurrent, minFreeDiskMb (RunnersService.updateRunner): every beat states them', async () => {
      await runners.updateRunner(ownerId, runnerId, { maxConcurrent: 6, minFreeDiskMb: 4096 } as never);
      const next = await beat();
      assert.equal(isFull(next.answer), false);
      assert.equal(next.answer.maxConcurrent, 6);
      assert.equal(next.answer.minFreeDiskMb, 4096);
    });
    await t3.test('linkHints: what waits, on every beat', async () => {
      await prisma.conversationTurn.create({
        data: { sessionId: idle, seq: 901, clientTurnId: `link-heartbeat-${randomUUID()}`, status: 'PENDING', content: 'a message' },
      });
      const next = await beat();
      assert.equal(isFull(next.answer), false);
      assert.deepEqual(next.answer.linkHints?.inboxSessionIds, [idle], 'a lost inbox hint is made good by the next beat');
      await sql.query(`UPDATE "conversation_turn" SET status = 'ANSWERED' WHERE session_id = $1 AND seq = 901`, [idle]);
    });
  });

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('4. a cancellation and a lease lost to any writer are reconciled within one beat', async () => {
    const cancelled = await session(RunStatus.RUNNING);
    const takenOver = await session(RunStatus.RUNNING);
    const ended = await session(RunStatus.AWAITING_INPUT);
    body = { ...body, supervisedSessionIds: [busy, idle, cancelled, takenOver, ended] };
    await settle();

    // The end path writes the cancellation, then asks the runner to tear the process down (requestCancel).
    const from = hinted.length;
    await sql.query(`UPDATE "session" SET cancel_requested_at = now() WHERE id = $1`, [cancelled]);
    realtime.requestCancel(runnerId, cancelled);
    await marked(from);
    assert.deepEqual((await beat()).answer.cancelSessionIds, [cancelled], 'the next beat cancels it');

    // Another process takes a session over, and another writer ends one: no writer marks anything, and the next beat
    // reconciles anyway, because every beat reads the leases of what it supervises.
    await sql.query(`UPDATE "session" SET inbox_lease_owner = gen_random_uuid() WHERE id = $1`, [takenOver]);
    await sql.query(`UPDATE "session" SET status = 'SUCCEEDED', finished_at = now() - interval '10 minutes' WHERE id = $1`, [ended]);
    await sql.query(`UPDATE "session" SET status = 'CANCELLED', finished_at = now() - interval '10 minutes' WHERE id = $1`, [cancelled]);
    const next = await beat();
    assert.ok(isFull(next.answer));
    assert.deepEqual([...(next.answer.leaseLostSessionIds ?? [])].sort(), [cancelled, takenOver, ended].sort());
    body = { ...body, supervisedSessionIds: [busy, idle] };
    await settle();
  });

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('5. with nothing marked, a full reconcile still runs once in each five minutes', async () => {
    assert.equal(isFull((await beat()).answer), false);
    await sql.query(
      `UPDATE "runner_presence" SET reconciled_at = reconciled_at - ($2 * interval '1 millisecond') WHERE runner_id = $1`,
      [runnerId, LINK_RECONCILE_EVERY_MS],
    );
    const periodic = await beat();
    assert.ok(isFull(periodic.answer), 'five minutes on, the beat reconciles in full');
    const { rows: [fresh] } = await sql.query(
      `SELECT reconciled_at > (now() AT TIME ZONE 'UTC') - interval '1 minute' AS fresh FROM runner_presence WHERE runner_id = $1`, [runnerId]);
    assert.equal(fresh.fresh, true, 'and records that it did');
    assert.equal(isFull((await beat()).answer), false, 'then the beats are quiet again');
  });

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('6. the runner row is not rewritten while what is written there is unchanged', async () => {
    await settle();
    const before = await runnerTuple();
    assert.equal(isFull((await beat()).answer), false);
    assert.equal(await runnerTuple(), before, 'a quiet beat does not touch the row');
    const from = hinted.length;
    realtime.markRunnerChanged(runnerId);
    await marked(from);
    const flagged = await beat();
    assert.ok(isFull(flagged.answer), 'a mark reconciles in full');
    assert.equal(await runnerTuple(), before, 'and with the same facts it leaves the runner row as it is');
    assert.equal(flagged.statements.some((s) => /^\s*UPDATE "public"\."runner" SET "status"/.test(s)), false);

    // Its own record of the beat is still written when it is due, and nothing else.
    await sql.query(`UPDATE "runner" SET last_heartbeat_at = now() - interval '6 minutes' WHERE id = $1`, [runnerId]);
    const durable = await runnerTuple();
    const fromDue = hinted.length;
    realtime.markRunnerChanged(runnerId);
    await marked(fromDue);
    const due = await beat();
    assert.ok(isFull(due.answer));
    assert.notEqual(await runnerTuple(), durable);
    assert.ok(due.statements.some((s) => /UPDATE "public"\."runner" SET "last_heartbeat_at" = \$1 WHERE/.test(s)), due.statements.join('\n---\n'));

    // A fact written there that moved: the report statement writes that column, the delivery facts reconcile in full.
    body = { ...body, engines: [...(body.engines ?? []), { engine: 'kimi', installed: true, auth: 'no' }] } as never;
    const engines = await beat();
    assert.ok(isFull(engines.answer), 'an engine report reconciles in full');
    assert.notEqual(await runnerTuple(), durable);
    assert.ok(engines.statements.some((s) => /UPDATE "public"\."runner" SET "status"/.test(s)), 'and rewrites the row');
    await settle();
  });

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('7. a revoked runner, a disabled account and a body naming a landing are refused, with nothing written', async () => {
    const refused = async (attempt: Promise<unknown>, status: number, code: string) => {
      const before = await presence();
      await assert.rejects(attempt, (error: HttpException) => {
        assert.equal(error.getStatus(), status);
        assert.equal((error.getResponse() as { code?: string }).code, code);
        return true;
      });
      assert.deepEqual(await presence(), before, 'nothing written');
    };
    // A token minted with a credential the runner no longer holds: its token was rotated.
    const rotatedOut = runnerLinkCredential(sha256('the credential before a rotation'));
    await refused(beat({}, link(rotatedOut)), 401, 'RUNNER_LINK_TOKEN_REVOKED');
    // The runner the token names was deleted.
    const goneToken = `link-heartbeat-gone-${randomUUID()}`;
    const gone = randomUUID();
    await prisma.runner.create({ data: { id: gone, ownerId, name: 'gone', tokenHash: sha256(goneToken) } });
    await prisma.runner.delete({ where: { id: gone } });
    await assert.rejects(
      door.heartbeat({ id: gone, ownerId } as never, body, CAPABILITIES, undefined, undefined, undefined,
        { ...link(runnerLinkCredential(sha256(goneToken))) }, {}),
      (error: HttpException) => error.getStatus() === 401,
    );
    // The account is disabled: 403, as over HTTPS, until it is enabled again.
    await sql.query(`UPDATE "user" SET disabled_at = now() WHERE id = $1`, [ownerId]);
    await refused(beat(), 403, 'ACCOUNT_DISABLED');
    await sql.query(`UPDATE "user" SET disabled_at = NULL WHERE id = $1`, [ownerId]);
    // A LANDING session is the platform's: a body naming one is refused whole (§2.9 LS6).
    const landing = randomUUID();
    await prisma.session.create({
      data: {
        id: landing, ownerId, creatorId: ownerId, title: 'a landing', prompt: 'land', provider: 'orbit', providerBuiltin: true,
        sessionKind: 'LANDING', status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
      },
    });
    await refused(beat({ expiredCommitErrors: [{ sessionId: landing, operationId: randomUUID() }] }), 409, 'SESSION_IS_PLATFORM_DRIVEN');
    assert.equal(isFull((await beat()).answer), false, 'and the runner beats on as before');
  });

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('8. a presence table a crash or a failover emptied: the next beat reconciles in full', async () => {
    assert.equal(isFull((await beat()).answer), false);
    await sql.query(`TRUNCATE "runner_presence"`);
    const after = await beat();
    assert.ok(isFull(after.answer), 'no row: a full reconcile');
    assert.equal(isFull((await beat()).answer), false, 'and the record it leaves answers the next');
  });

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('9. an HTTPS heartbeat is answered as it always was; a link beat after it reconciles in full', async () => {
    const { rows: [counted] } = await sql.query(`SELECT changes::text FROM runner_presence WHERE runner_id = $1`, [runnerId]);
    for (let i = 0; i < 2; i += 1) {
      const before = await runnerTuple();
      const row = await prisma.runner.findUniqueOrThrow({ where: { id: runnerId } });
      const answer = await door.heartbeat(row as never, body, CAPABILITIES, 'claude,codex', 'linux') as Answer;
      assert.ok(isFull(answer), 'in full, every beat');
      assert.equal('linkHints' in answer, false);
      assert.notEqual(await runnerTuple(), before, 'the runner row rewritten, every beat');
      const p = await presence();
      assert.deepEqual([p.linkState, p.gatewayId, p.factsHash, p.reconcileHash], ['HTTP', null, null, null]);
      assert.equal(p.changes, counted.changes, 'the change count is not the HTTPS beat\'s to touch');
    }
    assert.ok(isFull((await beat()).answer), 'the link beat after an HTTPS one finds no record');
    assert.equal(isFull((await beat()).answer), false);
  });

  // ── 10 ─────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('10. a managed runner is admitted with its instance and reconciles in full on every beat', async () => {
    const managedOwner = randomUUID();
    await prisma.user.create({ data: { id: managedOwner, email: `link-heartbeat-managed-${managedOwner}@runner-link.invalid`, name: 'm', passwordHash: 'x' } });
    const managedToken = `link-heartbeat-managed-${randomUUID()}`;
    const managed = randomUUID();
    await prisma.runner.create({ data: { id: managed, ownerId: managedOwner, name: 'managed', tokenHash: sha256(managedToken), status: 'ONLINE' } });
    const managedWorkspace = await prisma.workspace.create({ data: { ownerId: managedOwner, name: 'managed', runnerId: managed, workDir: '/workspace' } });
    const podUid = randomUUID();
    await prisma.managedRunner.create({
      data: {
        ownerId: managedOwner, runnerId: managed, defaultWorkspaceId: managedWorkspace.id, clusterKey: 'test', namespace: 'test',
        pvcName: `mr-data-${managed}`, managementState: 'READY', podUid,
      } as never,
    });
    const context: RunnerLinkContext = {
      leaseOwner: process_, requestId: null, afterSeq: null, gatewayId: 'orbit-link-gateway-1',
      admission: { credential: runnerLinkCredential(sha256(managedToken)), ownerId: managedOwner },
    };
    const managedBeat = (headers: Record<string, string>) =>
      door.heartbeat({ id: managed, ownerId: managedOwner } as never, { ...body, supervisedSessionIds: [], sessions: [], agentDirProbes: [] },
        CAPABILITIES, 'claude', 'linux', undefined, context, headers) as Promise<Answer>;
    // Without its instance it is refused as RunnerAuthGuard refuses it, and nothing is written.
    await assert.rejects(managedBeat({}), (error: HttpException) =>
      error.getStatus() === 403 && (error.getResponse() as { code?: string }).code === 'MANAGED_RUNNER_INSTANCE_REQUIRED');
    assert.equal((await sql.query(`SELECT 1 FROM runner_presence WHERE runner_id = $1`, [managed])).rowCount, 0);
    const instance = {
      'x-orbit-runner-capabilities': `${CAPABILITIES},managed-runner-instance-v1`,
      'x-orbit-managed-runner-generation': '1',
      'x-orbit-managed-runner-pod-uid': podUid,
    };
    for (let i = 0; i < 3; i += 1) assert.ok(isFull(await managedBeat(instance)), 'every beat of a managed runner reconciles in full');
  });

  // The open statuses the lease check reads are the leaseLostSessionIds rule's (common/session-scheduling.ts).
  assert.deepEqual(OPEN_SESSION_STATUSES, ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED']);
});

/**
 * Moving a session to another workspace — `GET /sessions/:id/move-targets` and the cross-workspace
 * half of `POST /sessions/:id/move` (docs/session-folders-move-design.md §5.2, §5.4) — over real
 * HTTP, the real SessionsController behind main.ts's pipe, interceptors and filters, against a real,
 * fully migrated PostgreSQL; and the runner's `worktrees-removable` for a checkout whose session has
 * moved to another runner. Held to:
 *
 *   (1) the panel: the folders of the session's workspace with their counts, every other live
 *       workspace of the owner with whether the session can move there and why not, how the
 *       conversation comes along, and what the confirmation says about the code left behind;
 *   (2) a move on the same runner writes every §5.4 column — workspace, folder, the runner, the
 *       branch kept, the old checkout's columns cleared, the account the session actually ran on
 *       written onto it — touches nothing else, and announces the session and both workspaces;
 *   (3) a move to another runner clears the account columns, and the checkout the old runner still
 *       has is reported removable while the new runner's is kept;
 *   (4) the branch is generated or dropped only where the two workspaces' worktree settings differ;
 *   (5) Codex moves within its runner, on the account it ran on; a runner that cannot run Codex, and
 *       any other runner, is refused;
 *   (6) every §5.2 rule about the session itself: the panel's reason is the move's 409, and a refusal
 *       writes and announces nothing; an idle session has to be ended first, and then moves; a
 *       spawned child session moves;
 *   (7) every §5.2 rule about the target workspace, the same way; an offline runner is no refusal;
 *   (8) the rules are asked again under the locks: a session that wakes up, or a workspace that is
 *       disabled, while the move waits for its lock is refused for the reason true when it gets it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-move-workspace.pg.spec.ts
 *
 * Not destructive: every row belongs to an owner this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, RunnerStatus, RunStatus, SessionDispatchOrigin } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionTagsService } from '../session-tags/session-tags.service';
import { AutoRetryService } from './auto-retry.service';
import { MergeReceiptService } from './merge-receipt.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

// What main.ts installs before the app serves anything: a session row carries BIGINT columns.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

type Json = Record<string, any>;
type Answer = { status: number; text: string; json: Json };

/** One request on a connection of its own (agent: false), so no answer rides a pooled socket. */
function send(
  base: string,
  method: string,
  path: string,
  options: { as?: 'owner' | 'other'; body?: unknown } = {},
): Promise<Answer> {
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  const headers: Record<string, string> = {};
  if (options.as) headers.authorization = `Bearer ${options.as}`;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Json = {};
        try { json = JSON.parse(text) as Json; } catch { /* an empty body */ }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** The columns that described the checkout in the workspace a session left (§5.4). */
const OLD_CHECKOUT = [
  'base_sha',
  'changed_files',
  'isolation_status',
  'merge_status',
  'merge_error',
  'merge_recovery',
  'merge_recovery_action',
  'merge_requested_at',
  'merge_operation_id',
  'merge_operation_owner',
  'merged_at',
  'merged_source_sha',
  'branch_merged',
  'worktree_branch',
  'worktree_dirty',
  'merge_target',
];

/** What a move leaves exactly as it was: the conversation, its runtime and its record. */
const UNTOUCHED = [
  'title', 'prompt', 'provider', 'provider_builtin', 'status', 'end_reason', 'runtime_session_id',
  'num_turns', 'model', 'effort', 'permission_mode', 'pinned_at', 'completed_at', 'task_id',
  'parent_session_id', 'commit_status',
];

test('moving a session to another workspace: the panel, the move, its refusals and the old checkout', {
  skip: !URL, concurrency: 1, timeout: 480_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const server: PrismaClient = prismaClientFor(url);
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close().catch(() => undefined);
    await server.$disconnect().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  const prisma = server as unknown as PrismaService;
  const pub = uuidToBase62;

  // ── the world ──────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  const otherId = randomUUID();
  for (const [id, name] of [[ownerId, 'owner'], [otherId, 'other']] as const) {
    await db.user.create({
      data: { id, email: `${name}-${RUN}-${id}@session-move.invalid`, name, passwordHash: 'x' },
    });
  }

  // The Claude account the sessions' own workspace runs them on, one the runner added.
  const SLOT = 'a1b2c3d4';
  const engines = (codexInstalled: boolean) => [
    {
      engine: 'claude', installed: true, auth: 'yes',
      accounts: [
        { id: 'default', home: '/home/orbit/.claude', auth: 'yes' },
        { id: SLOT, home: `/home/orbit/.orbit/claude/${SLOT}`, auth: 'yes' },
      ],
    },
    {
      engine: 'codex', installed: codexInstalled, auth: codexInstalled ? 'yes' : 'unknown',
      accounts: [{ id: 'default', home: '/home/orbit/.codex', auth: 'yes' }],
    },
  ];
  const MOVE = 'session-move/v1';
  const runners = {
    wikova: randomUUID(), // the sessions' own: takes moves, runs Claude and Codex
    macMini: randomUUID(), // another that takes moves, with no Codex installed
    oldBox: randomUUID(), // one too old to take a move, which reports Claude alone
    sleepy: randomUUID(), // takes moves, runs both, and has not been heard from in an hour
    theirs: randomUUID(), // another owner's
  };
  const machines: Array<[string, string, string, Record<string, unknown>]> = [
    [runners.wikova, 'wikova', ownerId, { capabilities: ['session-codex-steer-v1', MOVE], engines: engines(true) }],
    [runners.macMini, 'mac-mini', ownerId, { capabilities: [MOVE], engines: engines(false) }],
    [runners.oldBox, 'old-box', ownerId, { capabilities: [], engines: engines(true).slice(0, 1) }],
    [runners.sleepy, 'sleepy', ownerId, {
      capabilities: [MOVE], engines: engines(true), lastHeartbeatAt: new Date(Date.now() - 3_600_000),
    }],
    [runners.theirs, 'theirs', otherId, { capabilities: [MOVE], engines: engines(true) }],
  ];
  for (const [id, label, owner, extra] of machines) {
    await db.runner.create({
      data: {
        id, ownerId: owner, name: `${label}-${RUN}`, displayName: label, tokenHash: `session-move-${id}`,
        status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilitiesReportedAt: new Date(),
        ...extra,
      } as never,
    });
  }

  const ws = {
    home: randomUUID(), // the sessions' own: wikova, isolated, its Claude sessions on SLOT
    sibling: randomUUID(), // wikova, isolated
    notes: randomUUID(), // wikova, not isolated
    site: randomUUID(), // mac-mini
    old: randomUUID(), // old-box
    nap: randomUUID(), // sleepy
    off: randomUUID(), // wikova, disabled
    bare: randomUUID(), // on no runner
    gone: randomUUID(), // wikova, deleted
    theirs: randomUUID(), // another owner's
  };
  const places: Array<[string, string, string | null, Record<string, unknown>]> = [
    [ws.home, 'home', runners.wikova, { enableWorktree: true, claudeAccount: SLOT }],
    [ws.sibling, 'sibling', runners.wikova, { enableWorktree: true }],
    [ws.notes, 'notes', runners.wikova, { enableWorktree: false }],
    [ws.site, 'site', runners.macMini, { enableWorktree: true }],
    [ws.old, 'old', runners.oldBox, { enableWorktree: true }],
    [ws.nap, 'nap', runners.sleepy, { enableWorktree: true }],
    [ws.off, 'off', runners.wikova, { enableWorktree: true, enabled: false }],
    [ws.bare, 'bare', null, {}],
    [ws.gone, 'gone', runners.wikova, { deletedAt: new Date() }],
  ];
  let position = 0;
  for (const [id, label, runnerId, extra] of places) {
    await db.workspace.create({
      data: {
        id, ownerId, runnerId, name: `${label} ${RUN}`, workDir: `/srv/${label}`, enabled: true,
        position: position++, ...extra,
      } as never,
    });
  }
  await db.workspace.create({
    data: { id: ws.theirs, ownerId: otherId, runnerId: runners.theirs, name: `theirs ${RUN}`, enabled: true },
  });

  async function folder(workspaceId: string, name: string, owner = ownerId): Promise<string> {
    const id = randomUUID();
    await db.sessionFolder.create({ data: { id, ownerId: owner, workspaceId, name } });
    return id;
  }
  const here = await folder(ws.home, 'Here');
  const bugs = await folder(ws.sibling, 'Bugs');
  const infra = await folder(ws.sibling, 'Infra');
  const elsewhere = await folder(ws.theirs, 'Elsewhere', otherId);

  /**
   * A session written straight into the table: by default an ended Claude conversation in `home`
   * on wikova, with what its runner reported about the checkout it ran in — every column a move
   * clears is set, so that clearing it is visible.
   */
  async function conversation(title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const branch = `orbit/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${RUN}`;
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId: ws.home, assignedRunnerId: runners.wikova,
        title, prompt: title, provider: 'claude', providerBuiltin: true,
        status: RunStatus.CANCELLED, endReason: 'ended', startedAt: new Date(Date.now() - 600_000),
        finishedAt: new Date(), numTurns: 3, runtimeSessionId: randomUUID(),
        model: 'claude-opus-5', effort: 'high', permissionMode: 'acceptEdits',
        dispatchOrigin: SessionDispatchOrigin.USER,
        branch, baseSha: 'b'.repeat(40), isolationStatus: 'worktree',
        changedFiles: [
          { path: 'src/a.ts', additions: 3, deletions: 1, status: 'M' },
          { path: 'src/b.ts', additions: 10, deletions: 0, status: 'A' },
          { path: 'README.md', additions: 1, deletions: 1, status: 'M' },
        ],
        branchMerged: false, worktreeBranch: branch, worktreeDirty: false,
        mergeTargets: ['develop', 'main'],
        mergeStatus: 'conflict', mergeError: 'CONFLICT (content): Merge conflict in src/a.ts',
        mergeRequestedAt: new Date(), mergeOperationId: randomUUID(), mergeRecoveryAction: 'preview',
        ...extra,
      } as never,
    });
    return id;
  }
  const row = async (id: string): Promise<Json> =>
    (await sql.query('SELECT * FROM session WHERE id = $1::uuid', [id])).rows[0];

  /** What the service announced, oldest first. The hub itself is stream-for-user.spec's subject. */
  const published: string[] = [];
  const announced = (): string[] => published.splice(0);
  const realtime = {
    forgetSessionOwner: (id: string) => { published.push(`forget ${id}`); },
    publishSessionUpdated: (id: string) => { published.push(`session_updated ${id}`); },
    publishWorkspaceChanged: (sessionId: string, workspaceId: string, affectsTaskRows: boolean) => {
      published.push(`workspace_changed ${sessionId} ${workspaceId} ${affectsTaskRows}`);
    },
  } as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined };

  // ── the app: the real controller, main.ts's middleware, pipe, interceptors and filters ───────
  const sessions = new SessionsService(prisma, queue as never, realtime);
  @Module({
    controllers: [SessionsController],
    providers: [
      { provide: SessionsService, useValue: sessions },
      // SessionsController's other dependencies: the routes used here touch none of them.
      { provide: PrismaService, useValue: {} },
      { provide: RealtimeService, useValue: {} },
      { provide: SessionTagsService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
      { provide: AutoRetryService, useValue: {} },
      JwtAuthGuard,
      Reflector,
      // `Bearer other` is the second account; any other bearer is the owner.
      { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token === 'other' ? otherId : ownerId }) } },
    ],
  })
  class SessionMoveHarness {}

  app = await NestFactory.create(SessionMoveHarness, { logger: ['error'], abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const owner = (method: string, p: string, body?: unknown) => send(base, method, `/api${p}`, { as: 'owner', body });
  const other = (method: string, p: string, body?: unknown) => send(base, method, `/api${p}`, { as: 'other', body });
  const move = (sessionId: string, body: unknown) => owner('POST', `/sessions/${pub(sessionId)}/move`, body);
  const targetsOf = (sessionId: string) => owner('GET', `/sessions/${pub(sessionId)}/move-targets`);

  // The runner's own door, called as RunnerAuthGuard would hand it the asking runner.
  const runnerApi = new RunnerApiController(
    prisma, queue as never, realtime, {} as never, {} as never, {} as never,
  );
  const removable = async (runnerId: string, ids: string[]): Promise<string[]> =>
    (await runnerApi.worktreesRemovable({ id: runnerId }, { ids })).removable;

  /** A move the rules refuse: the panel says why, the move answers 409 with the same words, and
   *  nothing is written or announced. */
  async function refused(id: string, to: string, reason: string, panel: 'session' | 'target' = 'session') {
    const before = await row(id);
    const shown = await targetsOf(id);
    assert.equal(shown.status, 200, shown.text);
    if (panel === 'session') {
      assert.equal(shown.json.reason, reason, `the panel's reason for ${before.title}`);
      assert.equal(shown.json.needsEnd, false);
    } else {
      const target = (shown.json.targets as Json[]).find((w) => w.workspaceId === pub(to));
      assert.equal(target?.reason, reason, `the panel's reason for ${before.title} → ${to}`);
    }
    const answer = await move(id, { workspaceId: pub(to) });
    assert.equal(answer.status, 409, `${before.title}: ${answer.text}`);
    assert.equal(answer.json.message, reason, `the move's reason for ${before.title}`);
    assert.deepEqual(await row(id), before, `${before.title}: a refused move wrote to the session`);
    assert.deepEqual(announced(), [], `${before.title}: a refused move announced something`);
  }

  await t.test('(1) the panel: folders, every other workspace and why not, and what stays behind', async () => {
    const panel = await conversation('Panel', { folderId: here });
    await conversation('Trashed in here', { folderId: here, deletedAt: new Date() });
    // Sibling's: two filed and one in Trash; its newest session ran on Codex, which is its badge.
    await conversation('Filed', { workspaceId: ws.sibling, folderId: bugs });
    await conversation('Trashed in bugs', { workspaceId: ws.sibling, folderId: bugs, deletedAt: new Date() });
    await conversation('Filed on Codex', { workspaceId: ws.sibling, folderId: bugs, provider: 'codex' });

    const shown = await targetsOf(panel);
    assert.equal(shown.status, 200, shown.text);
    const { targets, folders, ...rest } = shown.json;
    assert.deepEqual(
      {
        workspaceId: rest.workspaceId, folderId: rest.folderId, reason: rest.reason, needsEnd: rest.needsEnd,
        branch: rest.branch, changedFiles: rest.changedFiles, unmergedFiles: rest.unmergedFiles,
        mergeTarget: rest.mergeTarget,
      },
      {
        workspaceId: pub(ws.home), folderId: pub(here), reason: null, needsEnd: false,
        branch: (await row(panel)).branch, changedFiles: 3, unmergedFiles: 3, mergeTarget: 'main',
      },
    );
    // (PublicIdInterceptor answers every `id` with a `publicId` beside it, which is not this spec's.)
    const folderView = (list: Json[]) => list.map((f) => ({ id: f.id, name: f.name, sessionCount: f.sessionCount }));
    assert.deepEqual(folderView(folders), [{ id: pub(here), name: 'Here', sessionCount: 1 }]);
    const pick = (w: Json) => ({
      workspaceId: w.workspaceId, name: w.name, provider: w.provider, runnerId: w.runnerId,
      runnerName: w.runnerName, runnerOnline: w.runnerOnline, workDir: w.workDir, reason: w.reason,
      conversation: w.conversation, folders: folderView(w.folders),
    });
    const target = (
      id: string, label: string, runnerId: string | null, runnerName: string | null,
      extra: Partial<Json> = {},
    ) => ({
      workspaceId: pub(id), name: `${label} ${RUN}`, provider: 'claude', runnerId: runnerId && pub(runnerId),
      runnerName, runnerOnline: runnerId != null, workDir: `/srv/${label}`, reason: null,
      conversation: runnerId === runners.wikova ? 'continues' : 'rebuilt', folders: [], ...extra,
    });
    // In the sidebar's order; deleted workspaces, another owner's and the session's own are not offered.
    assert.deepEqual((targets as Json[]).map(pick), [
      target(ws.sibling, 'sibling', runners.wikova, 'wikova', {
        provider: 'codex',
        folders: [{ id: pub(bugs), name: 'Bugs', sessionCount: 2 }, { id: pub(infra), name: 'Infra', sessionCount: 0 }],
      }),
      target(ws.notes, 'notes', runners.wikova, 'wikova'),
      target(ws.site, 'site', runners.macMini, 'mac-mini'),
      target(ws.old, 'old', runners.oldBox, 'old-box', { reason: 'Update old-box to move sessions here' }),
      target(ws.nap, 'nap', runners.sleepy, 'sleepy', { runnerOnline: false }),
      target(ws.off, 'off', runners.wikova, 'wikova', { reason: 'This workspace is disabled.' }),
      target(ws.bare, 'bare', null, null, { reason: 'This workspace has no runner.' }),
    ]);

    // What the confirmation says about the code: merged work, and a merge target chosen for it.
    const merged = await conversation('Merged', { branchMerged: true, mergeTarget: 'release' });
    const mergedPanel = (await targetsOf(merged)).json;
    assert.deepEqual(
      [mergedPanel.changedFiles, mergedPanel.unmergedFiles, mergedPanel.mergeTarget],
      [3, 0, 'release'],
    );
    // A session that ran in the shared directory has no branch to leave its changes on.
    const shared = await conversation('Shared', {
      workspaceId: ws.notes, branch: null, isolationStatus: null, worktreeBranch: null, changedFiles: null,
    });
    const sharedPanel = (await targetsOf(shared)).json;
    assert.deepEqual(
      [sharedPanel.branch, sharedPanel.changedFiles, sharedPanel.unmergedFiles, sharedPanel.mergeTarget],
      [null, 0, 0, null],
    );

    // Nobody else's to look at.
    assert.equal((await other('GET', `/sessions/${pub(panel)}/move-targets`)).status, 404);
    assert.equal((await targetsOf(randomUUID())).status, 404);
    assert.deepEqual(announced(), []);
  });

  await t.test('(2) on the same runner: every §5.4 column, nothing else, and both workspaces announced', async () => {
    const id = await conversation('Same runner', { folderId: here, mergeTarget: 'develop' });
    const before = await row(id);
    for (const column of OLD_CHECKOUT.filter((c) => !['merge_recovery', 'merge_operation_owner', 'merged_at', 'merged_source_sha'].includes(c))) {
      assert.notEqual(before[column], null, `the fixture should set ${column}`);
    }
    assert.equal(before.claude_account, null, 'the fixture session follows its workspace');

    const moved = await move(id, { workspaceId: pub(ws.sibling), folderId: pub(bugs) });
    assert.equal(moved.status, 201, moved.text);
    assert.deepEqual(
      { id: moved.json.id, workspaceId: moved.json.workspaceId, folderId: moved.json.folderId },
      { id: pub(id), workspaceId: pub(ws.sibling), folderId: pub(bugs) },
    );

    const after = await row(id);
    assert.equal(after.workspace_id, ws.sibling);
    assert.equal(after.folder_id, bugs);
    assert.equal(after.assigned_runner_id, runners.wikova, "the target workspace's runner");
    assert.equal(after.branch, before.branch, 'both workspaces isolate: the branch keeps its name');
    for (const column of OLD_CHECKOUT) assert.equal(after[column], null, `${column} still describes the old checkout`);
    assert.deepEqual(after.merge_targets, []);
    // It ran on its workspace's account; on the same machine it stays there rather than follow the
    // new workspace (which names none, i.e. Default).
    assert.equal(after.claude_account, SLOT);
    assert.equal(after.claude_account_pinned, false);
    assert.equal(after.codex_account, null);
    for (const column of UNTOUCHED) assert.deepEqual(after[column], before[column], `${column} changed`);

    assert.deepEqual(announced(), [
      `forget ${id}`,
      `session_updated ${id}`,
      `workspace_changed ${id} ${ws.home} false`,
      `workspace_changed ${id} ${ws.sibling} false`,
    ]);
    // It is where the panel now starts from.
    const panel = (await targetsOf(id)).json;
    assert.equal(panel.workspaceId, pub(ws.sibling));
    assert.equal(panel.folderId, pub(bugs));
    assert.ok((panel.targets as Json[]).some((w) => w.workspaceId === pub(ws.home)), 'the old workspace is a target now');
  });

  await t.test('(3) to another runner: accounts cleared, and the old runner may reclaim its checkout', async () => {
    const id = await conversation('Other runner', {
      folderId: here, claudeAccount: SLOT, claudeAccountPinned: true, codexAccount: 'default', codexAccountPinned: true,
    });
    const before = await row(id);
    // Its own runner keeps its checkout: the session is still wikova's.
    assert.deepEqual(await removable(runners.wikova, [id]), []);

    const moved = await move(id, { workspaceId: pub(ws.site) });
    assert.equal(moved.status, 201, moved.text);
    const after = await row(id);
    assert.equal(after.workspace_id, ws.site);
    assert.equal(after.folder_id, null, 'no folder named: none');
    assert.equal(after.assigned_runner_id, runners.macMini);
    assert.equal(after.branch, before.branch);
    for (const column of OLD_CHECKOUT) assert.equal(after[column], null, `${column} still describes the old checkout`);
    // An account id names a slot on one machine: cleared, to follow the new workspace.
    assert.deepEqual(
      [after.claude_account, after.claude_account_pinned, after.codex_account, after.codex_account_pinned],
      [null, false, null, false],
    );
    for (const column of UNTOUCHED) assert.deepEqual(after[column], before[column], `${column} changed`);
    assert.deepEqual(announced(), [
      `forget ${id}`,
      `session_updated ${id}`,
      `workspace_changed ${id} ${ws.home} false`,
      `workspace_changed ${id} ${ws.site} false`,
    ]);

    // The checkout wikova still holds is leftover now; the one mac-mini makes is the session's.
    const open = await conversation('Still on wikova');
    assert.deepEqual(await removable(runners.wikova, [id, open, 'not-a-uuid']), [id, 'not-a-uuid']);
    assert.deepEqual(await removable(runners.macMini, [id]), []);
    // Ended and Completed is leftover wherever it is, as it always was.
    await sql.query('UPDATE session SET completed_at = now() WHERE id = $1::uuid', [id]);
    assert.deepEqual(await removable(runners.macMini, [id]), [id]);
  });

  await t.test('(4) the branch changes only where the two worktree settings differ', async () => {
    const isolated = await conversation('Into shared');
    const out = await move(isolated, { workspaceId: pub(ws.notes) });
    assert.equal(out.status, 201, out.text);
    assert.equal((await row(isolated)).branch, null, 'a workspace that does not isolate runs it with no branch');

    const plain = await conversation('Out of shared', {
      workspaceId: ws.notes, branch: null, isolationStatus: null, worktreeBranch: null, changedFiles: null,
    });
    const into = await move(plain, { workspaceId: pub(ws.sibling) });
    assert.equal(into.status, 201, into.text);
    assert.match((await row(plain)).branch, /^orbit\/out-of-shared-[0-9a-f]{6}$/, 'one that isolates gives it a branch');
    announced();
  });

  await t.test('(5) Codex: within its runner, on the account it ran on; never to another runner', async () => {
    const codex = await conversation('Codex', { provider: 'codex', runtimeSessionId: `thread-${RUN}` });
    const shown = await targetsOf(codex);
    assert.equal(shown.status, 200, shown.text);
    assert.equal(shown.json.reason, null);
    const reasons = Object.fromEntries((shown.json.targets as Json[]).map((w) => [w.workspaceId, w.reason]));
    assert.equal(reasons[pub(ws.sibling)], null);
    assert.equal(reasons[pub(ws.site)], "mac-mini can't run Codex");
    // old-box reports no Codex at all — too old to say — so what stops it is where the thread lives.
    assert.equal(reasons[pub(ws.old)], 'Codex keeps this conversation on wikova');
    assert.equal(reasons[pub(ws.nap)], 'Codex keeps this conversation on wikova');

    await refused(codex, ws.site, "mac-mini can't run Codex", 'target');
    await refused(codex, ws.nap, 'Codex keeps this conversation on wikova', 'target');
    const moved = await move(codex, { workspaceId: pub(ws.sibling) });
    assert.equal(moved.status, 201, moved.text);
    const after = await row(codex);
    assert.equal(after.assigned_runner_id, runners.wikova);
    assert.equal(after.codex_account, 'default', "the account its thread lives in, the runner's own");
    assert.equal(after.runtime_session_id, `thread-${RUN}`);
    announced();
  });

  await t.test('(6) the session itself: every §5.2 rule refuses with its reason; a child moves', async () => {
    const LIVE = { endReason: null, finishedAt: null };
    const taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId, ownerId, title: `task ${RUN}`, creatorType: 'USER', creatorId: ownerId,
        assigneeId: ws.home, completionCriterion: 'EVIDENCE_JUDGMENT',
      } as never,
    });
    const STOP = 'Stop the session first.';
    const cases: Array<[string, string, Record<string, unknown>, ((id: string) => Promise<void>)?]> = [
      ['running', STOP, { ...LIVE, status: RunStatus.RUNNING }],
      ['generating on its own', STOP, { ...LIVE, status: RunStatus.AWAITING_INPUT, engineTurnActive: true }],
      ['waiting to start', STOP, { ...LIVE, status: RunStatus.PENDING }],
      ['a message queued', STOP, { ...LIVE, status: RunStatus.AWAITING_INPUT }, async (id) => {
        await db.conversationTurn.create({
          data: { sessionId: id, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: 'next', status: 'PENDING' },
        });
      }],
      // Without its approval this same session is refused for its background task (below).
      ['an approval being asked', STOP, { ...LIVE, status: RunStatus.AWAITING_INPUT, runningBgShells: ['toolu_bg'] }, async (id) => {
        await db.approval.create({
          data: { sessionId: id, toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseId: 'toolu_ask', backgroundJobId: 'toolu_bg' },
        });
      }],
      ['ending', 'The session is ending. Try again in a moment.', { ...LIVE, status: RunStatus.AWAITING_INPUT, cancelRequestedAt: new Date() }],
      ['a background task', 'Background tasks are still running.', { ...LIVE, status: RunStatus.AWAITING_INPUT, runningBgShells: ['toolu_bg'] }],
      ['in Trash', 'Restore the session from Trash first.', { deletedAt: new Date() }],
      ['still importing', 'The session is still being imported.', { importSourceCwd: '/home/orbit/old-project' }],
      ['a task run', "A task run stays in its task's workspace.", { taskId }],
      ['a project coordinator', "A project's coordinator stays in its project's workspace.", {}, async (id) => {
        const projectId = randomUUID();
        await db.project.create({
          data: {
            id: projectId, ownerId, title: `coordinated ${RUN}`, coordinatorEnabled: true,
            coordinatorWorkspaceId: ws.home, coordinatorSessionId: id,
          } as never,
        });
        await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
      }],
      ['a merge in progress', 'A merge is in progress. Try again when it finishes.', { mergeStatus: 'pending' }],
      ['a commit in progress', 'A commit is in progress. Try again when it finishes.', { commitStatus: 'pending', commitRequestedAt: new Date() }],
      ['a merge repair open', 'Finish the merge repair first.', { mergeRecovery: { code: 'TARGET_DIVERGED', targetBranch: 'main' } }],
      ['an automatic retry armed', 'An automatic retry is scheduled. Try again after it runs.', {
        status: RunStatus.FAILED, endReason: null, retryAt: new Date(Date.now() + 60_000),
      }],
      ['Kimi', "Moving Kimi sessions isn't supported yet.", { provider: 'kimi', providerBuiltin: true }],
      ['OpenCode', "Moving OpenCode sessions isn't supported yet.", { provider: 'opencode' }],
    ];
    for (const [title, reason, extra, after] of cases) {
      const id = await conversation(title, extra);
      await after?.(id);
      await refused(id, ws.sibling, reason);
    }

    // Idle but not ended: the panel offers End and Move, and the move itself waits for the end.
    const idle = await conversation('Idle', { ...LIVE, status: RunStatus.AWAITING_INPUT });
    const offered = (await targetsOf(idle)).json;
    assert.deepEqual([offered.reason, offered.needsEnd], [null, true]);
    const early = await move(idle, { workspaceId: pub(ws.sibling) });
    assert.equal(early.status, 409, early.text);
    assert.equal(early.json.message, 'End the session first.');
    assert.equal((await row(idle)).workspace_id, ws.home);
    // …which is the old runner's to do, so it has to be up.
    const asleep = await conversation('Idle asleep', {
      ...LIVE, status: RunStatus.AWAITING_INPUT, workspaceId: ws.nap, assignedRunnerId: runners.sleepy,
    });
    const stuck = (await targetsOf(asleep)).json;
    assert.deepEqual([stuck.reason, stuck.needsEnd], ['sleepy has to be online to end the session first.', true]);
    // Once ended, it moves — the second half of End and Move.
    await sql.query(
      "UPDATE session SET status = 'CANCELLED', end_reason = 'ended', finished_at = now() WHERE id = $1::uuid",
      [idle],
    );
    const settled = (await targetsOf(idle)).json;
    assert.deepEqual([settled.reason, settled.needsEnd], [null, false]);
    assert.equal((await move(idle, { workspaceId: pub(ws.sibling) })).status, 201);
    assert.equal((await row(idle)).workspace_id, ws.sibling);
    announced();

    // An ended session needs nothing of its old runner, online or not.
    const endedAsleep = await conversation('Ended asleep', { workspaceId: ws.nap, assignedRunnerId: runners.sleepy });
    assert.equal((await targetsOf(endedAsleep)).json.reason, null);
    const woke = await move(endedAsleep, { workspaceId: pub(ws.sibling) });
    assert.equal(woke.status, 201, woke.text);
    assert.equal((await row(endedAsleep)).assigned_runner_id, runners.wikova);
    // A retryAt the sweeper would never act on (an ended, not failed, session) is no retry.
    const staleRetry = await conversation('Stale retry', { retryAt: new Date(Date.now() - 60_000) });
    assert.equal((await targetsOf(staleRetry)).json.reason, null);
    // A spawned child can live in another workspace from the start, and moves like any session.
    const parent = await conversation('Parent');
    const child = await conversation('Child', { parentSessionId: parent, rootSessionId: parent, spawnDepth: 1 });
    const spawned = await move(child, { workspaceId: pub(ws.sibling) });
    assert.equal(spawned.status, 201, spawned.text);
    assert.equal((await row(child)).workspace_id, ws.sibling);
    announced();
  });

  await t.test('(7) the target: every §5.2 rule refuses with its reason; an offline runner does not', async () => {
    const id = await conversation('Targets');
    await refused(id, ws.old, 'Update old-box to move sessions here', 'target');
    await refused(id, ws.off, 'This workspace is disabled.', 'target');
    await refused(id, ws.bare, 'This workspace has no runner.', 'target');
    // Not offered at all, and refused when asked for anyway.
    for (const [to, reason] of [
      [ws.gone, 'This workspace was deleted.'],
      [ws.theirs, 'Workspace not found.'],
      [randomUUID(), 'Workspace not found.'],
    ] as const) {
      const before = await row(id);
      const answer = await move(id, { workspaceId: pub(to) });
      assert.equal(answer.status, 409, answer.text);
      assert.equal(answer.json.message, reason);
      assert.deepEqual(await row(id), before);
    }
    // A folder has to be one of the target workspace's.
    for (const folderId of [here, elsewhere, randomUUID()]) {
      const answer = await move(id, { workspaceId: pub(ws.sibling), folderId: pub(folderId) });
      assert.equal(answer.status, 400, answer.text);
      assert.match(answer.json.message, /folderId/);
    }
    assert.equal((await row(id)).workspace_id, ws.home);
    assert.deepEqual(announced(), []);
    // Another owner moves nothing of mine.
    const theirs = await send(base, 'POST', `/api/sessions/${pub(id)}/move`, { as: 'other', body: { workspaceId: pub(ws.theirs) } });
    assert.equal(theirs.status, 404, theirs.text);

    // The runner being offline only means the next message waits for it.
    const moved = await move(id, { workspaceId: pub(ws.nap) });
    assert.equal(moved.status, 201, moved.text);
    assert.equal((await row(id)).assigned_runner_id, runners.sleepy);
    announced();
  });

  /** Wait until a statement matching `query` is waiting for a lock — the move, parked behind `holder`. */
  async function waitForLock(query: string): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const waiting = await sql.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
        [query],
      );
      if (waiting.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`nothing waited for a lock on ${query}`);
  }

  await t.test('(8) the rules are asked again under the locks', async () => {
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    try {
      // The session wakes up while the move waits for it: refused for what it is now.
      const waking = await conversation('Waking');
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM session WHERE id = $1::uuid FOR UPDATE', [waking]);
      await holder.query(
        "UPDATE session SET status = 'RUNNING', end_reason = NULL, finished_at = NULL WHERE id = $1::uuid",
        [waking],
      );
      const blocked = move(waking, { workspaceId: pub(ws.sibling) });
      await waitForLock('%FROM "session"%FOR NO KEY UPDATE%');
      await holder.query('COMMIT');
      const woke = await blocked;
      assert.equal(woke.status, 409, woke.text);
      assert.equal(woke.json.message, 'Stop the session first.');
      assert.equal((await row(waking)).workspace_id, ws.home);

      // The workspace is disabled while the move waits for it: refused for that.
      const late = await conversation('Late');
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM workspace WHERE id = $1::uuid FOR UPDATE', [ws.sibling]);
      await holder.query('UPDATE workspace SET enabled = false WHERE id = $1::uuid', [ws.sibling]);
      const waiting = move(late, { workspaceId: pub(ws.sibling) });
      await waitForLock('%FROM "workspace"%FOR SHARE%');
      await holder.query('COMMIT');
      const turnedOff = await waiting;
      assert.equal(turnedOff.status, 409, turnedOff.text);
      assert.equal(turnedOff.json.message, 'This workspace is disabled.');
      assert.equal((await row(late)).workspace_id, ws.home);
      assert.deepEqual(announced(), []);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.query('UPDATE workspace SET enabled = true WHERE id = $1::uuid', [ws.sibling]).catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
  });
});

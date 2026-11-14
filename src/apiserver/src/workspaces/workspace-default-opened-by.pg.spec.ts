import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { CreatorType, Prisma, PrismaClient, RunnerStatus } from '@prisma/client';
import type { RunnerEngineHealth } from '@orbit/shared';
import { Client } from 'pg';

import { FeishuDirectService } from '../feishu/feishu-direct.service';
import { FeishuGroupService } from '../feishu/feishu-group.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { dependentReadyFact } from '../projects/coordinator-wake';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectsService } from '../projects/projects.service';
import { encryptSecret } from '../providers/provider-crypto';
import { SessionsService } from '../sessions/sessions.service';
import { TaskListsService } from '../task-lists/task-lists.service';
import { TasksService } from '../tasks/tasks.service';
import { WikiChat } from '../wiki/wiki-chat';
import { WorkspacesService } from './workspaces.service';

/**
 * The workspace default counts only conversations a person opened (docs/workspace-default-model-design.md
 * §2.2, §2.4; migration 0670), against a real PostgreSQL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/workspaces/workspace-default-opened-by.pg.spec.ts
 *
 * Every door Orbit opens a conversation through on its own — a project's coordinator, a coordinator
 * judgment, a wiki chat, a Feishu direct message and group mention, a task list's console, a service
 * token, an @-mention's reply — is driven through its real service, and the workspace payload
 * (WorkspacesService.list / get, both through withProviderSeed) is read after each: lastEngine,
 * lastProvider and lastModel must still be the ones of the conversation a person last opened. A
 * person's own new session (SessionsService.create, the composer's door) then moves all three.
 *
 * Most Orbit doors start on the workspace default itself, so the row they write would agree with the
 * default whether or not it counted. Each such row is therefore re-pointed to another engine,
 * credential and model (a fixture write past the engine-never-changes trigger) and made the newest
 * conversation of the workspace before the payload is read:
 * a default that counted it would answer that, and the assertion would see it. The two doors that
 * take an engine from their caller (wiki chat, service token) are asked for the other engine outright.
 *
 * Destructive: COORDINATOR_PG_URL must pass coordinator-pg-test-safety and point at a disposable
 * database with all migrations applied.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
// The Feishu app row stores its secret encrypted.
process.env.PROVIDER_SECRET_KEY ??= 'workspace-default-opened-by-pg-spec';

const silent = (): unknown =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) });
const allow = async () => ({ allowed: true as const });

/** A runner with both engines installed and signed in. */
const ENGINES: RunnerEngineHealth[] = [
  { engine: 'codex', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' }] },
  { engine: 'claude', installed: true, auth: 'yes', accounts: [{ id: 'default', home: '/root/.claude', auth: 'yes' }] },
] as RunnerEngineHealth[];

/** What a person chose: the default every Orbit door below must leave alone. */
const CHOSEN = { engine: 'codex', provider: 'codex', model: 'gpt-5.5' };
/** What each Orbit-opened conversation runs on instead. */
const OTHER = { engine: 'claude', provider: 'claude', model: 'claude-opus-5-5' };

/** The backfill statement exactly as migration 0670 runs it. */
function backfillStatement(): string {
  const sql = readFileSync(join(__dirname, '../../prisma/migrations/0670_session_opened_by/migration.sql'), 'utf8');
  const start = sql.indexOf('UPDATE "session" s');
  const end = sql.indexOf(';', start);
  assert.ok(start > 0 && end > start, 'migration 0670 carries its backfill UPDATE');
  return sql.slice(start, end);
}

test('only a conversation a person opened moves the workspace default, its model included', {
  skip, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const db = prisma as unknown as PrismaService;
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── the world: one account, one machine with both engines, one workspace every door opens in ──────
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await prisma.user.create({ data: { id: ownerId, email: `opened-by-${ownerId}@workspace-default.invalid`, name: 'The owner', passwordHash: 'x' } });
  await prisma.runner.create({
    data: {
      id: runnerId, ownerId, name: 'the machine', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      engines: ENGINES as unknown as Prisma.InputJsonValue,
    },
  });
  // A repository and worktrees, which a wiki chat requires of its workspace.
  await prisma.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: 'orbit-develop', enabled: true, workDir: '/srv/orbit',
      repoUrl: 'https://github.com/acme/orbit.git', enableWorktree: true,
    },
  });

  const queue = { notifySessionQueued: () => undefined };
  const sessions = new SessionsService(db, queue as never, silent() as never);
  const tasks = new TasksService(db, sessions, silent() as never);
  const projects = new ProjectsService(db, new ProjectAcceptanceService(db), sessions, silent() as never);
  const workspaces = new WorkspacesService(db);

  // Every conversation is made the newest one when it is opened: one second after the last.
  let clock = Date.now() - 3_600_000;
  const opened: Array<{ id: string; door: string }> = [];
  async function newest(id: string, door: string): Promise<void> {
    clock += 1_000;
    await prisma.session.update({ where: { id }, data: { createdAt: new Date(clock) } });
    opened.push({ id, door });
  }

  /** The workspace payload as the list and the detail both serve it. */
  async function payload(label: string) {
    const listed = (await workspaces.list(ownerId, [workspaceId])).find((w) => w.id === workspaceId);
    const detail = await workspaces.get(ownerId, workspaceId);
    assert.ok(listed, `${label}: the workspace is listed`);
    const pick = (w: { lastEngine: unknown; lastProvider: unknown; lastModel: unknown }) =>
      ({ engine: w.lastEngine, provider: w.lastProvider, model: w.lastModel });
    assert.deepEqual(pick(detail as never), pick(listed as never), `${label}: list and detail agree`);
    return pick(listed as never);
  }

  async function openedBy(id: string): Promise<string> {
    return (await prisma.session.findUniqueOrThrow({ where: { id }, select: { openedBy: true } })).openedBy;
  }

  /** An Orbit door's row: classified, re-pointed off the default, made newest, and the default unmoved. */
  async function orbitDoor(id: string, door: string, expected: string, repoint = true): Promise<void> {
    assert.equal(await openedBy(id), expected, `${door}: the door records who opened it`);
    if (repoint) {
      // A session's engine never changes (a trigger refuses it), and these doors start on the default
      // itself. The re-point is a fixture write, not a product path: it stands for a door that opened on
      // another engine, so the row is written with the triggers off on this connection alone.
      await sql.query('BEGIN');
      try {
        await sql.query("SET LOCAL session_replication_role = 'replica'");
        await sql.query('UPDATE "session" SET "engine" = $2, "provider" = $3, "model" = $4 WHERE "id" = $1::uuid',
          [id, OTHER.engine, OTHER.provider, OTHER.model]);
        await sql.query('COMMIT');
      } catch (e) {
        await sql.query('ROLLBACK');
        throw e;
      }
    }
    await newest(id, door);
    const row = await prisma.session.findUniqueOrThrow({ where: { id }, select: { engine: true, provider: true, model: true } });
    assert.deepEqual(row, OTHER, `${door}: the row itself runs on another engine, credential and model`);
    assert.deepEqual(await payload(door), CHOSEN, `${door}: lastEngine/lastProvider/lastModel are unchanged`);
  }

  async function task(title: string, data: Partial<Prisma.TaskUncheckedCreateInput> = {}): Promise<string> {
    return (await prisma.task.create({
      data: { ownerId, title, creatorType: CreatorType.USER, creatorId: ownerId, assigneeId: workspaceId, completionCriterion: 'EVIDENCE_JUDGMENT', ...data },
      select: { id: true },
    })).id;
  }

  await t.test('a person opens a conversation: the workspace default is its engine, credential and model', async () => {
    const mine = await sessions.create(ownerId, { workspaceId, prompt: 'ask GPT something', ...CHOSEN } as never, { source: 'user' });
    assert.equal(await openedBy(mine.id), 'PERSON');
    await newest(mine.id, 'person');
    assert.deepEqual(await payload('the person’s conversation'), CHOSEN);
  });

  await t.test('a project coordinator', async () => {
    const projectId = randomUUID();
    await prisma.project.create({ data: { id: projectId, ownerId, title: 'the coordinated project', coordinatorEnabled: true } });
    const made = await projects.coordinator(ownerId, projectId, workspaceId);
    assert.equal(made.created, true);
    await orbitDoor(made.sessionId, 'coordinator', 'COORDINATOR');
  });

  await t.test('a coordinator judgment', async () => {
    const projectId = randomUUID();
    await prisma.project.create({
      data: { id: projectId, ownerId, title: 'the judged project', coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId },
    });
    const ready = await task('Judge whether it can start', { projectId });
    const judgments = new CoordinatorJudgmentService(db, new CoordinatorWakeService(db), sessions);
    const outcome = await judgments.wake(dependentReadyFact({ projectId, taskId: ready, title: 'Judge whether it can start', dispatchEpoch: 1 }), allow);
    assert.equal(outcome.outcome, 'OPENED', JSON.stringify(outcome));
    await orbitDoor((outcome as { sessionId: string }).sessionId, 'coordinator judgment', 'COORDINATOR_JUDGMENT');
  });

  await t.test('a wiki chat, asked for the other engine outright', async () => {
    const spaceId = randomUUID();
    await prisma.wikiSpace.create({ data: { id: spaceId, ownerId, slug: `orbit-${spaceId.slice(0, 8)}`, title: 'Orbit' } });
    await prisma.wikiSpaceWorkspace.create({ data: { spaceId, ownerId, workspaceId } });
    const answer = await new WikiChat(db, sessions).create(
      ownerId, spaceId,
      { content: 'what does the seed read?', clientTurnId: randomUUID(), workspaceId, engine: OTHER.engine, model: OTHER.model },
      null,
    ) as unknown as { sessionId: string };
    const row = await prisma.session.findUniqueOrThrow({ where: { id: answer.sessionId }, select: { engine: true, wikiChatSpaceId: true } });
    assert.equal(row.engine, OTHER.engine, 'the chat itself started on the engine it was asked for');
    assert.equal(row.wikiChatSpaceId, spaceId);
    await orbitDoor(answer.sessionId, 'wiki chat', 'WIKI_CHAT');
  });

  const feishuApp = { platform: 'FEISHU', appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}` };
  const ALICE = `ou_${randomBytes(8).toString('hex')}`;
  const outbound = { reply: async () => ({ ok: true }), send: async () => ({ ok: true }), userName: async () => null };

  await t.test('a Feishu direct message', async () => {
    await prisma.feishuApp.create({
      data: {
        ownerId, platform: feishuApp.platform, appId: feishuApp.appId, appSecretEnc: encryptSecret(feishuApp.appSecret),
        ownerOpenId: ALICE, ownerName: 'Alice', botName: 'Orbit bot', defaultWorkspaceId: workspaceId,
      },
    });
    const direct = new FeishuDirectService(db, silent() as never, outbound as never, sessions, silent() as never);
    const messageId = `om_${randomBytes(8).toString('hex')}`;
    await direct.handleMessage(
      { ownerId, appId: feishuApp.appId, platform: feishuApp.platform, appSecretEnc: encryptSecret(feishuApp.appSecret), ownerOpenId: ALICE, defaultWorkspaceId: workspaceId },
      { userId: ownerId, credential: { kind: 'FEISHU', appId: feishuApp.appId, openId: ALICE, messageId } },
      `ev_${randomUUID()}`,
      { event: { message: { message_id: messageId, chat_id: `oc_${randomBytes(6).toString('hex')}`, message_type: 'text', content: JSON.stringify({ text: 'run the checks' }) } } },
    );
    const made = await prisma.session.findFirstOrThrow({ where: { ownerId, prompt: 'run the checks' }, select: { id: true } });
    await orbitDoor(made.id, 'Feishu direct message', 'FEISHU');
  });

  await t.test('a Feishu group mention', async () => {
    const chatId = `oc_${randomBytes(6).toString('hex')}`;
    await prisma.feishuChatRoute.create({
      data: {
        ownerId, appId: feishuApp.appId, chatId, chatName: chatId, workspaceId, permissionMode: 'acceptEdits',
        allowedOpenIds: [], maxConcurrentSessions: 5, sessionsPerDay: 50, enabled: true, confirmedAt: new Date(),
      },
    });
    const group = new FeishuGroupService(db, outbound as never, sessions);
    const messageId = `om_${randomBytes(8).toString('hex')}`;
    await group.handleMention(
      { ownerId, appId: feishuApp.appId, platform: feishuApp.platform, appSecretEnc: encryptSecret(feishuApp.appSecret), ownerOpenId: ALICE, botName: 'Orbit bot' },
      { userId: ownerId, credential: { kind: 'FEISHU', appId: feishuApp.appId, openId: ALICE, messageId } },
      { ownerId, chatId, workspaceId, permissionMode: 'acceptEdits', allowedOpenIds: [] },
      { eventId: `ev_${randomUUID()}`, chatId, messageId, openId: ALICE, text: 'review the branch' },
    );
    const made = await prisma.session.findFirstOrThrow({ where: { ownerId, prompt: 'review the branch' }, select: { id: true } });
    await orbitDoor(made.id, 'Feishu group mention', 'FEISHU');
  });

  await t.test('a task list’s console', async () => {
    const list = await prisma.taskList.create({ data: { ownerId, title: 'the list with a console' }, select: { id: true } });
    const made = await new TaskListsService(db, silent() as never, sessions).console(ownerId, list.id, workspaceId);
    assert.equal(made.created, true);
    await orbitDoor(made.sessionId, 'task-list console', 'TASK_LIST_CONSOLE');
  });

  await t.test('a service token’s session, asked for the other engine outright', async () => {
    const token = await prisma.serviceToken.create({
      data: { ownerId, runnerId, workspaceId, label: 'bridge', scopes: ['session:create'], expiresAt: new Date(Date.now() + 86_400_000) },
      select: { id: true },
    });
    const made = await sessions.spawnForServiceToken(
      ownerId, { assignedRunnerId: runnerId, workspaceId, tokenId: token.id },
      { prompt: 'nightly report', engine: OTHER.engine, provider: OTHER.provider, model: OTHER.model },
    );
    assert.equal(made.engine, OTHER.engine, 'the bridge’s session itself started on the engine it was asked for');
    await orbitDoor(made.id, 'service token', 'SERVICE_TOKEN');
  });

  await t.test('an @-mention’s reply session', async () => {
    const about = await task('the task somebody mentions the agent on');
    const comment = await prisma.taskComment.create({
      data: { taskId: about, authorType: 'USER', authorId: ownerId, body: 'have a look', mentions: [workspaceId], mentionDeliveryVersion: 1 },
      select: { id: true },
    });
    await tasks.deliverMentions();
    const delivery = await prisma.taskCommentMentionDelivery.findFirstOrThrow({
      where: { commentId: comment.id }, select: { status: true, errorCode: true, targetSessionId: true },
    });
    assert.equal(delivery.errorCode, null);
    assert.equal(delivery.status, 'SESSION_CREATED');
    // The reply starts on the default it must not move: the person's choice, model included.
    const reply = await prisma.session.findUniqueOrThrow({ where: { id: delivery.targetSessionId! }, select: { engine: true, provider: true } });
    assert.deepEqual(reply, { engine: CHOSEN.engine, provider: CHOSEN.provider });
    await orbitDoor(delivery.targetSessionId!, '@-mention reply', 'MENTION_REPLY');
  });

  await t.test('a person opens another conversation: the default follows it, and a new session preselects it', async () => {
    const PICKED = { engine: 'claude', provider: 'claude', model: 'claude-sonnet-5-5' };
    const mine = await sessions.create(ownerId, { workspaceId, prompt: 'back to Claude', ...PICKED } as never, { source: 'user' });
    assert.equal(await openedBy(mine.id), 'PERSON');
    await newest(mine.id, 'person');
    assert.deepEqual(await payload('the person’s second conversation'), PICKED);

    // A session that names no engine starts where the payload says.
    const next = await sessions.create(ownerId, { workspaceId, prompt: 'and another' } as never, { source: 'user' });
    const row = await prisma.session.findUniqueOrThrow({ where: { id: next.id }, select: { engine: true, provider: true } });
    assert.deepEqual(row, { engine: PICKED.engine, provider: PICKED.provider });
    await prisma.session.delete({ where: { id: next.id } });
  });

  await t.test('migration 0670’s backfill classifies every door’s rows from the marks they leave', async () => {
    // As the rows stood before 0670: every one PERSON. One more Orbit-written conversation whose door
    // left nothing but prompt_by_orbit, which the backfill can only call ORBIT.
    const orphan = await sessions.create(ownerId, { workspaceId, prompt: 'an opening Orbit wrote' } as never, { source: 'user', promptByOrbit: true });
    const expected = new Map<string, string>(await Promise.all(opened.map(async (o) => [o.id, await openedBy(o.id)] as [string, string])));
    expected.set(orphan.id, 'ORBIT');
    const ids = [...expected.keys()];
    await prisma.session.updateMany({ where: { id: { in: ids } }, data: { openedBy: 'PERSON' } });
    await sql.query(backfillStatement());
    const rows = await prisma.session.findMany({ where: { id: { in: ids } }, select: { id: true, openedBy: true } });
    const doorOf = new Map(opened.map((o) => [o.id, o.door]));
    for (const row of rows) {
      assert.equal(row.openedBy, expected.get(row.id), `${doorOf.get(row.id) ?? 'prompt_by_orbit only'}: backfilled as its door wrote it`);
    }
    assert.equal(rows.length, ids.length);
    assert.deepEqual(new Set(expected.values()), new Set([
      'PERSON', 'COORDINATOR', 'COORDINATOR_JUDGMENT', 'WIKI_CHAT', 'FEISHU', 'TASK_LIST_CONSOLE', 'SERVICE_TOKEN', 'MENTION_REPLY', 'ORBIT',
    ]));
  });

  await t.test('the default is read off the partial index: one row per workspace however much Orbit opened since', async () => {
    // A workspace with one person's conversation under 3000 newer task-less rows the default skips:
    // spawned children and coordinator-opened conversations, as a busy project workspace has.
    const busy = randomUUID();
    await prisma.workspace.create({ data: { id: busy, ownerId, runnerId, name: 'busy', enabled: true } });
    const person = await sessions.create(ownerId, { workspaceId: busy, prompt: 'the person', ...CHOSEN } as never, { source: 'user' });
    await prisma.session.update({ where: { id: person.id }, data: { createdAt: new Date(Date.now() - 86_400_000) } });
    await sql.query(`
      INSERT INTO "session" ("id", "title", "prompt", "owner_id", "creator_id", "workspace_id", "parent_session_id", "opened_by", "created_at", "updated_at")
      SELECT gen_random_uuid(), 'filler', 'filler', $1::uuid, $1::uuid, $2::uuid,
             CASE WHEN g % 2 = 0 THEN $3::uuid END,
             CASE WHEN g % 2 = 0 THEN 'PERSON' ELSE 'COORDINATOR' END,
             now() - make_interval(secs => g), now()
        FROM generate_series(1, 3000) g`, [ownerId, busy, person.id]);
    await sql.query('ANALYZE "session"');
    const busyPayload = await workspaces.get(ownerId, busy) as unknown as { lastEngine: string; lastModel: string };
    assert.deepEqual([busyPayload.lastEngine, busyPayload.lastModel], [CHOSEN.engine, CHOSEN.model]);

    const lateral = `
      WITH a(id) AS (SELECT unnest(ARRAY[$1::uuid]))
      SELECT s.engine FROM a CROSS JOIN LATERAL (
        SELECT engine FROM "session"
         WHERE workspace_id = a.id AND task_id IS NULL AND parent_session_id IS NULL
           AND kind = 'CONVERSATION' AND opened_by = 'PERSON'
         ORDER BY created_at DESC LIMIT 1) s`;
    type Node = { 'Node Type': string; 'Index Name'?: string; 'Actual Rows'?: number; 'Rows Removed by Filter'?: number; Plans?: Node[] };
    const walk = (n: Node, out: Node[] = []): Node[] => { out.push(n); for (const c of n.Plans ?? []) walk(c, out); return out; };
    const explain = async () => {
      const r = await sql.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${lateral}`, [busy]);
      return walk((r.rows[0]['QUERY PLAN'] as Array<{ Plan: Node }>)[0].Plan);
    };
    const withIndex = await explain();
    const scan = withIndex.find((n) => n['Index Name'] === 'session_workspace_person_opened_idx');
    assert.ok(scan, `the LATERAL reads the partial index: ${JSON.stringify(withIndex.map((n) => [n['Node Type'], n['Index Name']]))}`);
    assert.equal(scan['Actual Rows'], 1);
    assert.equal(scan['Rows Removed by Filter'] ?? 0, 0);

    // Without it the same query walks the plain (workspace_id, created_at) index past every skipped row.
    await sql.query('BEGIN');
    try {
      await sql.query('DROP INDEX "session_workspace_person_opened_idx"');
      const without = await explain();
      const removed = without.reduce((sum, n) => sum + (n['Rows Removed by Filter'] ?? 0), 0);
      t.diagnostic(`without the partial index: ${removed} rows read and discarded`);
      assert.ok(removed >= 3000, `without it the walk discards the newer rows: ${removed}`);
    } finally {
      await sql.query('ROLLBACK');
    }
  });
});

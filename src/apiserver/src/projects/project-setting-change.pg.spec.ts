import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';
import { type PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectHandoffService } from './project-handoff.service';
import { PROJECT_INTEGRATION_APPROVAL_TOOL_NAME } from './project-integration-approval';
import { ProjectsService } from './projects.service';

/**
 * P-R1 (docs/project-integration-line-contract.md §12.15): every cardless write by the project's coordinator of
 * the landing check or of a task's landing-check exemption leaves one record (project, field, old value, new
 * value, reason, the writing session, the time); an owner write or a card write leaves none; the owner reverts
 * one record at an owner-only door; after that, the coordinator's cardless write of the field is refused.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-setting-change.pg.spec.ts
 *
 * The new table and arguments are reached with SQL and `as never`, so this file compiles on a tree without
 * the change and goes red there on what it asserts. Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const MERGE_CHECK = 'bash scripts/merge-check.sh';
const REPO = 'https://github.com/Example/Setting-Change';

interface Stack {
  db: PrismaClient;
  sql: Client;
  projects: ProjectsService;
  sessions: SessionsService;
  tasks: TasksService;
}

async function connect(): Promise<Stack> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  return {
    db, sql,
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma)),
    sessions: new SessionsService(prisma, queue, realtime),
    tasks: new TasksService(prisma as never, {} as never, { publishTaskChanged() {}, publishForUser() {} } as never),
  };
}

interface World {
  ownerId: string;
  projectId: string;
  coordinatorSessionId: string;
  runner: Awaited<ReturnType<PrismaClient['runner']['findUniqueOrThrow']>>;
}

async function world(stack: Stack, label: string): Promise<World> {
  const { db } = stack;
  const [ownerId, runnerId, workspaceId, projectId, coordinatorSessionId] = [
    randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(),
  ];
  await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@setting-change.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl: REPO, defaultMergeTarget: 'main' },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: label, prompt: label, provider: 'claude', turnState: null,
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: `${label} project`, coordinatorWorkspaceId: workspaceId, coordinatorSessionId },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: REPO, upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/project/${label}-${projectId}`, integrationRefSource: 'EXPLICIT',
      refAuthority: 'REMOTE', mergeCheckCommand: MERGE_CHECK,
    },
  });
  return { ownerId, projectId, coordinatorSessionId, runner: await db.runner.findUniqueOrThrow({ where: { id: runnerId } }) };
}

function door(stack: Stack): RunnerProjectsController {
  return new RunnerProjectsController(
    stack.projects, {} as ProjectAcceptanceService, {} as ProjectHandoffService, {} as RunnerOrchestrationAuthorizer,
  );
}

/** The coordinator's write at the runner door: the outcome as a status and code, or ok. */
async function coordinatorWrites(stack: Stack, w: World, integration: Record<string, unknown>): Promise<string> {
  try {
    await door(stack).updateProject(w.runner, w.projectId, w.coordinatorSessionId, { integration } as never);
    return 'ok';
  } catch (error) {
    const status = (error as { getStatus?: () => number }).getStatus?.();
    const code = (error as { getResponse?: () => { code?: string } }).getResponse?.()?.code;
    return `${status} ${code}`;
  }
}

interface ChangeRow {
  id: string;
  origin: string;
  reverts_change_id: string | null;
  project_id: string;
  task_id: string | null;
  field: string;
  old_value: unknown;
  new_value: unknown;
  reason: string;
  written_by_session_id: string;
  created_at: Date;
}

/** The owner's revert, reached through a cast so this file compiles on a tree without it. */
function revert(stack: Stack, ownerId: string, projectId: string, changeId: string, sessionId?: string): Promise<unknown> {
  return (stack.projects as unknown as {
    revertSettingChange(o: string, p: string, c: string, s?: string): Promise<unknown>;
  }).revertSettingChange(ownerId, projectId, changeId, sessionId);
}

/** The refusal an owner's revert met, as status and code. */
async function revertRefusal(stack: Stack, w: World, changeId: string): Promise<string> {
  try {
    await revert(stack, w.ownerId, w.projectId, changeId);
    return 'ok';
  } catch (error) {
    const status = (error as { getStatus?: () => number }).getStatus?.();
    const code = (error as { getResponse?: () => { code?: string } }).getResponse?.()?.code;
    return `${status} ${code}`;
  }
}

interface ListedChange {
  id: string;
  origin: string;
  revertedAt: string | null;
  revertible: boolean;
  revertsChangeId: string | null;
  reason: string | null;
  writtenBySessionId: string | null;
}

async function listed(stack: Stack, w: World): Promise<ListedChange[]> {
  const read = await stack.projects.get(w.ownerId, w.projectId) as unknown as { settingChanges: ListedChange[] };
  return read.settingChanges;
}

async function changes(stack: Stack, w: World): Promise<ChangeRow[]> {
  const { rows } = await stack.sql.query<ChangeRow>(
    `SELECT * FROM "project_setting_change" WHERE "project_id" = $1 ORDER BY "created_at", "id"`, [w.projectId]);
  return rows;
}

async function landing(stack: Stack, w: World) {
  const { rows } = await stack.sql.query<{ command: string | null; timeout: number | null; none: boolean; setBy: string }>(`
    SELECT "landing_check_command" AS "command", "landing_check_timeout_seconds" AS "timeout",
           "landing_check_none" AS "none", "landing_check_set_by" AS "setBy"
      FROM "project_codebase" WHERE "project_id" = $1 AND "slot" = 'primary'`, [w.projectId]);
  return rows[0];
}

async function exemption(stack: Stack, taskId: string) {
  const { rows } = await stack.sql.query<{ exempt: boolean; reason: string | null; by: string | null }>(`
    SELECT "landing_check_exempt" AS "exempt", "landing_check_exempt_reason" AS "reason",
           "landing_check_exempt_by_session_id"::text AS "by" FROM "task" WHERE "id" = $1::uuid`, [taskId]);
  return rows[0];
}

test('P-R1 needs postgres; every case below is a skip without it', { skip, timeout: 180_000 }, async (t) => {
  const stack = await connect();
  t.after(() => stack.db.$disconnect().catch(() => undefined));
  t.after(() => stack.sql.end().catch(() => undefined));

  await t.test('the coordinator\'s cardless landing-check write leaves one record with all seven facts', async () => {
    const w = await world(stack, 'record');
    assert.equal(await coordinatorWrites(stack, w, { landingCheckCommand: 'npm run build' }),
      '400 LANDING_CHECK_REASON_REQUIRED');
    assert.equal(await coordinatorWrites(stack, w, { landingCheckCommand: 'npm run build', landingCheckReason: 'x'.repeat(281) }),
      '400 LANDING_CHECK_REASON_REQUIRED');
    assert.deepEqual(await changes(stack, w), [], 'a refused write records nothing');
    assert.equal((await landing(stack, w)).command, null);

    assert.equal(await coordinatorWrites(stack, w,
      { landingCheckCommand: 'npm run build', landingCheckReason: 'The build is the only gate this branch needs.' }), 'ok');
    assert.equal(await coordinatorWrites(stack, w,
      { landingCheckTimeoutSeconds: 900, landingCheckReason: 'The build takes ten minutes on a cold cache.' }), 'ok');

    const rows = await changes(stack, w);
    assert.equal(rows.length, 2, 'one record per cardless write');
    assert.equal(rows[0].project_id, w.projectId);
    assert.equal(rows[0].field, 'LANDING_CHECK');
    assert.equal(rows[0].task_id, null);
    assert.deepEqual(rows[0].old_value, { command: null, timeoutSeconds: null, none: false });
    assert.deepEqual(rows[0].new_value, { command: 'npm run build', timeoutSeconds: null, none: false });
    assert.equal(rows[0].reason, 'The build is the only gate this branch needs.');
    assert.equal(rows[0].written_by_session_id, w.coordinatorSessionId);
    assert.ok(rows[0].created_at instanceof Date);
    assert.deepEqual(rows[1].old_value, rows[0].new_value);
    assert.deepEqual(rows[1].new_value, { command: 'npm run build', timeoutSeconds: 900, none: false });

    assert.equal(rows[0].origin, 'COORDINATOR');
    // project_get: newest first, each with whether it was reverted and whether Revert is still offered. The
    // first change's new value is no longer the field's value; the second's is.
    const read = await listed(stack, w);
    assert.deepEqual(read.map((c) => c.id), [rows[1].id, rows[0].id]);
    assert.deepEqual(read.map((c) => [c.origin, c.revertedAt, c.revertible]),
      [['COORDINATOR', null, true], ['COORDINATOR', null, false]]);
  });

  await t.test('the owner\'s own and a card\'s writes are listed with their origin and are never revertible', async () => {
    const w = await world(stack, 'origins');
    await stack.projects.configureIntegration(w.ownerId, w.projectId, { landingCheckCommand: 'npm run lint' } as never);
    // The same value again is not a change.
    await stack.projects.configureIntegration(w.ownerId, w.projectId, { landingCheckCommand: 'npm run lint' } as never);
    const card = await stack.db.approval.create({
      data: {
        sessionId: w.coordinatorSessionId, toolName: PROJECT_INTEGRATION_APPROVAL_TOOL_NAME,
        input: { projectId: uuidToBase62(w.projectId), projectTitle: 'project', landingCheckCommand: 'npm run e2e' },
      },
    });
    await stack.sessions.decideApproval(w.ownerId, w.coordinatorSessionId, card.id, { behavior: 'allow' });
    assert.equal(await coordinatorWrites(stack, w, { landingCheckCommand: 'npm run e2e', landingCheckReason: 'Card.' }), 'ok');

    const rows = await changes(stack, w);
    assert.deepEqual(rows.map((r) => [r.origin, r.reason, r.written_by_session_id]),
      [['OWNER', null, null], ['CARD', null, null]]);
    assert.deepEqual(rows[0].old_value, { command: null, timeoutSeconds: null, none: false });
    assert.deepEqual(rows[1].new_value, { command: 'npm run e2e', timeoutSeconds: null, none: false });
    assert.deepEqual((await listed(stack, w)).map((c) => [c.origin, c.revertible]), [['CARD', false], ['OWNER', false]]);
    assert.equal(await revertRefusal(stack, w, rows[1].id), '409 SETTING_CHANGE_NOT_REVERTIBLE');
    assert.equal(await revertRefusal(stack, w, rows[0].id), '409 SETTING_CHANGE_NOT_REVERTIBLE');
  });

  await t.test('the owner revert refuses a session, is its own record, goes once, and the coordinator then needs the card', async () => {
    const w = await world(stack, 'revert');
    assert.equal(await coordinatorWrites(stack, w,
      { landingCheckCommand: 'npm run build', landingCheckReason: 'Start with the build.' }), 'ok');
    const [first] = await changes(stack, w);

    // A revert request that carries an acting session is refused whole.
    await assert.rejects(
      revert(stack, w.ownerId, w.projectId, first.id, w.coordinatorSessionId),
      (error: { getStatus?: () => number; getResponse?: () => { code?: string } }) =>
        error.getStatus?.() === 403 && error.getResponse?.().code === 'INTEGRATION_SETTINGS_OWNER_ONLY');
    assert.equal((await landing(stack, w)).command, 'npm run build');
    assert.equal((await changes(stack, w)).length, 1, 'a refused revert wrote nothing');

    await revert(stack, w.ownerId, w.projectId, first.id);
    assert.deepEqual(await landing(stack, w), { command: null, timeout: null, none: false, setBy: 'OWNER' });
    // The revert is an OWNER row naming the change, from what the field held to the old value.
    const rows = await changes(stack, w);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].origin, 'OWNER');
    assert.equal(rows[1].reverts_change_id, first.id);
    assert.deepEqual(rows[1].old_value, { command: 'npm run build', timeoutSeconds: null, none: false });
    assert.deepEqual(rows[1].new_value, { command: null, timeoutSeconds: null, none: false });
    const read = await listed(stack, w);
    const original = read.find((c) => c.id === first.id)!;
    assert.ok(original.revertedAt, 'the change reads as reverted, with the time');
    assert.equal(original.revertible, false);
    assert.equal(read.find((c) => c.revertsChangeId === first.id)?.revertible, false);

    // A second revert of the same change is refused, and writes nothing.
    assert.equal(await revertRefusal(stack, w, first.id), '409 SETTING_CHANGE_ALREADY_REVERTED');
    assert.equal((await changes(stack, w)).length, 2);

    // The coordinator's next cardless write of the field is refused.
    assert.equal(await coordinatorWrites(stack, w, { landingCheckCommand: 'npm run lint', landingCheckReason: 'Lint instead.' }),
      '403 INTEGRATION_SETTINGS_OWNER_ONLY');
    assert.equal((await landing(stack, w)).command, null);
  });

  await t.test('a change whose new value is no longer the field\'s value is refused 409 and offers no Revert', async () => {
    const w = await world(stack, 'stale');
    assert.equal(await coordinatorWrites(stack, w, { landingCheckCommand: 'npm run build', landingCheckReason: 'One.' }), 'ok');
    assert.equal(await coordinatorWrites(stack, w, { landingCheckCommand: 'npm run lint', landingCheckReason: 'Two.' }), 'ok');
    const [one, two] = await changes(stack, w);
    assert.equal(await revertRefusal(stack, w, one.id), '409 SETTING_CHANGE_NOT_CURRENT');
    assert.equal((await landing(stack, w)).command, 'npm run lint');
    assert.equal((await changes(stack, w)).length, 2);
    // Reverting the latest one first makes the earlier one's new value current again.
    assert.equal(await revertRefusal(stack, w, two.id), 'ok');
    assert.equal((await landing(stack, w)).command, 'npm run build');
  });

  await t.test('a task exemption: the coordinator\'s and the owner\'s writes are listed, the owner revert refuses a stale or repeated one, and the coordinator is then refused', async () => {
    const w = await world(stack, 'exempt');
    const taskId = (await stack.tasks.create(w.ownerId, { title: 'docs', projectId: w.projectId } as never)).id;
    const update = (dto: Record<string, unknown>, sessionId?: string) =>
      stack.tasks.update(w.ownerId, taskId, dto as never, sessionId);

    await update({ landingCheckExempt: true, landingCheckExemptReason: 'Docs only.' }, w.coordinatorSessionId);
    await update({ landingCheckExempt: false }, w.coordinatorSessionId).then(
      () => assert.fail('taking it back needs a reason'),
      (error: { getResponse?: () => { code?: string } }) =>
        assert.equal(error.getResponse?.().code, 'LANDING_CHECK_EXEMPT_REASON_REQUIRED'));
    await update({ landingCheckExempt: false, landingCheckExemptReason: 'The task now touches code.' }, w.coordinatorSessionId);

    const rows = await changes(stack, w);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].field, 'TASK_LANDING_CHECK_EXEMPT');
    assert.equal(rows[0].origin, 'COORDINATOR');
    assert.equal(rows[0].task_id, taskId);
    assert.deepEqual(rows[0].old_value, { exempt: false, reason: null });
    assert.deepEqual(rows[0].new_value, { exempt: true, reason: 'Docs only.' });
    assert.equal(rows[0].reason, 'Docs only.');
    assert.equal(rows[0].written_by_session_id, w.coordinatorSessionId);
    assert.deepEqual(rows[1].old_value, { exempt: true, reason: 'Docs only.' });
    assert.deepEqual(rows[1].new_value, { exempt: false, reason: null });
    // The first change's value is no longer current; the second's is.
    assert.deepEqual((await listed(stack, w)).map((c) => c.revertible), [true, false]);
    assert.equal(await revertRefusal(stack, w, rows[0].id), '409 SETTING_CHANGE_NOT_CURRENT');

    // The owner's own write is a row, never revertible.
    await update({ landingCheckExempt: true, landingCheckExemptReason: 'Owner says so.' });
    const afterOwner = await changes(stack, w);
    assert.equal(afterOwner.length, 3);
    assert.deepEqual([afterOwner[2].origin, afterOwner[2].reason, afterOwner[2].written_by_session_id],
      ['OWNER', 'Owner says so.', null]);
    assert.equal(await revertRefusal(stack, w, afterOwner[2].id), '409 SETTING_CHANGE_NOT_REVERTIBLE');

    // The coordinator's second change is stale now (the owner exempted it again); a fresh coordinator row, once
    // the owner has let go of the field, would be revertible. Here: the field is the owner's, so the
    // coordinator is refused without a card.
    await update({ landingCheckExempt: false, landingCheckExemptReason: 'Again.' }, w.coordinatorSessionId).then(
      () => assert.fail('refused'),
      (error: { getStatus?: () => number; getResponse?: () => { code?: string } }) => {
        assert.equal(error.getStatus?.(), 403);
        assert.equal(error.getResponse?.().code, 'LANDING_CHECK_EXEMPT_SET_BY_OWNER');
      });
    assert.equal((await exemption(stack, taskId)).exempt, true);
  });

  await t.test('an exemption revert is its own record, goes once, and stamps the task as the owner\'s', async () => {
    const w = await world(stack, 'exempt-revert');
    const taskId = (await stack.tasks.create(w.ownerId, { title: 'docs', projectId: w.projectId } as never)).id;
    const update = (dto: Record<string, unknown>, sessionId?: string) =>
      stack.tasks.update(w.ownerId, taskId, dto as never, sessionId);
    await update({ landingCheckExempt: true, landingCheckExemptReason: 'Docs only.' }, w.coordinatorSessionId);
    const [change] = await changes(stack, w);
    assert.equal((await listed(stack, w))[0].revertible, true);

    assert.equal(await revertRefusal(stack, w, change.id), 'ok');
    assert.deepEqual(await exemption(stack, taskId), { exempt: false, reason: null, by: null });
    const rows = await changes(stack, w);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].origin, 'OWNER');
    assert.equal(rows[1].reverts_change_id, change.id);
    assert.deepEqual(rows[1].old_value, { exempt: true, reason: 'Docs only.' });
    assert.deepEqual(rows[1].new_value, { exempt: false, reason: null });
    assert.equal(await revertRefusal(stack, w, change.id), '409 SETTING_CHANGE_ALREADY_REVERTED');
    await update({ landingCheckExempt: true, landingCheckExemptReason: 'Again.' }, w.coordinatorSessionId).then(
      () => assert.fail('refused'),
      (error: { getResponse?: () => { code?: string } }) =>
        assert.equal(error.getResponse?.().code, 'LANDING_CHECK_EXEMPT_SET_BY_OWNER'));
  });
});

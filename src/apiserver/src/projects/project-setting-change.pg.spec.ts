import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';
import { type PrismaClient, RunnerStatus, RunStatus, SessionDispatchOrigin } from '@prisma/client';
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
      title: label, prompt: label, provider: 'claude', status: RunStatus.AWAITING_INPUT,
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

    // project_get: newest first.
    const read = await stack.projects.get(w.ownerId, w.projectId) as unknown as { settingChanges: Array<{ id: string; reason: string }> };
    assert.deepEqual(read.settingChanges.map((c) => c.id), [rows[1].id, rows[0].id]);
  });

  await t.test('an owner write and a card write leave nothing; the owner revert refuses a session, puts the value back, and the coordinator then needs the card', async () => {
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

    await revert(stack, w.ownerId, w.projectId, first.id);
    assert.deepEqual(await landing(stack, w), { command: null, timeout: null, none: false, setBy: 'OWNER' });
    assert.equal((await changes(stack, w)).length, 1, 'the revert is an owner write: no record, and the record stays');

    // The coordinator's next cardless write of that field is refused...
    assert.equal(await coordinatorWrites(stack, w, { landingCheckCommand: 'npm run lint', landingCheckReason: 'Lint instead.' }),
      '403 INTEGRATION_SETTINGS_OWNER_ONLY');
    assert.equal((await landing(stack, w)).command, null);

    // ...and goes through only on a card, which is a card write and leaves no record.
    const card = await stack.db.approval.create({
      data: {
        sessionId: w.coordinatorSessionId, toolName: PROJECT_INTEGRATION_APPROVAL_TOOL_NAME,
        input: { projectId: uuidToBase62(w.projectId), projectTitle: 'project', landingCheckCommand: 'npm run lint' },
      },
    });
    await stack.sessions.decideApproval(w.ownerId, w.coordinatorSessionId, card.id, { behavior: 'allow' });
    assert.equal(await coordinatorWrites(stack, w, { landingCheckCommand: 'npm run lint', landingCheckReason: 'Lint instead.' }), 'ok');
    const after = await landing(stack, w);
    assert.equal(after.command, 'npm run lint');
    assert.equal(after.setBy, 'CARD');
    assert.equal((await changes(stack, w)).length, 1, 'a card write leaves no record');

    // An owner write at their own door leaves none either.
    await stack.projects.configureIntegration(w.ownerId, w.projectId, { landingCheckTimeoutSeconds: 300 } as never);
    assert.equal((await changes(stack, w)).length, 1);
  });

  await t.test('a task exemption by the coordinator is recorded; the owner\'s own write is not, and after the owner revert the coordinator is refused', async () => {
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
    assert.equal(rows[0].task_id, taskId);
    assert.deepEqual(rows[0].old_value, { exempt: false, reason: null });
    assert.deepEqual(rows[0].new_value, { exempt: true, reason: 'Docs only.' });
    assert.equal(rows[0].reason, 'Docs only.');
    assert.equal(rows[0].written_by_session_id, w.coordinatorSessionId);
    assert.deepEqual(rows[1].old_value, { exempt: true, reason: 'Docs only.' });
    assert.deepEqual(rows[1].new_value, { exempt: false, reason: null });

    // The owner's write: no record.
    await update({ landingCheckExempt: true, landingCheckExemptReason: 'Owner says so.' });
    assert.equal((await changes(stack, w)).length, 2);
    // Revert the coordinator's second record (exempt back to true with its old reason), as the owner.
    await revert(stack, w.ownerId, w.projectId, rows[1].id);
    assert.deepEqual(await exemption(stack, taskId), { exempt: true, reason: 'Docs only.', by: null });
    assert.equal((await changes(stack, w)).length, 2);
    // The coordinator can no longer write that field without a card.
    await update({ landingCheckExempt: false, landingCheckExemptReason: 'Again.' }, w.coordinatorSessionId).then(
      () => assert.fail('refused'),
      (error: { getStatus?: () => number; getResponse?: () => { code?: string } }) => {
        assert.equal(error.getStatus?.(), 403);
        assert.equal(error.getResponse?.().code, 'LANDING_CHECK_EXEMPT_SET_BY_OWNER');
      });
    assert.equal((await exemption(stack, taskId)).exempt, true);
  });
});

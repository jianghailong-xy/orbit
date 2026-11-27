import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';
import { Prisma, RunnerStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SessionsService } from '../sessions/sessions.service';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectHandoffService } from './project-handoff.service';
import { PROJECT_INTEGRATION_APPROVAL_TOOL_NAME } from './project-integration-approval';
import { START_REQUEST_DEDUPE_KEY, START_REQUEST_KIND, START_REQUEST_TITLE } from './project-start-request';
import { checksFor, type IntegrationCheckSource } from './project-integration-job';
import { ProjectsService } from './projects.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/**
 * P-C1 (docs/project-integration-line-contract.md §12.15): the project's coordinator writes the
 * landing check of a project branch that has a merge check, with no card. Every other case keeps
 * the card (§1.2 L5-b).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-landing-check-coordinator-write.pg.spec.ts
 *
 * One case per rule. Each refusal also shows the same write going through once the one condition
 * it names is turned around, so a refusal for some other reason cannot pass for the rule.
 *
 * The columns migration 1310 adds are read and written with SQL rather than through the Prisma
 * client, and `checksFor` is handed its new field through a cast, so this file compiles on a tree
 * without the change and goes red there on what it asserts.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Already canonical: the column's CHECK refuses a trailing `.git`, a trailing `/` and case. */
const REPO_URL = 'https://github.com/Example/Landing-Check';
const MERGE_CHECK = 'bash scripts/merge-check.sh';
const LANDING_CHECK = 'npm run build';

interface Stack {
  db: PrismaClient;
  sql: Client;
  sessions: SessionsService;
  projects: ProjectsService;
  acceptance: ProjectAcceptanceService;
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
  const acceptance = new ProjectAcceptanceService(prisma);
  return {
    db, sql,
    sessions: new SessionsService(prisma, queue, realtime),
    projects: new ProjectsService(prisma, acceptance),
    acceptance,
  };
}

interface Fixture {
  ownerId: string;
  projectId: string;
  coordinatorSessionId: string;
  /** A session of the same account and workspace that does not coordinate the project. */
  otherSessionId: string;
  runner: Awaited<ReturnType<PrismaClient['runner']['findUniqueOrThrow']>>;
}

/** One owner, runner and workspace, a project coordinated from one of two sessions, and its binding. */
async function project(
  stack: Stack,
  label: string,
  binding: { line: 'MAIN' | 'PROJECT_BRANCH'; mergeCheckCommand: string | null },
): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const otherSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@landing-check.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-workspace`,
      enabled: true, repoUrl: REPO_URL, defaultMergeTarget: 'main',
    },
  });
  for (const id of [coordinatorSessionId, otherSessionId]) {
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
        title: `Session of ${label}`, prompt: `Session of ${label}`, provider: 'claude',
        turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
  }
  await db.project.create({
    data: { id: projectId, ownerId, title: `${label} project`, coordinatorWorkspaceId: workspaceId, coordinatorSessionId },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: REPO_URL, upstreamRef: 'refs/heads/main',
      integrationRef: binding.line === 'MAIN' ? 'refs/heads/main' : `refs/heads/project/${label}-${projectId}`,
      integrationRefSource: 'EXPLICIT', refAuthority: 'REMOTE', mergeCheckCommand: binding.mergeCheckCommand,
    },
  });
  return {
    ownerId, projectId, coordinatorSessionId, otherSessionId,
    runner: await db.runner.findUniqueOrThrow({ where: { id: runnerId } }),
  };
}

/** The door a session's write arrives on: the one MCP and the CLI both use. */
function door(stack: Stack): RunnerProjectsController {
  return new RunnerProjectsController(
    stack.projects,
    {} as ProjectAcceptanceService,
    {} as ProjectHandoffService,
    {} as RunnerOrchestrationAuthorizer,
  );
}

/** Write through the runner door as a session, and report whether the card rule refused it. */
async function writeAsSession(
  stack: Stack,
  f: Fixture,
  integration: Record<string, unknown>,
  sessionId: string = f.coordinatorSessionId,
): Promise<{ refused: boolean }> {
  try {
    await door(stack).updateProject(
      f.runner, f.projectId, sessionId,
      // P-R1: a cardless write names why; every other writer leaves the words unread.
      { integration: { ...integration, landingCheckReason: 'The spec writes it.' } } as never,
    );
    return { refused: false };
  } catch (error) {
    const status = (error as { getStatus?: () => number }).getStatus?.();
    const code = (error as { getResponse?: () => { code?: string } }).getResponse?.()?.code;
    assert.equal(status, 403, String(error));
    assert.equal(code, 'INTEGRATION_SETTINGS_OWNER_ONLY', String(error));
    return { refused: true };
  }
}

/** The owner at their own door: no acting session. */
async function writeAsOwner(stack: Stack, f: Fixture, integration: Record<string, unknown>): Promise<void> {
  await stack.projects.update(f.ownerId, f.projectId, { integration } as never);
}

/** A card the owner answered yes, for exactly this change, filed by the coordinator. */
async function allowedCard(stack: Stack, f: Fixture, proposed: Record<string, unknown>): Promise<void> {
  const card = await stack.db.approval.create({
    data: {
      sessionId: f.coordinatorSessionId,
      toolName: PROJECT_INTEGRATION_APPROVAL_TOOL_NAME,
      input: { projectId: uuidToBase62(f.projectId), projectTitle: 'project', ...proposed },
    },
  });
  await stack.sessions.decideApproval(f.ownerId, f.coordinatorSessionId, card.id, { behavior: 'allow' });
}

interface LandingRow {
  command: string | null;
  timeout: number | null;
  mergeCheck: string | null;
  none: boolean;
  setBy: string | null;
  setBySessionId: string | null;
  setAt: Date | null;
}

/** The binding's landing check and who set it, as the database has it. */
async function landingOf(stack: Stack, f: Fixture): Promise<LandingRow> {
  const { rows } = await stack.sql.query<LandingRow>(`
    SELECT "landing_check_command" AS "command", "landing_check_timeout_seconds" AS "timeout",
           "merge_check_command" AS "mergeCheck", "landing_check_none" AS "none",
           "landing_check_set_by" AS "setBy", "landing_check_set_by_session_id" AS "setBySessionId",
           "landing_check_set_at" AS "setAt"
      FROM "project_codebase" WHERE "project_id" = $1 AND "slot" = 'primary'`, [f.projectId]);
  return rows[0];
}

/** The coordinator's open start request, as `project_request_start` files it: the settings it
 *  proposes are what the owner's Start press is measured against. */
async function startRequest(stack: Stack, f: Fixture, settings: Record<string, unknown>): Promise<string> {
  const now = new Date();
  const row = await stack.db.projectOpenItem.create({
    data: {
      projectId: f.projectId, ownerId: f.ownerId, kind: START_REQUEST_KIND, state: 'OPEN',
      assignee: 'OWNER', assigneeReason: 'DEFAULT', askedBySessionId: f.coordinatorSessionId,
      dedupeKey: START_REQUEST_DEDUPE_KEY, title: START_REQUEST_TITLE,
      payload: {
        settings, why: 'the plan is ready', criteriaDigest: '', planDigest: '', repository: null, warnings: [],
      } as unknown as Prisma.InputJsonValue,
      waitingSince: now, assignedAt: now, escalateAt: null,
    },
    select: { id: true },
  });
  return row.id;
}

/** The owner's Start press on the card, with what the card holds, answering `requestId` if named. */
async function pressStart(
  stack: Stack,
  f: Fixture,
  landing: { landingCheckCommand?: string | null; landingCheckTimeoutSeconds?: number | null },
  requestId: string | null,
): Promise<void> {
  const seal = (await stack.acceptance.standardSetConfirmation(f.ownerId, f.projectId)).currentVersion.digest;
  await stack.acceptance.startProject(f.ownerId, f.projectId, {
    criteriaDigest: seal,
    line: 'PROJECT_BRANCH',
    automatic: false,
    maxConcurrentTasks: 3,
    mergeCheckCommand: MERGE_CHECK,
    ...landing,
    ...(requestId !== null ? { requestId } : {}),
  } as never);
}

test('P-C1 needs postgres; every case below is a skip without it', { skip }, async (t) => {
  const stack = await connect();
  t.after(() => stack.db.$disconnect().catch(() => undefined));
  t.after(() => stack.sql.end().catch(() => undefined));

  await t.test('the coordinator writes the landing check with no card on a project branch with a merge check', async () => {
    const f = await project(stack, 'accepted', { line: 'PROJECT_BRANCH', mergeCheckCommand: MERGE_CHECK });

    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: LANDING_CHECK }), { refused: false });
    let row = await landingOf(stack, f);
    assert.equal(row.command, LANDING_CHECK);
    assert.equal(row.setBy, 'COORDINATOR');
    assert.equal(row.setBySessionId, f.coordinatorSessionId);
    assert.ok(row.setAt instanceof Date, 'the cardless write is dated');

    assert.deepEqual(await writeAsSession(stack, f, { landingCheckTimeoutSeconds: 900 }), { refused: false });
    assert.equal((await landingOf(stack, f)).timeout, 900);

    // The explicit NONE, through the same door and on the same terms.
    assert.deepEqual(await writeAsSession(stack, f, { landingCheck: 'NONE' }), { refused: false });
    row = await landingOf(stack, f);
    assert.equal(row.none, true);
    assert.equal(row.command, null);
    assert.equal(row.mergeCheck, MERGE_CHECK, 'the merge check did not move');

    // What project_get serves for it.
    const view = await stack.projects.integration(f.ownerId, f.projectId) as unknown as {
      landingCheckCommandAbsentReason: string | null;
      landingCheck?: { command: string | null; setBy: string | null; setBySessionId: string | null; setAt: Date | null };
    };
    assert.equal(view.landingCheckCommandAbsentReason, 'NONE');
    assert.equal(view.landingCheck?.command, 'NONE');
    assert.equal(view.landingCheck?.setBy, 'COORDINATOR');
    assert.equal(view.landingCheck?.setBySessionId, f.coordinatorSessionId);
    assert.ok(view.landingCheck?.setAt instanceof Date);

    // A command lifts NONE again.
    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: null }), { refused: false });
    row = await landingOf(stack, f);
    assert.equal(row.none, false);
    assert.equal(row.command, null);
  });

  await t.test('without a merge check the landing check still needs the card', async () => {
    const f = await project(stack, 'no-merge-check', { line: 'PROJECT_BRANCH', mergeCheckCommand: null });

    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: LANDING_CHECK }), { refused: true });
    assert.deepEqual(await writeAsSession(stack, f, { landingCheck: 'NONE' }), { refused: true });
    let row = await landingOf(stack, f);
    assert.equal(row.command, null);
    assert.equal(row.none, false);
    assert.equal(row.setBy, null);

    // The owner configures a merge check (and nothing about the landing check): now it may.
    await writeAsOwner(stack, f, { mergeCheckCommand: MERGE_CHECK });
    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: LANDING_CHECK }), { refused: false });
    row = await landingOf(stack, f);
    assert.equal(row.command, LANDING_CHECK);
    assert.equal(row.setBy, 'COORDINATOR');
  });

  await t.test('on a MAIN line the landing check still needs the card', async () => {
    const f = await project(stack, 'main-line', { line: 'MAIN', mergeCheckCommand: MERGE_CHECK });

    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: LANDING_CHECK }), { refused: true });
    assert.deepEqual(await writeAsSession(stack, f, { landingCheck: 'NONE' }), { refused: true });
    assert.equal((await landingOf(stack, f)).command, null);

    // The owner moves the line onto a project branch: now it may.
    await stack.projects.configureIntegration(f.ownerId, f.projectId, { line: 'PROJECT_BRANCH' });
    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: LANDING_CHECK }), { refused: false });
    assert.equal((await landingOf(stack, f)).command, LANDING_CHECK);
  });

  await t.test('a session that is not the project’s coordinator still needs the card', async () => {
    const f = await project(stack, 'not-coordinator', { line: 'PROJECT_BRANCH', mergeCheckCommand: MERGE_CHECK });

    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: LANDING_CHECK }, f.otherSessionId),
      { refused: true });
    assert.deepEqual(await writeAsSession(stack, f, { landingCheck: 'NONE' }, f.otherSessionId), { refused: true });
    let row = await landingOf(stack, f);
    assert.equal(row.command, null);
    assert.equal(row.none, false);

    // Once it coordinates the project, the same write goes through.
    await stack.db.project.update({ where: { id: f.projectId }, data: { coordinatorSessionId: f.otherSessionId } });
    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: LANDING_CHECK }, f.otherSessionId),
      { refused: false });
    row = await landingOf(stack, f);
    assert.equal(row.setBySessionId, f.otherSessionId);
    // And the session that coordinated before no longer may.
    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: 'npm test' }), { refused: true });
    assert.equal((await landingOf(stack, f)).command, LANDING_CHECK);
  });

  await t.test('after the owner wrote the landing check, the coordinator needs the card again', async () => {
    const f = await project(stack, 'owner-wrote', { line: 'PROJECT_BRANCH', mergeCheckCommand: MERGE_CHECK });

    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: LANDING_CHECK }), { refused: false });

    // The owner writes it at their own door: the coordinator's session is cleared, the value is
    // theirs, and it is dated like any other write.
    const before = (await landingOf(stack, f)).setAt!;
    await writeAsOwner(stack, f, { landingCheckCommand: 'npm run owner-check' });
    let row = await landingOf(stack, f);
    assert.equal(row.setBy, 'OWNER');
    assert.equal(row.setBySessionId, null);
    assert.ok(row.setAt instanceof Date && row.setAt.getTime() >= before.getTime(), 'the owner write is dated');

    for (const write of [{ landingCheckCommand: LANDING_CHECK }, { landingCheckTimeoutSeconds: 60 }, { landingCheck: 'NONE' }]) {
      assert.deepEqual(await writeAsSession(stack, f, write), { refused: true }, JSON.stringify(write));
    }
    row = await landingOf(stack, f);
    assert.equal(row.command, 'npm run owner-check');
    assert.equal(row.timeout, null);
    assert.equal(row.none, false);

    // Written through a card the owner answered is the owner's too.
    const g = await project(stack, 'card-wrote', { line: 'PROJECT_BRANCH', mergeCheckCommand: MERGE_CHECK });
    // A card for a change that also moves the merge check, so this write cannot be the cardless one.
    const viaCard = { landingCheckCommand: 'npm run carded', mergeCheckCommand: MERGE_CHECK };
    await allowedCard(stack, g, viaCard);
    assert.deepEqual(await writeAsSession(stack, g, viaCard), { refused: false });
    row = await landingOf(stack, g);
    assert.equal(row.command, 'npm run carded');
    assert.equal(row.setBy, 'CARD');
    assert.equal(row.setBySessionId, null);
    assert.ok(row.setAt instanceof Date, 'the card write is dated');
    assert.deepEqual(await writeAsSession(stack, g, { landingCheckCommand: LANDING_CHECK }), { refused: true });
    assert.equal((await landingOf(stack, g)).command, 'npm run carded');
  });

  await t.test('a landing check the owner started with as the coordinator proposed it stays the coordinator’s', async () => {
    const f = await project(stack, 'start-as-proposed', { line: 'PROJECT_BRANCH', mergeCheckCommand: MERGE_CHECK });
    const proposal = { landingCheckCommand: 'npm run build', landingCheckTimeoutSeconds: 600 };
    const requestId = await startRequest(stack, f, {
      line: 'PROJECT_BRANCH', automatic: false, maxConcurrentTasks: 3, mergeCheckCommand: MERGE_CHECK, ...proposal,
    });

    await pressStart(stack, f, proposal, requestId);
    let row = await landingOf(stack, f);
    assert.equal(row.command, 'npm run build');
    assert.equal(row.timeout, 600);
    assert.equal(row.setBy, 'START');
    assert.equal(row.setBySessionId, null);
    assert.ok(row.setAt instanceof Date, 'the start is dated');
    const view = await stack.projects.integration(f.ownerId, f.projectId) as unknown as {
      landingCheck?: { command: string | null; setBy: string | null; setAt: Date | null };
    };
    assert.equal(view.landingCheck?.setBy, 'START');
    assert.ok(view.landingCheck?.setAt instanceof Date);

    // The coordinator changes it afterwards with no card.
    assert.deepEqual(await writeAsSession(stack, f, { landingCheck: 'NONE' }), { refused: false });
    row = await landingOf(stack, f);
    assert.equal(row.none, true);
    assert.equal(row.setBy, 'COORDINATOR');
  });

  await t.test('a landing check the owner wrote on the start card, or started with no request, needs the card', async () => {
    // The owner edits the proposed command on the card.
    const f = await project(stack, 'start-edited', { line: 'PROJECT_BRANCH', mergeCheckCommand: MERGE_CHECK });
    const requestId = await startRequest(stack, f, {
      line: 'PROJECT_BRANCH', automatic: false, maxConcurrentTasks: 3, mergeCheckCommand: MERGE_CHECK,
      landingCheckCommand: 'npm run build', landingCheckTimeoutSeconds: 600,
    });
    await pressStart(stack, f, { landingCheckCommand: 'npm run owner-build', landingCheckTimeoutSeconds: 600 }, requestId);
    let row = await landingOf(stack, f);
    assert.equal(row.command, 'npm run owner-build');
    assert.equal(row.setBy, 'OWNER');
    assert.ok(row.setAt instanceof Date);
    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: LANDING_CHECK }), { refused: true });
    assert.deepEqual(await writeAsSession(stack, f, { landingCheck: 'NONE' }), { refused: true });
    assert.equal((await landingOf(stack, f)).command, 'npm run owner-build');

    // Only the budget differs from the proposal: still the owner's.
    const b = await project(stack, 'start-budget-edited', { line: 'PROJECT_BRANCH', mergeCheckCommand: MERGE_CHECK });
    const budgetRequest = await startRequest(stack, b, {
      line: 'PROJECT_BRANCH', automatic: false, maxConcurrentTasks: 3, mergeCheckCommand: MERGE_CHECK,
      landingCheckCommand: 'npm run build', landingCheckTimeoutSeconds: 600,
    });
    await pressStart(stack, b, { landingCheckCommand: 'npm run build', landingCheckTimeoutSeconds: 1200 }, budgetRequest);
    assert.equal((await landingOf(stack, b)).setBy, 'OWNER');
    assert.deepEqual(await writeAsSession(stack, b, { landingCheckTimeoutSeconds: 60 }), { refused: true });

    // No start request at all: the value is the owner's own words.
    const g = await project(stack, 'start-no-request', { line: 'PROJECT_BRANCH', mergeCheckCommand: MERGE_CHECK });
    await pressStart(stack, g, { landingCheckCommand: 'npm run build' }, null);
    row = await landingOf(stack, g);
    assert.equal(row.setBy, 'OWNER');
    assert.deepEqual(await writeAsSession(stack, g, { landingCheckCommand: LANDING_CHECK }), { refused: true });
    assert.equal((await landingOf(stack, g)).command, 'npm run build');
  });

  await t.test('the merge check itself still needs the card, from the coordinator too', async () => {
    const f = await project(stack, 'merge-check-card', { line: 'PROJECT_BRANCH', mergeCheckCommand: MERGE_CHECK });

    // The landing check alone goes through, which is what makes the refusals below about the merge check.
    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: LANDING_CHECK }), { refused: false });

    assert.deepEqual(await writeAsSession(stack, f, { mergeCheckCommand: 'npm test' }), { refused: true });
    assert.deepEqual(await writeAsSession(stack, f, { mergeCheckTimeoutSeconds: 60 }), { refused: true });
    assert.deepEqual(await writeAsSession(stack, f, { mergeCheckCommand: null }), { refused: true });
    // Carried beside a landing check, it takes the landing check down with it.
    assert.deepEqual(await writeAsSession(stack, f, { landingCheckCommand: 'npm run lint', mergeCheckCommand: 'npm test' }),
      { refused: true });
    const row = await landingOf(stack, f);
    assert.equal(row.mergeCheck, MERGE_CHECK);
    assert.equal(row.command, LANDING_CHECK);

    // With the card, the merge check moves.
    await allowedCard(stack, f, { mergeCheckCommand: 'npm test' });
    assert.deepEqual(await writeAsSession(stack, f, { mergeCheckCommand: 'npm test' }), { refused: false });
    assert.equal((await landingOf(stack, f)).mergeCheck, 'npm test');
  });

  await t.test('NONE makes checksFor run only the task’s acceptance on a landing; null falls back to the merge check', async () => {
    const f = await project(stack, 'checks-for', { line: 'PROJECT_BRANCH', mergeCheckCommand: MERGE_CHECK });
    const job = async (): Promise<IntegrationCheckSource> => {
      const row = await landingOf(stack, f);
      // Built loosely and cast, so this file compiles where the field does not exist yet.
      const source: Record<string, unknown> = {
        kind: 'LAND_TASK',
        promotionSourceKind: null,
        acceptanceCommand: 'npm run acceptance',
        acceptanceExpectedExitCode: 0,
        acceptanceTimeoutSeconds: null,
        landingCheckCommand: row.command,
        landingCheckTimeoutSeconds: row.timeout,
        landingCheckNone: row.none,
        mergeCheckCommand: row.mergeCheck,
        mergeCheckTimeoutSeconds: null,
        skipMergeCheck: false,
      };
      return source as unknown as IntegrationCheckSource;
    };

    // Null: the landing falls back to the merge check (§11 K1).
    assert.deepEqual(checksFor(await job()).map((check) => [check.name, check.command]), [
      ['TASK_ACCEPTANCE', 'npm run acceptance'],
      ['LANDING_CHECK', MERGE_CHECK],
    ]);

    // NONE: the task's own acceptance and nothing else.
    assert.deepEqual(await writeAsSession(stack, f, { landingCheck: 'NONE' }), { refused: false });
    assert.deepEqual(checksFor(await job()).map((check) => [check.name, check.command]), [
      ['TASK_ACCEPTANCE', 'npm run acceptance'],
    ]);

    // A promotion is not a landing: NONE does not take the merge check away from it.
    const promotion = { ...(await job()), kind: 'CHECK_PROMOTION', promotionSourceKind: 'PROJECT_BRANCH' } as IntegrationCheckSource;
    assert.deepEqual(checksFor(promotion).map((check) => [check.name, check.command]), [
      ['MERGE_CHECK', MERGE_CHECK],
    ]);
  });
});

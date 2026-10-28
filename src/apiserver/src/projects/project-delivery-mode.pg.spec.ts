/**
 * A project's delivery mode (`project_codebase.delivery_mode`, migration 0453): the account owner's
 * to choose, through the doors the line already has, and read where the line is read
 * (`docs/project-integration-line-contract.md` §10.5 O-L1, §10.9).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-delivery-mode.pg.spec.ts
 *
 * WHAT THIS FILE HOLDS IT TO
 * --------------------------
 *   (1) O-L1: the owner writes it through `PATCH /projects/:id/integration`, `PATCH /projects/:id`
 *       and the start door, and `orbit project update` at a terminal writes it too; the UPDATE that
 *       writes the mode records `delivery_mode_chosen_at` in the same statement, inside the request,
 *       and naming the mode it already has is recorded again;
 *   (2) O-L1: an acting session is refused 403 `INTEGRATION_SETTINGS_OWNER_ONLY` on the runner door
 *       — a merge-check card it holds does not carry the mode — and on `PATCH
 *       /projects/:id/integration`; the start door refuses a session's start whole; nothing is
 *       written by any of them;
 *   (3) O-L1: `AGENT_PUSH` off a MAIN line is 409 `DELIVERY_MODE_NEEDS_MAIN_LINE` and writes nothing —
 *       on a project branch, asked together with one, kept while moving onto one, on a line nobody
 *       decided yet unless the same request chooses MAIN, through the project update and at the
 *       start door;
 *   (4) O-L1: the L4 lock does not hold it — once the line has started, every owner door still
 *       changes the mode, both ways, while a change of the line itself stays 409
 *       `INTEGRATION_LINE_LOCKED`, and a started project branch still refuses `AGENT_PUSH`;
 *   (5) §10.9: `GET /projects/:id/integration`, the project document and the runner's project read
 *       (what `project_get` serves) carry `deliveryMode` and `deliveryModeChosenAt` — `PLATFORM` and
 *       null with no binding, the written values after;
 *   (6) a project with no repository: the start door refuses `AGENT_PUSH` 409
 *       `INTEGRATION_REPOSITORY_UNKNOWN`, and a start naming `PLATFORM` asks nothing and binds
 *       nothing.
 *
 * WHAT IS REAL
 * ------------
 * The owner's doors go over HTTP through the real `ProjectsController`, validation pipe and
 * public-id interceptor; only the JWT check is replaced, so a bearer token names the caller. An
 * agent — and the CLI — reaches the server through `RunnerProjectsController`. The first integration
 * is the transaction that queues it (`enqueueForDoneTask`). Every write is read back with SQL, and
 * the statements a write sends are recorded (`countingPrismaClientFor`), which is how (1) sees one
 * UPDATE carry both columns.
 *
 * The new fields are read through local casts rather than off the shared types, so this file
 * compiles on the tree before the change too, and each case there fails on an assertion.
 *
 * Not destructive: every case owns freshly generated ids.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';
import { RunStatus, RunnerStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { countingPrismaClientFor } from '../test-support/counting-prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectFuseService } from './project-fuse.service';
import { ProjectHandoffService } from './project-handoff.service';
import { PROJECT_INTEGRATION_APPROVAL_TOOL_NAME } from './project-integration-approval';
import { enqueueForDoneTask } from './project-integration-job';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const REPO_URL = 'https://github.com/Example/Delivery-Mode.git';

const METHOD = 'VERIFICATION';
const CRITERION = 'the project delivers its work the way its owner chose';

// What main.ts installs before the app serves anything: the project read carries BIGINT columns.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

interface Account { ownerId: string; runnerId: string }

interface Fixture extends Account {
  projectId: string;
  publicId: string;
  workspaceId: string;
  sessionId: string;
}

interface Binding {
  delivery_mode: string;
  delivery_mode_chosen_at: Date | null;
  upstream_ref: string;
  integration_ref: string;
  integration_ref_source: string;
  integration_started_at: Date | null;
  merge_check_command: string | null;
}

interface Answer { status: number; body: string; json: Record<string, unknown> }

/** The two fields this file reads, on any of the shapes that carry them. */
type WithDelivery = { deliveryMode?: string; deliveryModeChosenAt?: string | Date | null };
const deliveryOf = (view: unknown) => {
  const { deliveryMode, deliveryModeChosenAt } = view as WithDelivery;
  return { deliveryMode, deliveryModeChosenAt };
};

test('a project’s delivery mode is the owner’s to choose, unlocked by the line, and read where the line is '
  + '(§10.5 O-L1, §10.9)', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const { prisma, statements } = countingPrismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // The production wiring over one client; only the publish and the queue nudge are inert.
  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
  const openItems = new ProjectOpenItemService(db, sessions);
  const tasks = new TasksService(db, sessions, realtime);
  // The runner's door: how an agent — and `orbit project update` at a terminal — reaches the server.
  const runnerDoor = new RunnerProjectsController(
    projects,
    acceptance,
    {} as never,
    { assert: async () => undefined } as never,
    openItems,
  );

  // ── the owner's doors, over real HTTP ────────────────────────────────────────────────────────
  const refuse = (name: string) => () => {
    throw new Error(`${name} must not be reached by this probe`);
  };
  @Module({
    controllers: [ProjectsController],
    providers: [
      { provide: ProjectsService, useValue: projects },
      { provide: ProjectAcceptanceService, useValue: acceptance },
      { provide: ProjectHandoffService, useValue: { listForProject: refuse('handoffs') } },
      { provide: SessionAttemptService, useValue: { describe: refuse('attempts') } },
      { provide: TaskCheckpointService, useValue: { record: refuse('checkpoints') } },
      { provide: ProjectOpenItemService, useValue: openItems },
      { provide: ProjectFuseService, useValue: { resume: refuse('the fuse') } },
      JwtAuthGuard,
      Reflector,
      // The bearer token is the caller's user id.
      { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token }) } },
      { provide: PrismaService, useValue: db },
    ],
  })
  class DeliveryModeDoorModule {}

  const app = await NestFactory.create(DeliveryModeDoorModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  async function call(
    caller: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    sessionHeader?: string,
  ): Promise<Answer> {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${caller}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(sessionHeader ? { 'x-orbit-session-id': sessionHeader } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Left empty: the status assertion that follows quotes the raw body.
    }
    return { status: response.status, body: text, json };
  }

  async function refused(action: () => Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      await action();
    } catch (error) {
      assert.ok(error instanceof HttpException, `expected an HttpException, got ${String(error)}`);
      return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
    }
    return assert.fail('the call was expected to be refused and was not');
  }

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────

  async function account(label: string): Promise<Account> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    await prisma.user.create({
      data: { id: ownerId, email: `${label}-${ownerId}@delivery-mode.invalid`, name: label, passwordHash: 'x' },
    });
    await prisma.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: [],
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });
    return { ownerId, runnerId };
  }

  /** A conversation parked where a turn appends: what a coordinator is between its turns. */
  async function conversation(who: Account, workspaceId: string, label: string): Promise<string> {
    const sessionId = randomUUID();
    await prisma.session.create({
      data: {
        id: sessionId,
        ownerId: who.ownerId,
        creatorId: who.ownerId,
        workspaceId,
        assignedRunnerId: who.runnerId,
        title: label,
        prompt: label,
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        runtimeSessionId: randomUUID(),
      },
    });
    await prisma.conversationTurn.create({
      data: {
        sessionId,
        seq: 1,
        clientTurnId: SessionsService.initialTurnClientId(sessionId),
        kind: 'message',
        content: label,
        status: 'ANSWERED',
      },
    });
    return sessionId;
  }

  /**
   * A project nobody has started, coordinated from a conversation in a workspace on the account's
   * runner whose remote is `repoUrl` (none when null), stating one criterion so a start has a seal.
   */
  async function project(who: Account, label: string, repoUrl: string | null = REPO_URL): Promise<Fixture> {
    const workspaceId = randomUUID();
    await prisma.workspace.create({
      data: { id: workspaceId, ownerId: who.ownerId, runnerId: who.runnerId, name: `${label}-workspace`, enabled: true, repoUrl },
    });
    const sessionId = await conversation(who, workspaceId, `coordinating ${label}`);
    const projectId = randomUUID();
    await prisma.project.create({
      data: {
        id: projectId,
        ownerId: who.ownerId,
        title: `${label} project`,
        coordinatorWorkspaceId: workspaceId,
        coordinatorSessionId: sessionId,
      },
    });
    await prisma.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
    await projects.update(who.ownerId, projectId, {
      acceptanceCriteriaItems: [{ text: CRITERION, verificationMethod: METHOD }],
    } as never);
    return { ...who, projectId, publicId: uuidToBase62(projectId), workspaceId, sessionId };
  }

  async function seal(f: Fixture): Promise<string> {
    return (await acceptance.standardSetConfirmation(f.ownerId, f.projectId)).currentVersion.digest;
  }

  /** The start as a browser presses it. */
  async function press(f: Fixture, body: Record<string, unknown>, sessionHeader?: string): Promise<Answer> {
    return call(f.ownerId, 'POST', `/projects/${f.publicId}/start`,
      { criteriaDigest: await seal(f), ...body }, sessionHeader);
  }

  /** The owner's integration door. */
  function configure(f: Fixture, settings: Record<string, unknown>, sessionHeader?: string): Promise<Answer> {
    return call(f.ownerId, 'PATCH', `/projects/${f.publicId}/integration`, settings, sessionHeader);
  }

  /** The owner's project update, carrying `integration`. */
  function update(f: Fixture, integration: Record<string, unknown>): Promise<Answer> {
    return call(f.ownerId, 'PATCH', `/projects/${f.publicId}`, { integration });
  }

  async function bindingOf(f: Fixture): Promise<Binding | undefined> {
    const { rows } = await sql.query<Binding>(
      `SELECT "delivery_mode", "delivery_mode_chosen_at", "upstream_ref", "integration_ref",
              "integration_ref_source", "integration_started_at", "merge_check_command"
         FROM "project_codebase" WHERE "project_id" = $1::uuid AND "slot" = 'primary'`,
      [f.projectId],
    );
    assert.ok(rows.length <= 1);
    return rows[0];
  }

  async function startedAtOf(f: Fixture): Promise<Date | null> {
    const { rows: [row] } = await sql.query<{ started_at: Date | null }>(
      `SELECT "started_at" FROM "project" WHERE "id" = $1::uuid`, [f.projectId]);
    return row.started_at;
  }

  async function integrationOf(f: Fixture): Promise<Record<string, unknown>> {
    const read = await call(f.ownerId, 'GET', `/projects/${f.publicId}/integration`);
    assert.equal(read.status, 200, read.body);
    return read.json;
  }

  async function documentOf(f: Fixture): Promise<Record<string, unknown>> {
    const read = await call(f.ownerId, 'GET', `/projects/${f.publicId}`);
    assert.equal(read.status, 200, read.body);
    return read.json.integration as Record<string, unknown>;
  }

  /**
   * One owner write of the mode: it lands, the binding says `mode`, the choice is recorded inside
   * the request — TIMESTAMPTZ(3) rounds to the millisecond, so a millisecond either side — and the
   * one UPDATE of the binding the write sent names both columns.
   */
  async function chosen(f: Fixture, mode: string, write: () => Promise<Answer | unknown>): Promise<Date> {
    statements.reset();
    const before = Date.now();
    const answer = await write();
    const after = Date.now();
    // An HTTP door's answer; the runner door answers with the project itself, or throws.
    if (answer && typeof answer === 'object' && 'json' in answer && 'body' in answer) {
      const { status, body } = answer as Answer;
      assert.ok(status === 200 || status === 201, `${status}: ${body}`);
    }
    const row = await bindingOf(f);
    assert.equal(row?.delivery_mode, mode);
    const at = row?.delivery_mode_chosen_at;
    assert.ok(at instanceof Date, 'the choice was not recorded');
    assert.ok(at.getTime() >= before - 1 && at.getTime() <= after + 1,
      `recorded at ${at.toISOString()}, outside the request (${new Date(before).toISOString()} – `
        + `${new Date(after).toISOString()})`);
    const updates = statements.sql.filter((text) => /\bUPDATE\s+(?:"public"\.)?"project_codebase"/i.test(text));
    assert.equal(updates.length, 1, `one UPDATE of the binding, not:\n${updates.join('\n')}`);
    assert.match(updates[0], /"delivery_mode"\s*=/);
    assert.match(updates[0], /"delivery_mode_chosen_at"\s*=/);
    return at;
  }

  /** A first integration, which locks the line (L4): one DONE code task, queued as the DONE is. */
  async function integrate(f: Fixture): Promise<void> {
    const created = await tasks.create(f.ownerId, {
      title: `${f.publicId}: the first code task`,
      projectId: f.projectId,
      autoRunWhenReady: false,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    await prisma.session.create({
      data: {
        id: randomUUID(),
        ownerId: f.ownerId,
        creatorId: f.ownerId,
        taskId: created.id,
        workspaceId: f.workspaceId,
        assignedRunnerId: f.runnerId,
        title: 'the first code task',
        prompt: 'the first code task',
        provider: 'claude',
        status: RunStatus.SUCCEEDED,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
        isolationStatus: 'worktree',
        branch: `orbit/first-integration-${f.publicId}`,
      },
    });
    await prisma.task.update({ where: { id: created.id }, data: { status: TaskStatus.DONE } });
    const outcome = await prisma.$transaction((tx) => enqueueForDoneTask(tx, f.ownerId, created.id));
    assert.equal(outcome.enqueued, true, JSON.stringify(outcome));
    assert.ok((await bindingOf(f))?.integration_started_at instanceof Date, 'the line has started');
  }

  const START = { automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null };
  const owner = await account('owner');

  // ═══ (1) the owner's doors ═══════════════════════════════════════════════════════════════════

  await t.test('(1) O-L1: the owner writes it through each door, and the UPDATE that writes it records '
    + 'when', async () => {
    const f = await project(owner, 'owner-doors');

    // A value outside the set is the door's own 400, before anything is written.
    const unknown = await configure(f, { line: 'MAIN', deliveryMode: 'agent_push' });
    assert.equal(unknown.status, 400, unknown.body);
    assert.equal(await bindingOf(f), undefined);

    // PATCH /projects/:id/integration, choosing the MAIN line in the same request.
    let answer: Answer | undefined;
    const first = await chosen(f, 'AGENT_PUSH', async () => {
      answer = await configure(f, { line: 'MAIN', deliveryMode: 'AGENT_PUSH' });
      return answer;
    });
    assert.deepEqual(deliveryOf(answer!.json),
      { deliveryMode: 'AGENT_PUSH', deliveryModeChosenAt: first.toISOString() },
      'the door answers with what it wrote');

    // PATCH /projects/:id, `integration`.
    const second = await chosen(f, 'PLATFORM', () => update(f, { deliveryMode: 'PLATFORM' }));
    assert.ok(second.getTime() >= first.getTime());

    // Naming the mode it already has is the owner saying it again: recorded again.
    const again = await chosen(f, 'PLATFORM', () => configure(f, { deliveryMode: 'PLATFORM' }));
    assert.ok(again.getTime() >= second.getTime());

    // `orbit project update --delivery-mode` at a terminal: the runner door with no session.
    const runner = { id: f.runnerId, ownerId: f.ownerId } as never;
    await chosen(f, 'AGENT_PUSH', () => runnerDoor.updateProject(runner, f.projectId, undefined,
      { integration: { deliveryMode: 'AGENT_PUSH' } } as never));

    // The start door, on a project with no binding yet: it binds, chooses MAIN and the mode at once.
    const g = await project(owner, 'start-door');
    let started: Answer | undefined;
    await chosen(g, 'AGENT_PUSH', async () => {
      started = await press(g, { line: 'MAIN', ...START, deliveryMode: 'AGENT_PUSH' });
      return started;
    });
    assert.equal(started!.status, 201, started!.body);
    assert.deepEqual(started!.json.differsFromRequest, []);
    const row = await bindingOf(g);
    assert.equal(row?.integration_ref_source, 'EXPLICIT');
    assert.equal(row?.integration_ref, row?.upstream_ref, 'a MAIN line');

    // A start that names no mode leaves the one the project has, and records no choice.
    const h = await project(owner, 'start-door-silent');
    const silent = await press(h, { line: 'MAIN', ...START });
    assert.equal(silent.status, 201, silent.body);
    assert.equal((await bindingOf(h))?.delivery_mode, 'PLATFORM');
    assert.equal((await bindingOf(h))?.delivery_mode_chosen_at, null);
  });

  // ═══ (2) an agent session ════════════════════════════════════════════════════════════════════

  await t.test('(2) O-L1: an acting session is refused 403 at every door, and nothing is written', async () => {
    const f = await project(owner, 'session-doors');
    const runner = { id: f.runnerId, ownerId: f.ownerId } as never;

    const fromRunnerDoor = await refused(() => runnerDoor.updateProject(runner, f.projectId, f.sessionId,
      { integration: { deliveryMode: 'AGENT_PUSH' } } as never));
    assert.equal(fromRunnerDoor.status, 403);
    assert.equal(fromRunnerDoor.body.code, 'INTEGRATION_SETTINGS_OWNER_ONLY');
    assert.equal(await bindingOf(f), undefined, 'a refused write bound nothing and recorded nothing');

    // A card the owner answered for this session's merge check covers the merge check and nothing
    // else (L5-b): the mode beside it is refused, and the refusal takes the merge check with it.
    await prisma.approval.create({
      data: {
        sessionId: f.sessionId,
        toolName: PROJECT_INTEGRATION_APPROVAL_TOOL_NAME,
        input: { projectId: f.projectId, mergeCheckCommand: 'npm test' },
        status: 'ALLOWED',
        decidedById: f.ownerId,
        decidedAt: new Date(),
      },
    });
    const withCard = await refused(() => runnerDoor.updateProject(runner, f.projectId, f.sessionId,
      { integration: { mergeCheckCommand: 'npm test', deliveryMode: 'AGENT_PUSH' } } as never));
    assert.equal(withCard.status, 403);
    assert.equal(withCard.body.code, 'INTEGRATION_SETTINGS_OWNER_ONLY');
    assert.equal(await bindingOf(f), undefined);

    // The owner's own integration door, asked from inside a session.
    const fromIntegrationDoor = await configure(f, { line: 'MAIN', deliveryMode: 'AGENT_PUSH' },
      uuidToBase62(f.sessionId));
    assert.equal(fromIntegrationDoor.status, 403, fromIntegrationDoor.body);
    assert.equal(fromIntegrationDoor.json.code, 'INTEGRATION_SETTINGS_OWNER_ONLY');
    assert.equal(await bindingOf(f), undefined);

    // The start door refuses a session's start whole, mode and all.
    const fromStartDoor = await press(f, { line: 'MAIN', ...START, deliveryMode: 'AGENT_PUSH' },
      uuidToBase62(f.sessionId));
    assert.equal(fromStartDoor.status, 403, fromStartDoor.body);
    assert.equal(await bindingOf(f), undefined);
    assert.equal(await startedAtOf(f), null);

    // The same write from the owner goes through: what was refused was the session.
    assert.equal((await configure(f, { line: 'MAIN', deliveryMode: 'AGENT_PUSH' })).status, 200);
  });

  // ═══ (3) AGENT_PUSH needs a MAIN line ═════════════════════════════════════════════════════════

  await t.test('(3) O-L1: AGENT_PUSH off a MAIN line is 409 DELIVERY_MODE_NEEDS_MAIN_LINE and writes '
    + 'nothing', async () => {
    const needsMain = (answer: Answer, label: string) => {
      assert.equal(answer.status, 409, `${label}: ${answer.body}`);
      assert.equal(answer.json.code, 'DELIVERY_MODE_NEEDS_MAIN_LINE', label);
    };

    // On a project branch.
    const branched = await project(owner, 'on-a-branch');
    assert.equal((await configure(branched, { line: 'PROJECT_BRANCH' })).status, 200);
    const onBranch = await bindingOf(branched);
    needsMain(await configure(branched, { deliveryMode: 'AGENT_PUSH' }), 'on a project branch');
    needsMain(await update(branched, { deliveryMode: 'AGENT_PUSH' }), 'the project update');
    assert.deepEqual(await bindingOf(branched), onBranch, 'nothing was written, its time included');

    // Asked together with a project branch: nothing is bound either.
    const together = await project(owner, 'with-a-branch');
    needsMain(await configure(together, { line: 'PROJECT_BRANCH', deliveryMode: 'AGENT_PUSH' }), 'together');
    needsMain(await configure(together, { projectBranchName: 'refs/heads/project/next', deliveryMode: 'AGENT_PUSH' }),
      'a named project branch');
    assert.equal(await bindingOf(together), undefined);

    // Kept while moving onto a project branch: the mode has to go with it.
    const pushing = await project(owner, 'pushing');
    assert.equal((await configure(pushing, { line: 'MAIN', deliveryMode: 'AGENT_PUSH' })).status, 200);
    const asPushing = await bindingOf(pushing);
    needsMain(await configure(pushing, { line: 'PROJECT_BRANCH' }), 'kept');
    assert.deepEqual(await bindingOf(pushing), asPushing);
    assert.equal((await configure(pushing, { line: 'PROJECT_BRANCH', deliveryMode: 'PLATFORM' })).status, 200,
      'moving with the mode is fine');
    assert.equal((await bindingOf(pushing))?.delivery_mode, 'PLATFORM');

    // A line nobody decided yet is not a MAIN line: its first integration could still put it on a
    // project branch, where 0453's CHECK would refuse that transaction.
    const undecided = await project(owner, 'undecided');
    assert.equal((await configure(undecided, { mergeCheckCommand: 'npm test' })).status, 200);
    const asBound = await bindingOf(undecided);
    assert.equal(asBound?.integration_ref_source, 'DEFAULT_RULE', 'bound, with no line chosen');
    needsMain(await configure(undecided, { deliveryMode: 'AGENT_PUSH' }), 'undecided');
    assert.deepEqual(await bindingOf(undecided), asBound);
    assert.equal((await configure(undecided, { line: 'MAIN', deliveryMode: 'AGENT_PUSH' })).status, 200,
      'choosing MAIN in the same request is the way in');

    // The start door, asked for both: no start, no binding.
    const starting = await project(owner, 'start-on-a-branch');
    needsMain(await press(starting, { line: 'PROJECT_BRANCH', ...START, deliveryMode: 'AGENT_PUSH' }), 'start');
    assert.equal(await bindingOf(starting), undefined);
    assert.equal(await startedAtOf(starting), null);
  });

  // ═══ (4) the lock does not hold the mode ═════════════════════════════════════════════════════

  await t.test('(4) O-L1: once the line has started, the mode still changes at every owner door', async () => {
    const f = await project(owner, 'locked');
    assert.equal((await configure(f, { line: 'MAIN' })).status, 200);
    await integrate(f);
    const locked = await bindingOf(f);

    await chosen(f, 'AGENT_PUSH', () => configure(f, { deliveryMode: 'AGENT_PUSH' }));
    await chosen(f, 'PLATFORM', () => update(f, { deliveryMode: 'PLATFORM' }));
    const runner = { id: f.runnerId, ownerId: f.ownerId } as never;
    await chosen(f, 'AGENT_PUSH', () => runnerDoor.updateProject(runner, f.projectId, undefined,
      { integration: { deliveryMode: 'AGENT_PUSH' } } as never));

    // The start door on a started line: it keeps the line, and still writes the mode.
    let started: Answer | undefined;
    await chosen(f, 'PLATFORM', async () => {
      started = await press(f, { line: 'MAIN', ...START, deliveryMode: 'PLATFORM' });
      return started;
    });
    assert.equal(started!.json.lineLocked, true, started!.body);

    // The line itself is still locked, and none of the above moved it.
    const moved = await configure(f, { upstreamRef: 'refs/heads/develop' });
    assert.equal(moved.status, 409, moved.body);
    assert.equal(moved.json.code, 'INTEGRATION_LINE_LOCKED');
    const after = await bindingOf(f);
    assert.equal(after?.integration_ref, locked?.integration_ref);
    assert.equal(after?.upstream_ref, locked?.upstream_ref);
    assert.deepEqual(after?.integration_started_at, locked?.integration_started_at);

    // A started project branch is still not a MAIN line.
    const branched = await project(owner, 'locked-branch');
    assert.equal((await configure(branched, { line: 'PROJECT_BRANCH' })).status, 200);
    await integrate(branched);
    const onBranch = await configure(branched, { deliveryMode: 'AGENT_PUSH' });
    assert.equal(onBranch.status, 409, onBranch.body);
    assert.equal(onBranch.json.code, 'DELIVERY_MODE_NEEDS_MAIN_LINE');
    assert.equal((await bindingOf(branched))?.delivery_mode, 'PLATFORM');
  });

  // ═══ (5) the read model ══════════════════════════════════════════════════════════════════════

  await t.test('(5) §10.9: the integration read, the project document and project_get carry both fields',
    async () => {
      const f = await project(owner, 'reads');
      const runner = { id: f.runnerId, ownerId: f.ownerId } as never;
      const agentRead = async () => deliveryOf((await runnerDoor.getProject(runner, f.projectId) as {
        integration: unknown;
      }).integration);

      // No binding: the mode a binding starts with, never chosen.
      const unbound = { deliveryMode: 'PLATFORM', deliveryModeChosenAt: null };
      assert.deepEqual(deliveryOf(await integrationOf(f)), unbound);
      assert.deepEqual(deliveryOf(await documentOf(f)), unbound);
      assert.deepEqual(await agentRead(), unbound);

      const at = await chosen(f, 'AGENT_PUSH', () => configure(f, { line: 'MAIN', deliveryMode: 'AGENT_PUSH' }));
      const written = { deliveryMode: 'AGENT_PUSH', deliveryModeChosenAt: at.toISOString() };
      assert.deepEqual(deliveryOf(await integrationOf(f)), written);
      assert.deepEqual(deliveryOf(await documentOf(f)), written);
      const agent = await agentRead();
      assert.equal(agent.deliveryMode, 'AGENT_PUSH');
      assert.equal(new Date(agent.deliveryModeChosenAt as Date).toISOString(), at.toISOString());

      // A binding nobody chose a mode for says so: bound by a merge check, PLATFORM, never chosen.
      const g = await project(owner, 'reads-unchosen');
      assert.equal((await configure(g, { mergeCheckCommand: 'npm test' })).status, 200);
      assert.deepEqual(deliveryOf(await integrationOf(g)), unbound);
      assert.deepEqual(deliveryOf(await documentOf(g)), unbound);
    });

  // ═══ (6) no repository ═══════════════════════════════════════════════════════════════════════

  await t.test('(6) a project with no repository: AGENT_PUSH is refused at the start, PLATFORM asks nothing',
    async () => {
      const f = await project(owner, 'no-repository', null);
      const pushing = await press(f, { line: 'MAIN', ...START, deliveryMode: 'AGENT_PUSH' });
      assert.equal(pushing.status, 409, pushing.body);
      assert.equal(pushing.json.code, 'INTEGRATION_REPOSITORY_UNKNOWN');
      assert.equal(await startedAtOf(f), null);

      const platform = await press(f, { line: 'MAIN', ...START, deliveryMode: 'PLATFORM' });
      assert.equal(platform.status, 201, platform.body);
      assert.equal(await bindingOf(f), undefined, 'nothing to bind, and nothing bound');
      assert.deepEqual(deliveryOf(await integrationOf(f)), { deliveryMode: 'PLATFORM', deliveryModeChosenAt: null });
    });
});

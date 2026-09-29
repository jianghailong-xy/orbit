/**
 * `project_request_start`: a project's coordinator asks its owner to start it, once the plan is
 * ready — and only then does the owner have a "Start this project?" card to answer.
 *
 * WHAT A REQUEST IS
 * -----------------
 * An open item of its own kind, `START_REQUEST`, with the owner on it from birth: the settings the
 * coordinator suggests (line, Automatic, concurrency, merge check), why, and the seal of the criteria
 * and the digest of the plan it was made about. It is filed through `POST
 * /runner/projects/:id/start-requests` (`RunnerProjectsController.requestStart`), which only the
 * conversation the project is coordinated from may call, and only before the project has started.
 *
 * WHAT THIS FILE HOLDS IT TO
 * --------------------------
 *   (1) each of the four refusals — no criteria or no tasks, a criterion no task serves, a task whose
 *       assignee has no runner, a project branch with no repository — is 409
 *       START_REQUEST_NOT_READY and files nothing, and one request can be refused by several at
 *       once, every finding in the one answer;
 *   (2) the two warnings — tasks set to start by hand, listed by id and title, and Automatic on a
 *       project branch with no merge check — do not refuse: the request is filed and carries them;
 *   (3) a session that does not coordinate the project is refused 403 and files nothing — and the
 *       one that does is not refused for the Automatic switch being off;
 *   (4) a project that has started is 409 PROJECT_ALREADY_STARTED;
 *   (5) a newer request supersedes the open one, and the same request again writes nothing;
 *   (6) a task filed before the start supersedes the open request, and so does a criteria edit: the
 *       owner's read no longer draws it;
 *   (7) the start door answers the request: it is resolved APPROVED, and what the start records as
 *       asked for is the coordinator's suggestion, so the owner's change is the difference marked;
 *   (8) ask_owner works before the start, with the Automatic switch off, and the answer comes back.
 *
 * Every fact is produced the way the product produces it — criteria through `ProjectsService.update`,
 * requests through the runner controller, starts through `ProjectAcceptanceService.startProject` —
 * and every write is read back with SQL rather than through the service that made it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-start-request.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
import {
  CreatorType,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  type ProjectStartFinding,
  type ProjectStartRecord,
  type ProjectStartRequest,
  type ProjectStartRequestBody,
  type ProjectStartRequestFiled,
  uuidToBase62,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const METHOD = 'VERIFICATION';
const FIRST = 'the owner starts a project only once its coordinator asks';
const SECOND = 'a plan that is not ready is refused with every reason at once';
const ADDED = 'a request about a plan that moved is not drawn';
const REPO = 'https://example.invalid/orbit/start-request.git';

/** The settings a coordinator suggests, as `project_request_start` sends them. */
const SUGGESTED: ProjectStartRequestBody = {
  line: 'PROJECT_BRANCH',
  automatic: true,
  maxConcurrentTasks: 3,
  mergeCheckCommand: 'npm test',
  why: 'B and C both build on A: one branch checks them together before main',
};

interface Refusal {
  status: number;
  body: { code?: string; message?: string; written?: number; findings?: ProjectStartFinding[] };
}

interface StoredRequest {
  id: string;
  state: string;
  assignee: string;
  assignee_reason: string;
  asked_by_session_id: string | null;
  dedupe_key: string;
  title: string;
  payload: ProjectStartRequest;
  resolution: string | null;
  resolved_by: string | null;
  resolved_by_user_id: string | null;
  resolved_by_session_id: string | null;
  resolution_note: string | null;
  superseded_by_item_id: string | null;
  escalate_at: Date | null;
}

test('a coordinator asks its owner to start the project, and the plan is checked first', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // The production wiring over one client. Only the publish and the queue nudge are inert: what this
  // file counts is rows, and a runner being told to look is not one.
  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
  const openItems = new ProjectOpenItemService(db, sessions);
  // The runner's door, as `project_request_start` reaches it. It spends no orchestration credential,
  // so the authorizer it is built with fails if it is ever asked.
  const door = new RunnerProjectsController(
    projects,
    acceptance,
    {} as never,
    { assert: async () => assert.fail('a start request spends no orchestration credential') } as never,
    openItems,
  );

  const ownerId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `start-request-${ownerId}@project-start.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  const runnerId = randomUUID();
  await prisma.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'start-request-runner',
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  /** The runner credential the door is called with: this machine, of this account. */
  const runner = { id: runnerId, ownerId } as never;

  async function refused(action: () => Promise<unknown>): Promise<Refusal> {
    try {
      await action();
    } catch (error) {
      assert.ok(error instanceof HttpException, `expected an HttpException, got ${String(error)}`);
      return { status: error.getStatus(), body: error.getResponse() as Refusal['body'] };
    }
    return assert.fail('the call was expected to be refused and was not');
  }

  /** A workspace on the runner — or on none, which is what a task no runner can start is assigned to. */
  async function workspace(label: string, options: { runner?: boolean; repoUrl?: string | null } = {}) {
    const id = randomUUID();
    await prisma.workspace.create({
      data: {
        id,
        ownerId,
        runnerId: options.runner === false ? null : runnerId,
        name: `${label}-workspace`,
        enabled: true,
        repoUrl: options.repoUrl === undefined ? REPO : options.repoUrl,
      },
    });
    return id;
  }

  /** A conversation parked where a turn appends: what a coordinator is between its turns. */
  async function conversation(workspaceId: string, label: string): Promise<string> {
    const sessionId = randomUUID();
    await prisma.session.create({
      data: {
        id: sessionId,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
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

  /** State the whole collection through the owner's path — the only writer of a definition. */
  async function state(projectId: string, texts: string[]): Promise<string[]> {
    const { rows } = await sql.query<{ id: string; text: string }>(
      `SELECT "id", "text" FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
      [projectId],
    );
    const known = new Map(rows.map((row) => [row.text, row.id]));
    await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: texts.map((text) => ({
        ...(known.has(text) ? { id: known.get(text) } : {}),
        text,
        verificationMethod: METHOD,
      })),
    } as never);
    const { rows: stated } = await sql.query<{ id: string }>(
      `SELECT "id" FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
      [projectId],
    );
    return stated.map((row) => row.id);
  }

  async function task(projectId: string, title: string, options: {
    assigneeId: string | null;
    criterionDefinitionId?: string | null;
    autoRunWhenReady?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    await prisma.task.create({
      data: {
        id,
        ownerId,
        projectId,
        title,
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        assigneeId: options.assigneeId,
        status: TaskStatus.OPEN,
        completionCriterion: 'EXECUTABLE',
        acceptanceCommand: 'true',
        acceptanceExpectedExitCode: 0,
        autoRunWhenReady: options.autoRunWhenReady ?? true,
        criterionDefinitionId: options.criterionDefinitionId ?? null,
      },
    });
    return id;
  }

  /**
   * A project nobody has started, coordinated from a parked conversation in a workspace on the
   * runner, stating two criteria, with one task serving each — the plan a coordinator would ask to
   * start. Every option takes one piece of that away. Automatic is off, as `project_create` leaves it.
   */
  async function planned(label: string, options: {
    criteria?: boolean;
    tasks?: boolean;
    serveSecond?: boolean;
    repoUrl?: string | null;
    byHand?: boolean;
  } = {}) {
    const coordinationWorkspaceId = await workspace(label, { repoUrl: options.repoUrl });
    const sessionId = await conversation(coordinationWorkspaceId, `协调：${label}`);
    const id = randomUUID();
    await prisma.project.create({
      data: {
        id,
        ownerId,
        title: `${label} 的项目`,
        coordinatorWorkspaceId: coordinationWorkspaceId,
        coordinatorSessionId: sessionId,
      },
    });
    await prisma.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
    const criteria = options.criteria === false ? [] : await state(id, [FIRST, SECOND]);
    const tasks: Array<{ id: string; title: string }> = [];
    if (options.tasks !== false) {
      const first = `${label} · A`;
      tasks.push({
        id: await task(id, first, {
          assigneeId: coordinationWorkspaceId,
          criterionDefinitionId: criteria[0] ?? null,
        }),
        title: first,
      });
      const second = `${label} · B`;
      tasks.push({
        id: await task(id, second, {
          assigneeId: coordinationWorkspaceId,
          criterionDefinitionId: options.serveSecond === false ? null : criteria[1] ?? null,
          autoRunWhenReady: !options.byHand,
        }),
        title: second,
      });
      await prisma.taskDependency.create({ data: { taskId: tasks[1].id, dependsOnTaskId: tasks[0].id } });
    }
    const [row] = (await sql.query<{ coordinator_enabled: boolean; started_at: Date | null }>(
      `SELECT "coordinator_enabled", "started_at" FROM "project" WHERE "id" = $1::uuid`, [id],
    )).rows;
    assert.equal(row.coordinator_enabled, false, 'the fixture project has Automatic off');
    assert.equal(row.started_at, null, 'the fixture project is not started');
    return { id, sessionId, coordinationWorkspaceId, criteria, tasks };
  }

  /** `project_request_start`, through the runner's door, from the session named. */
  function ask(
    projectId: string,
    sessionId: string | undefined,
    body: ProjectStartRequestBody = SUGGESTED,
  ): Promise<ProjectStartRequestFiled> {
    return door.requestStart(runner, sessionId, projectId, body as never) as Promise<ProjectStartRequestFiled>;
  }

  async function requests(projectId: string): Promise<StoredRequest[]> {
    const { rows } = await sql.query<StoredRequest>(
      `SELECT "id", "state", "assignee", "assignee_reason", "asked_by_session_id", "dedupe_key",
              "title", "payload", "resolution", "resolved_by", "resolved_by_user_id",
              "resolved_by_session_id", "resolution_note", "superseded_by_item_id", "escalate_at"
         FROM "project_open_item"
        WHERE "project_id" = $1::uuid AND "kind" = 'START_REQUEST'
        ORDER BY "created_at", "id"`,
      [projectId],
    );
    return rows;
  }

  async function seal(projectId: string): Promise<string> {
    return (await acceptance.standardSetConfirmation(ownerId, projectId)).currentVersion.digest;
  }

  const codes = (findings: readonly ProjectStartFinding[] | undefined) =>
    (findings ?? []).map((finding) => `${finding.severity} ${finding.code}`);

  // ═══ (1) the four refusals, alone and together ═════════════════════════════════════════════════

  await t.test('(1a) no criteria and no tasks: refused, both reasons at once, nothing filed', async () => {
    const project = await planned('empty', { criteria: false, tasks: false });
    const refusal = await refused(() => ask(project.id, project.sessionId));
    assert.equal(refusal.status, 409);
    assert.equal(refusal.body.code, 'START_REQUEST_NOT_READY');
    assert.equal(refusal.body.written, 0, 'the answer says nothing was filed');
    assert.deepEqual(codes(refusal.body.findings), [
      'REFUSE START_NO_CRITERIA',
      'REFUSE START_NO_TASKS',
    ]);
    for (const finding of refusal.body.findings!) {
      assert.ok(finding.message && finding.requiredAction, `${finding.code} says what and what to do`);
    }
    assert.deepEqual(await requests(project.id), [], 'a refused request is not filed');

    // Criteria alone are not enough either: there is still nothing to start.
    await state(project.id, [FIRST]);
    assert.deepEqual(
      codes((await refused(() => ask(project.id, project.sessionId))).body.findings),
      ['REFUSE START_NO_TASKS'],
    );
    assert.deepEqual(await requests(project.id), []);
  });

  await t.test('(1b) a criterion no task serves: refused, naming the criterion', async () => {
    const project = await planned('unserved', { serveSecond: false });
    const refusal = await refused(() => ask(project.id, project.sessionId));
    assert.equal(refusal.status, 409);
    assert.equal(refusal.body.code, 'START_REQUEST_NOT_READY');
    assert.deepEqual(codes(refusal.body.findings), ['REFUSE START_CRITERION_UNSERVED']);
    const [finding] = refusal.body.findings!;
    assert.equal(finding.criterion?.ordinal, 2, 'the second criterion is the one nobody serves');
    assert.equal(finding.criterion?.text, SECOND);
    assert.ok(finding.criterion?.key, 'by the key task_create takes as criterionKey');
    assert.ok(finding.requiredAction.includes(finding.criterion!.key),
      'the next step names the key to serve it with');
    assert.deepEqual(await requests(project.id), []);
  });

  await t.test('(1c) a task whose assignee is bound to no runner: refused, naming the task', async () => {
    const project = await planned('no-runner');
    const nowhere = await workspace('no-runner-elsewhere', { runner: false });
    await prisma.task.update({ where: { id: project.tasks[1].id }, data: { assigneeId: nowhere } });
    const refusal = await refused(() => ask(project.id, project.sessionId));
    assert.equal(refusal.status, 409);
    assert.deepEqual(codes(refusal.body.findings), ['REFUSE START_TASK_HAS_NO_RUNNER']);
    assert.deepEqual(refusal.body.findings![0].tasks, [
      { taskId: project.tasks[1].id, title: project.tasks[1].title },
    ]);
    assert.deepEqual(await requests(project.id), []);
  });

  await t.test('(1d) a project branch with no repository: refused; main with no check is not', async () => {
    const project = await planned('no-repository', { repoUrl: null });
    const refusal = await refused(() => ask(project.id, project.sessionId));
    assert.equal(refusal.status, 409);
    assert.deepEqual(codes(refusal.body.findings), ['REFUSE START_REPOSITORY_UNKNOWN']);
    assert.deepEqual(await requests(project.id), []);

    // The same plan on main, with no merge check, asks nothing of a repository.
    const filed = await ask(project.id, project.sessionId, {
      ...SUGGESTED,
      line: 'MAIN',
      mergeCheckCommand: null,
    });
    assert.equal(filed.state, 'OPEN');
    assert.equal(filed.repository, null);
    assert.equal((await requests(project.id)).length, 1);
  });

  await t.test('(1e) several refusals come back in one answer, warnings beside them', async () => {
    const project = await planned('everything-at-once', { repoUrl: null, serveSecond: false, byHand: true });
    const nowhere = await workspace('everything-at-once-elsewhere', { runner: false });
    await prisma.task.update({ where: { id: project.tasks[0].id }, data: { assigneeId: nowhere } });
    const refusal = await refused(() => ask(project.id, project.sessionId, {
      ...SUGGESTED,
      mergeCheckCommand: undefined,
    }));
    assert.equal(refusal.status, 409);
    assert.equal(refusal.body.code, 'START_REQUEST_NOT_READY');
    assert.deepEqual(codes(refusal.body.findings), [
      'REFUSE START_CRITERION_UNSERVED',
      'REFUSE START_TASK_HAS_NO_RUNNER',
      'REFUSE START_REPOSITORY_UNKNOWN',
      'WARN START_TASKS_START_BY_HAND',
      'WARN START_NO_MERGE_CHECK',
    ], 'every finding, refusals first — a coordinator fixes the plan in one pass');
    assert.match(refusal.body.message ?? '', /3 checks refused it/);
    assert.deepEqual(await requests(project.id), []);
  });

  // ═══ (2) the two warnings: filed, and carried ═════════════════════════════════════════════════

  await t.test('(2) tasks started by hand and a missing merge check warn, and the request is filed', async () => {
    const project = await planned('warnings', { byHand: true });
    const filed = await ask(project.id, project.sessionId, { ...SUGGESTED, mergeCheckCommand: '  ' });
    assert.equal(filed.state, 'OPEN');
    assert.equal(filed.alreadyOpen, false);
    assert.deepEqual(codes(filed.warnings), [
      'WARN START_TASKS_START_BY_HAND',
      'WARN START_NO_MERGE_CHECK',
    ]);
    assert.deepEqual(filed.warnings[0].tasks, [
      { taskId: project.tasks[1].id, title: project.tasks[1].title },
    ], 'the tasks set to start by hand are listed by id and title');
    assert.equal(filed.settings.mergeCheckCommand, null, 'a blank merge check is none');

    const [stored] = await requests(project.id);
    assert.equal(stored.id, filed.itemId);
    assert.equal(stored.state, 'OPEN');
    assert.equal(stored.assignee, 'OWNER', 'a start request is the owner’s from birth');
    assert.equal(stored.assignee_reason, 'DEFAULT');
    assert.equal(stored.asked_by_session_id, project.sessionId, 'it records who asked');
    assert.equal(stored.dedupe_key, 'START_REQUEST');
    assert.equal(stored.title, 'Start this project?');
    assert.equal(stored.escalate_at, null, 'already the owner’s: nowhere to escalate to');
    assert.deepEqual(stored.payload.warnings, filed.warnings, 'the warnings are filed with it');
    assert.equal(stored.payload.why, SUGGESTED.why);
    assert.equal(stored.payload.criteriaDigest, await seal(project.id),
      'it names the seal the start door will confirm');
    assert.match(stored.payload.planDigest, /^[0-9a-f]{64}$/);
    assert.equal(stored.payload.repository, 'https://example.invalid/orbit/start-request');

    // Both warnings are needed for either to be there: a merge check set, and the tasks on auto-run,
    // leave a request with none.
    const clean = await planned('no-warnings');
    assert.deepEqual((await ask(clean.id, clean.sessionId)).warnings, []);

    // The owner reads it beside the exceptions rather than among them: a client that predates the
    // kind would draw every `needsYou` row it cannot name as an exception escalated to them.
    const view = await openItems.list(ownerId, project.id);
    assert.equal(view.startRequest?.itemId, filed.itemId);
    assert.equal(view.startRequest?.kind, 'START_REQUEST');
    assert.equal(view.startRequest?.title, 'Start this project?');
    assert.deepEqual(view.startRequest?.startRequest, stored.payload);
    assert.equal(view.startRequest?.detailLine,
      `project/${uuidToBase62(project.id)} · Automatic on · 3 tasks at a time · no merge check`);
    assert.deepEqual(view.startRequest?.actions, []);
    assert.deepEqual(view.needsYou, [], 'not among the exceptions');
    assert.deepEqual(view.withCoordinator, []);
  });

  // ═══ (3) who may ask ═══════════════════════════════════════════════════════════════════════════

  await t.test('(3) only the coordinating conversation may ask; the Automatic switch is not asked', async () => {
    const project = await planned('who-may-ask');
    const stranger = await conversation(project.coordinationWorkspaceId, '一个别的会话');
    for (const [label, session] of [
      ['another session', stranger],
      ['no session at all', undefined],
      ['a blank session header', '   '],
    ] as const) {
      const refusal = await refused(() => ask(project.id, session));
      assert.equal(refusal.status, 403, `${label} may not ask`);
      assert.equal(refusal.body.code, 'START_REQUEST_COORDINATOR_ONLY');
    }
    assert.deepEqual(await requests(project.id), [], 'and the refusals filed nothing');

    // The conversation the project points at asks with Automatic off — the switch is one of the
    // settings being asked for, not a condition of asking.
    const filed = await ask(project.id, ` ${project.sessionId} `);
    assert.equal(filed.state, 'OPEN');
  });

  // ═══ (4) a started project ═════════════════════════════════════════════════════════════════════

  await t.test('(4) a project that has started is 409 PROJECT_ALREADY_STARTED', async () => {
    const project = await planned('already-started');
    await acceptance.startProject(ownerId, project.id, {
      criteriaDigest: await seal(project.id),
      line: 'PROJECT_BRANCH',
      automatic: false,
      maxConcurrentTasks: 3,
      mergeCheckCommand: 'npm test',
    });
    const refusal = await refused(() => ask(project.id, project.sessionId));
    assert.equal(refusal.status, 409);
    assert.equal(refusal.body.code, 'PROJECT_ALREADY_STARTED');
    assert.deepEqual(await requests(project.id), []);
  });

  // ═══ (5) one open request: a newer one supersedes, the same one again writes nothing ═══════════

  await t.test('(5) a newer request supersedes the open one; the same request again is the same row', async () => {
    const project = await planned('asked-twice');
    const first = await ask(project.id, project.sessionId);
    const again = await ask(project.id, project.sessionId);
    assert.equal(again.itemId, first.itemId, 'the same request re-sent is the one already open');
    assert.equal(again.alreadyOpen, true);
    assert.equal((await requests(project.id)).length, 1, 'and it wrote nothing');

    const second = await ask(project.id, project.sessionId, { ...SUGGESTED, maxConcurrentTasks: 2 });
    assert.notEqual(second.itemId, first.itemId);
    assert.deepEqual(second.superseded, { itemId: first.itemId }, 'it says which request it replaced');
    const [old, current] = await requests(project.id);
    assert.equal(old.id, first.itemId);
    assert.equal(old.state, 'SUPERSEDED');
    assert.equal(old.superseded_by_item_id, second.itemId, 'the old one names its successor');
    assert.equal(old.resolved_by, 'COORDINATOR');
    assert.equal(old.resolved_by_session_id, project.sessionId);
    assert.equal(current.id, second.itemId);
    assert.equal(current.state, 'OPEN');
    assert.equal(current.payload.settings.maxConcurrentTasks, 2);
    assert.equal((await openItems.list(ownerId, project.id)).startRequest?.itemId, second.itemId,
      'the owner is shown the newer one, and only it');
  });

  // ═══ (6) the plan moving under a request ══════════════════════════════════════════════════════

  await t.test('(6) a task filed before the start supersedes the request; so does a criteria edit', async () => {
    const project = await planned('plan-moved');
    const filed = await ask(project.id, project.sessionId);
    assert.equal((await openItems.list(ownerId, project.id)).startRequest?.itemId, filed.itemId,
      'drawn while the plan is the one it was made about');

    // The coordinator files one more task after asking.
    await task(project.id, 'plan-moved · C', {
      assigneeId: project.coordinationWorkspaceId,
      criterionDefinitionId: project.criteria[0],
    });
    const view = await openItems.list(ownerId, project.id);
    assert.equal(view.startRequest, null, 'the owner is no longer shown a card for a plan that moved');
    const [moved] = await requests(project.id);
    assert.equal(moved.state, 'SUPERSEDED');
    assert.equal(moved.resolved_by, 'PLATFORM');
    assert.equal(moved.superseded_by_item_id, null, 'nothing replaced it: the coordinator asks again');
    assert.match(moved.resolution_note ?? '', /tasks or their dependencies/);

    // Asked again about the plan as it now stands, and then the criteria move.
    const refiled = await ask(project.id, project.sessionId);
    assert.equal(refiled.superseded, null, 'the moved request was already superseded');
    await state(project.id, [FIRST, SECOND, ADDED]);
    assert.equal((await openItems.list(ownerId, project.id)).startRequest, null);
    const edited = (await requests(project.id)).find((row) => row.id === refiled.itemId)!;
    assert.equal(edited.state, 'SUPERSEDED');
    assert.match(edited.resolution_note ?? '', /criteria/);
  });

  // ═══ (7) the start door answers the request ═══════════════════════════════════════════════════

  await t.test('(7) starting the project resolves its request, and marks what the owner changed', async () => {
    const project = await planned('answered');
    const filed = await ask(project.id, project.sessionId);
    const started = await acceptance.startProject(ownerId, project.id, {
      criteriaDigest: await seal(project.id),
      line: 'PROJECT_BRANCH',
      automatic: true,
      maxConcurrentTasks: 2,
      mergeCheckCommand: 'npm test',
      requestId: filed.itemId,
    });
    assert.deepEqual(started.differsFromRequest, ['maxConcurrentTasks'],
      'measured against what the coordinator suggested: the owner changed the concurrency');

    const [answered] = await requests(project.id);
    assert.equal(answered.state, 'RESOLVED');
    assert.equal(answered.resolution, 'APPROVED');
    assert.equal(answered.resolved_by, 'USER', 'the owner answered it by starting the project');
    assert.equal(answered.resolved_by_user_id, ownerId);
    const [confirmation] = (await sql.query<{ started_with: ProjectStartRecord }>(
      `SELECT "started_with" FROM "project_standard_set_confirmation" WHERE "project_id" = $1::uuid`,
      [project.id],
    )).rows;
    assert.deepEqual(confirmation.started_with.differsFromRequest, ['maxConcurrentTasks'],
      'the start records the difference, for the receipt and the coordinator’s card');
    assert.equal((await openItems.list(ownerId, project.id)).startRequest, null);

    // A start that names no request — the owner's own Start… — answers the open one all the same:
    // a started project has nothing left to ask.
    const unnamed = await planned('answered-unnamed');
    await ask(unnamed.id, unnamed.sessionId);
    await acceptance.startProject(ownerId, unnamed.id, {
      criteriaDigest: await seal(unnamed.id),
      line: 'PROJECT_BRANCH',
      automatic: true,
      maxConcurrentTasks: 3,
      mergeCheckCommand: 'npm test',
    });
    const [resolved] = await requests(unnamed.id);
    assert.equal(resolved.state, 'RESOLVED');
    assert.equal(resolved.resolution, 'APPROVED');

    // A request id that is not this project's start request is refused, and nothing starts.
    const stray = await planned('answered-stray');
    const strayRefusal = await refused(async () => acceptance.startProject(ownerId, stray.id, {
      criteriaDigest: await seal(stray.id),
      line: 'MAIN',
      automatic: false,
      maxConcurrentTasks: 1,
      mergeCheckCommand: null,
      requestId: filed.itemId,
    }));
    assert.equal(strayRefusal.status, 404, 'another project’s request answers nothing here');
    const [strayRow] = (await sql.query<{ started_at: Date | null }>(
      `SELECT "started_at" FROM "project" WHERE "id" = $1::uuid`, [stray.id],
    )).rows;
    assert.equal(strayRow.started_at, null, 'and the refused start wrote nothing');
  });

  // ═══ (8) ask_owner before the start ═══════════════════════════════════════════════════════════

  await t.test('(8) before the start, with Automatic off, the coordinator can ask and hears back', async () => {
    const project = await planned('asks-first');
    const asked = await openItems.askOwner(ownerId, project.id, project.sessionId, {
      question: 'Should B wait for A to land, or start beside it?',
      options: [{ label: 'Wait for A' }, { label: 'Start beside it' }],
      recommendedOption: 0,
      clientQuestionId: 'before-start',
    });
    assert.equal(asked.state, 'OPEN', 'filed, although nothing has started and Automatic is off');
    const stranger = await conversation(project.coordinationWorkspaceId, '不是协调会话');
    const refusal = await refused(() => openItems.askOwner(ownerId, project.id, stranger, {
      question: 'May I?',
    }));
    assert.equal(refusal.status, 403, 'still only the coordinating conversation');
    assert.equal(refusal.body.code, 'ASK_OWNER_COORDINATOR_ONLY');

    const answered = await openItems.answerOpenItem(ownerId, project.id, asked.itemId, { option: 0 });
    assert.equal(answered.resolution, 'ANSWERED');
    assert.equal(answered.delivery?.sessionId, project.sessionId,
      'the answer reaches the coordinator with the switch off');
    const { rows: turns } = await sql.query<{ client_turn_id: string; content: string }>(
      `SELECT "client_turn_id", "content" FROM "conversation_turn"
        WHERE "session_id" = $1::uuid AND "client_turn_id" LIKE 'owner-answer:v1:%'`,
      [project.sessionId],
    );
    assert.deepEqual(turns.map((turn) => turn.client_turn_id),
      [`owner-answer:v1:${asked.itemId}:${project.sessionId}`]);
    assert.ok(turns[0].content.includes('Wait for A'), 'carrying what the owner chose');
  });
});

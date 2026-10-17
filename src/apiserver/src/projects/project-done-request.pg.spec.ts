/**
 * `project_request_done`: a project's coordinator asks its owner to record the project done, once
 * it has checked the work — and only then does the owner have an "Is this project done?" card.
 *
 * WHAT A REQUEST IS
 * -----------------
 * An open item of its own kind, `DONE_REQUEST`, with the owner on it from birth: the coordinator's
 * call, every gap Orbit cannot prove (the criterion's key, why, what the coordinator checked, where
 * the evidence is), the seal of the criteria and a digest of the work it was made about, and the
 * check's warnings. It is filed through `POST /runner/projects/:id/done-requests`
 * (`RunnerProjectsController.requestDone`), which only the conversation the project is coordinated
 * from may call, and only while the project is OPEN.
 *
 * WHAT THIS FILE HOLDS IT TO
 * --------------------------
 *   (1) each refusal is 409 DONE_REQUEST_NOT_READY and files nothing — no criteria; a criterion its
 *       work has not met, and one no work serves; a task running, queued for a runner, or
 *       IN_PROGRESS; an item waiting on the owner; a landing or a merge into main queued or running,
 *       for each of LAND_TASK, CHECK_PROMOTION and LAND_PROMOTION — and every one comes back in the
 *       same answer, warnings beside them;
 *   (2) each warning — a criterion not LANDED, with why: IN_FLIGHT, ON_PROJECT_BRANCH,
 *       NOTHING_TO_LAND, NO_RECEIPT, CODELESS — does not refuse: the request is filed and carries
 *       them, and a LANDED criterion has none. The row, its payload and the owner's read of it;
 *   (3) the void rules: the same request again writes nothing, a newer one supersedes it, and a task
 *       filed, the criteria edited or a merge recorded supersedes it the next time it is read; the
 *       owner's press on a request whose work moved since is 409 and writes nothing;
 *   (4) Ready to close: while a request stands, the coordinator's session row says DONE_REQUEST and
 *       the project list carries `doneRequest`; the owner's DONE answers the request and both go dark;
 *       a project no longer OPEN cannot be asked;
 *   (5) a session that does not coordinate the project is refused 403 and files nothing; a gap with a
 *       part missing, or about a criterion the project does not state, is 400.
 *
 * Every fact is produced the way the product produces it — criteria through `ProjectsService.update`,
 * work through `TasksService.create` and the DONE fence, a merge an agent made through
 * `MergeReceiptService.record`, the line's answers through its own queue (`enqueueForDoneTask`, the
 * heartbeat's claim, the runner's result), requests through the runner controller, the owner's DONE
 * through `ProjectAcceptanceService.recordProjectDone` — except the two promotion jobs, written as the
 * rows the promotion machinery queues, and every write is read back with SQL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-done-request.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
import {
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  type DoneRequest,
  type IntegrationJobCommand,
  type IntegrationJobResultRequest,
  type ProjectDoneFinding,
  type ProjectDoneRequestFiled,
  type RequestProjectDoneBody,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criterionKeyOf } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask } from './project-integration-job';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const METHOD = 'VERIFICATION';
/** The repository, spelled the way a binding stores it: canonical, so no `.git`. */
const REPO = 'ssh://git@example.invalid/orbit/done-request';
/** A full 40-hex object name, which is the only kind a receipt or a job accepts. */
const sha = (nibble: string) => nibble.repeat(40);

/** The coordinator's call and no gaps — what a request about a project Orbit can prove looks like. */
const CALL: RequestProjectDoneBody = {
  judgment: 'Every criterion holds and the work is where it has to be.',
  gaps: [],
};

interface Refusal {
  status: number;
  body: { code?: string; message?: string; written?: number; findings?: ProjectDoneFinding[] };
}

interface StoredRequest {
  id: string;
  state: string;
  assignee: string;
  assignee_reason: string;
  asked_by_session_id: string | null;
  dedupe_key: string;
  title: string;
  payload: DoneRequest;
  resolution: string | null;
  resolved_by: string | null;
  resolved_by_user_id: string | null;
  resolved_by_session_id: string | null;
  resolution_note: string | null;
  superseded_by_item_id: string | null;
  escalate_at: Date | null;
}

/** One stated criterion, as a task and a gap name it. */
interface Stated {
  definitionId: string;
  key: string;
  ordinal: number;
  text: string;
}

test('a coordinator asks its owner to record the project done, and the project is checked first', {
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
  const tasks = new TasksService(db, sessions, realtime);
  const receipts = new MergeReceiptService(db);
  // The heartbeat's half of the line's queue: what a runner claims and reports back on.
  const jobs = new IntegrationJobRelay(db);
  // The runner's door, as `project_request_done` reaches it. It spends no orchestration credential,
  // so the authorizer it is built with fails if it is ever asked.
  const door = new RunnerProjectsController(
    projects,
    acceptance,
    {} as never,
    { assert: async () => assert.fail('a done request spends no orchestration credential') } as never,
    openItems,
  );

  const ownerId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `done-request-${ownerId}@project-done.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  const runnerId = randomUUID();
  await prisma.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'done-request-runner',
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
  async function state(projectId: string, texts: string[]): Promise<Stated[]> {
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
    const { rows: stated } = await sql.query<{ id: string; text: string }>(
      `SELECT "id", "text" FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
      [projectId],
    );
    return stated.map((row, index) => ({
      definitionId: row.id,
      key: criterionKeyOf(row.id),
      ordinal: index + 1,
      text: row.text,
    }));
  }

  /**
   * A project nobody has started, coordinated from a parked conversation in a workspace on the
   * runner, stating the criteria named. `line` gives it a binding of its own — upstream `main` and a
   * project branch that has started integrating — which is what a landing is queued against.
   */
  async function project(label: string, criteria: string[], options: { line?: boolean } = {}) {
    const workspaceId = randomUUID();
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        ownerId,
        runnerId,
        name: `${label}-workspace`,
        enabled: true,
        repoUrl: REPO,
        workDir: `/srv/done-request/${label}`,
      },
    });
    const sessionId = await conversation(workspaceId, `协调：${label}`);
    const id = randomUUID();
    await prisma.project.create({
      data: {
        id,
        ownerId,
        title: `${label} 的项目`,
        coordinatorWorkspaceId: workspaceId,
        coordinatorSessionId: sessionId,
      },
    });
    await prisma.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
    if (options.line) {
      await prisma.projectCodebase.create({
        data: {
          ownerId,
          projectId: id,
          canonicalRepoUrl: REPO,
          upstreamRef: 'refs/heads/main',
          integrationRef: `refs/heads/project/${id}`,
          refAuthority: 'REMOTE',
          integrationRefSource: 'EXPLICIT',
          integrationStartedAt: new Date(Date.now() - 60 * 60_000),
        },
      });
    }
    const stated = criteria.length > 0 ? await state(id, criteria) : [];
    return { id, sessionId, workspaceId, criteria: stated, branch: `project/${id}` };
  }

  type Project = Awaited<ReturnType<typeof project>>;

  /**
   * One task of the project, through the task door — serving a criterion when one is named — and
   * settled the way `runnerApi.turnComplete` does it when `status` says DONE, through the DONE
   * fence. `codeless` is written on the row, which is how the product writes it.
   */
  async function task(p: Project, title: string, options: {
    serves?: Stated;
    status?: 'OPEN' | 'IN_PROGRESS' | 'DONE';
    codeless?: boolean;
  } = {}): Promise<{ id: string; title: string }> {
    const created = await tasks.create(ownerId, {
      title,
      projectId: p.id,
      ...(options.serves ? { criterionKey: options.serves.key } : {}),
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
      autoRunWhenReady: false,
    } as never) as unknown as { id: string };
    if (options.codeless) {
      await prisma.task.update({ where: { id: created.id }, data: { codeless: true } });
    }
    if (options.status === 'DONE') {
      const written = await sql.query(
        `UPDATE "task" SET "status" = 'DONE'
          WHERE "id" = $1::uuid
            AND "status" IN ('OPEN', 'IN_PROGRESS')
            AND "completion_criterion" = 'EXECUTABLE'
            AND "acceptance_command" = 'true'
            AND "acceptance_expected_exit_code" = 0`,
        [created.id],
      );
      assert.equal(written.rowCount, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
    } else if (options.status === 'IN_PROGRESS') {
      await sql.query(`UPDATE "task" SET "status" = 'IN_PROGRESS' WHERE "id" = $1::uuid`, [created.id]);
    }
    return { id: created.id, title };
  }

  /** A run of a task in the project's workspace: going (`RUNNING`), or waiting for a runner. */
  async function run(p: Project, taskId: string, status: RunStatus): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId,
        workspaceId: p.workspaceId,
        assignedRunnerId: runnerId,
        title: `a run of ${taskId}`,
        prompt: 'do the work',
        status,
      },
    });
    return id;
  }

  /** A work session that ran `branch` in a worktree and finished with it a while ago. */
  async function workBranch(p: Project, taskId: string, branch: string): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId,
        workspaceId: p.workspaceId,
        assignedRunnerId: runnerId,
        title: `ran ${branch}`,
        prompt: 'do the work',
        branch,
        isolationStatus: 'worktree',
        status: RunStatus.SUCCEEDED,
        baseSha: sha('1'),
        changedFiles: [] as never,
        createdAt: new Date(Date.now() - 10 * 60_000),
        finishedAt: new Date(Date.now() - 10 * 60_000),
        worktreeBranch: branch,
        worktreeDirty: false,
      },
    });
    return id;
  }

  /** A merge an agent made itself, through the door it records one with. */
  function merged(sessionId: string, targetBranch: string, nibble: string) {
    return receipts.record(ownerId, sessionId, {
      result: 'MERGED',
      sourceSha: sha(nibble),
      targetBranch,
      targetShaBefore: sha('0'),
      targetShaAfter: sha(nibble),
    } as never, 'AGENT');
  }

  /** The line is handed this task's branch — queued by the DONE (J-T1a) — and nothing else yet. */
  async function queuedLanding(taskId: string): Promise<string> {
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, taskId));
    assert.ok(queued.enqueued, `the DONE queued no landing for ${taskId}: ${JSON.stringify(queued)}`);
    return queued.jobId;
  }

  /** The heartbeat hands the queued landing to the runner that holds the branch (J-T2). */
  async function claimed(jobId: string): Promise<IntegrationJobCommand> {
    const handed = await jobs.dispatch({
      runnerId,
      leaseOwner: `lease-${jobId}`,
      draining: false,
      capabilities: [INTEGRATION_JOB_CLAIM],
    });
    const command = handed.find((candidate) => candidate.jobId === jobId);
    assert.ok(command, `the heartbeat was handed no landing ${jobId}`);
    return command;
  }

  /** The answer that runner posts (J-T5). */
  async function answered(
    command: IntegrationJobCommand,
    body: Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>,
  ) {
    const applied = await jobs.applyResult(command.jobId, runnerId, {
      claimGeneration: command.claimGeneration,
      leaseOwner: command.leaseOwner,
      ...body,
    });
    assert.ok(applied.answer.accepted, `the line's answer was refused: ${JSON.stringify(applied.answer)}`);
  }

  /** A merge of the project branch into main, as the promotion machinery queues one. */
  async function promotionJob(p: Project, kind: 'CHECK_PROMOTION' | 'LAND_PROMOTION', state: string) {
    const binding = await prisma.projectCodebase.findFirstOrThrow({
      where: { projectId: p.id },
      select: { id: true },
    });
    const id = randomUUID();
    await prisma.projectIntegrationJob.create({
      data: {
        id,
        projectId: p.id,
        ownerId,
        codebaseId: binding.id,
        kind,
        state,
        serialKey: `${REPO}#refs/heads/main#${id}`,
        targetRef: 'refs/heads/main',
        upstreamRef: 'refs/heads/main',
        sourceRef: `refs/heads/${p.branch}`,
        idempotencyKey: `done-request-${kind}-${id}`,
      },
    });
    return id;
  }

  /** `project_request_done`, through the runner's door, from the session named. */
  function ask(
    projectId: string,
    sessionId: string | undefined,
    body: RequestProjectDoneBody = CALL,
  ): Promise<ProjectDoneRequestFiled> {
    return door.requestDone(runner, sessionId, projectId, body as never) as Promise<ProjectDoneRequestFiled>;
  }

  async function requests(projectId: string): Promise<StoredRequest[]> {
    const { rows } = await sql.query<StoredRequest>(
      `SELECT "id", "state", "assignee", "assignee_reason", "asked_by_session_id", "dedupe_key",
              "title", "payload", "resolution", "resolved_by", "resolved_by_user_id",
              "resolved_by_session_id", "resolution_note", "superseded_by_item_id", "escalate_at"
         FROM "project_open_item"
        WHERE "project_id" = $1::uuid AND "kind" = 'DONE_REQUEST'
        ORDER BY "created_at", "id"`,
      [projectId],
    );
    return rows;
  }

  async function seal(projectId: string): Promise<string> {
    return (await acceptance.standardSetConfirmation(ownerId, projectId)).currentVersion.digest;
  }

  /** The coordinator conversation's row as the session list serves it: what the row lights off. */
  async function sessionRow(sessionId: string) {
    const rows = await sessions.list(ownerId, {}) as unknown as Array<{
      id: string;
      pendingApprovals: number;
      waitingKind: string | null;
    }>;
    const row = rows.find((s) => s.id === sessionId);
    assert.ok(row, 'the conversation is in this owner’s Open list');
    return row;
  }

  /** The project's row on the projects list: its "Needs you · Ready to close". */
  async function listed(projectId: string) {
    const row = (await projects.list(ownerId)).find((project) => project.id === projectId);
    assert.ok(row, 'the project is on its owner’s list');
    return (row as unknown as { attention: { doneRequest: { waitingSince: Date } | null } })
      .attention.doneRequest;
  }

  /** A task as a finding names it. */
  const ref = (task: { id: string; title: string }) => ({ taskId: task.id, title: task.title });
  const codes = (findings: readonly ProjectDoneFinding[] | undefined) =>
    (findings ?? []).map((finding) => `${finding.severity} ${finding.code}`);
  const refusalsOf = (findings: readonly ProjectDoneFinding[] | undefined) =>
    (findings ?? []).filter((finding) => finding.severity === 'REFUSE');
  const reasons = (findings: readonly ProjectDoneFinding[] | undefined) =>
    (findings ?? [])
      .filter((finding) => finding.code === 'DONE_CRITERION_UNLANDED')
      .map((finding) => `${finding.criterion?.ordinal} ${finding.reason}`);

  // ═══ (1) the refusals ══════════════════════════════════════════════════════════════════════════

  await t.test('(1a) a project that states no criteria is refused: nothing to be done against', async () => {
    const p = await project('no-criteria', []);
    const refusal = await refused(() => ask(p.id, p.sessionId));
    assert.equal(refusal.status, 409);
    assert.equal(refusal.body.code, 'DONE_REQUEST_NOT_READY');
    assert.equal(refusal.body.written, 0, 'the answer says nothing was filed');
    assert.deepEqual(codes(refusal.body.findings), ['REFUSE DONE_NO_CRITERIA']);
    const [finding] = refusal.body.findings!;
    assert.ok(finding.message && finding.requiredAction, 'it says what and what to do');
    assert.deepEqual(await requests(p.id), [], 'a refused request is not filed');
  });

  await t.test('(1b) a criterion its work has not met is refused, and so is one no work serves', async () => {
    const p = await project('unmet', ['the first thing holds', 'the second thing holds']);
    const open = await task(p, 'unmet · A', { serves: p.criteria[0], status: 'OPEN' });
    const refusal = await refused(() => ask(p.id, p.sessionId));
    assert.equal(refusal.status, 409);
    assert.equal(refusal.body.code, 'DONE_REQUEST_NOT_READY');
    assert.deepEqual(codes(refusalsOf(refusal.body.findings)), [
      'REFUSE DONE_CRITERION_UNSATISFIED',
      'REFUSE DONE_CRITERION_UNSATISFIED',
    ], 'one per criterion not met — and an OPEN task nobody is running is not work in flight');
    const [first, second] = refusalsOf(refusal.body.findings);
    assert.equal(first.criterion?.ordinal, 1);
    assert.equal(first.criterion?.key, p.criteria[0].key, 'by the key task_create takes');
    assert.deepEqual(first.tasks, [ref(open)], 'naming the work that has not settled');
    assert.equal(second.criterion?.ordinal, 2);
    assert.deepEqual(second.tasks, [], 'nothing serves the second');
    assert.ok(second.requiredAction.includes(p.criteria[1].key), 'and the next step names its key');
    assert.deepEqual(await requests(p.id), []);
  });

  await t.test('(1c) a task running, queued for a runner or IN_PROGRESS is refused, all of them named', async () => {
    const p = await project('moving', ['the work is finished']);
    await task(p, 'moving · the work', { serves: p.criteria[0], status: 'DONE', codeless: true });
    const inProgress = await task(p, 'moving · a chore IN_PROGRESS', { status: 'IN_PROGRESS' });
    const rerun = await task(p, 'moving · a finished chore run again', { status: 'DONE' });
    const rerunning = await run(p, rerun.id, RunStatus.RUNNING);
    const waiting = await task(p, 'moving · a chore waiting for a runner', { status: 'OPEN' });
    const waitingRun = await run(p, waiting.id, RunStatus.PENDING);

    const refusal = await refused(() => ask(p.id, p.sessionId));
    assert.equal(refusal.status, 409);
    assert.deepEqual(codes(refusal.body.findings), ['REFUSE DONE_TASKS_IN_FLIGHT'],
      'the criterion is met and landed — the work in flight is the only thing holding it');
    assert.deepEqual(refusal.body.findings![0].tasks, [inProgress, rerun, waiting].map(ref),
      'IN_PROGRESS, running and queued, oldest first');
    assert.deepEqual(await requests(p.id), []);

    // The same project once its work has stopped moving is one a request can be filed about.
    await sql.query(`UPDATE "session" SET "status" = 'SUCCEEDED', "finished_at" = now()
                      WHERE "id" = ANY($1::uuid[])`, [[rerunning, waitingRun]]);
    await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = ANY($1::uuid[])`,
      [[inProgress.id, waiting.id]]);
    const filed = await ask(p.id, p.sessionId);
    assert.equal(filed.state, 'OPEN');
    assert.deepEqual(filed.warnings, [], 'and nothing about it warns: its one criterion is LANDED');
  });

  await t.test('(1d) an item waiting on the owner is refused until it is answered or withdrawn', async () => {
    const p = await project('owner-item', ['the work is finished']);
    await task(p, 'owner-item · the work', { serves: p.criteria[0], status: 'DONE', codeless: true });
    const asked = await openItems.askOwner(ownerId, p.id, p.sessionId, {
      question: 'Should the release notes mention the old endpoint?',
    });
    const [item] = (await sql.query<{ title: string }>(
      `SELECT "title" FROM "project_open_item" WHERE "id" = $1::uuid`, [asked.itemId],
    )).rows;

    const refusal = await refused(() => ask(p.id, p.sessionId));
    assert.equal(refusal.status, 409);
    assert.deepEqual(codes(refusal.body.findings), ['REFUSE DONE_OWNER_ITEMS_OPEN']);
    assert.deepEqual(refusal.body.findings![0].items, [
      { itemId: asked.itemId, kind: 'COORDINATOR_QUESTION', title: item.title },
    ], 'the item, by id, kind and title');
    assert.deepEqual(await requests(p.id), []);

    // Withdrawn by the conversation that asked it, it waits on nobody.
    await openItems.resolveOpenItem(ownerId, p.id, asked.itemId, {
      note: 'answered in the plan after all',
    }, { kind: 'SESSION', sessionId: p.sessionId });
    assert.equal((await ask(p.id, p.sessionId)).state, 'OPEN');
  });

  await t.test('(1e) a landing or a merge into main queued or running is refused, every kind named', async () => {
    const p = await project('in-flight', ['the work is on main'], { line: true });
    const work = await task(p, 'in-flight · the work', { serves: p.criteria[0], status: 'DONE' });
    await workBranch(p, work.id, 'orbit/in-flight-work');

    // The DONE queued its landing.
    const landing = await queuedLanding(work.id);
    let refusal = await refused(() => ask(p.id, p.sessionId));
    assert.equal(refusal.status, 409);
    assert.deepEqual(codes(refusal.body.findings), [
      'REFUSE DONE_INTEGRATION_IN_FLIGHT',
      'WARN DONE_CRITERION_UNLANDED',
    ]);
    assert.deepEqual(refusal.body.findings![0].jobs, [
      { integrationJobId: landing, kind: 'LAND_TASK', state: 'QUEUED', taskId: work.id },
    ]);
    assert.deepEqual(reasons(refusal.body.findings), ['1 IN_FLIGHT'],
      'and the criterion it is about is in flight, not missing');
    assert.deepEqual(refusal.body.findings![1].tasks, [ref(work)]);

    // Claimed: running is the same refusal.
    const command = await claimed(landing);
    refusal = await refused(() => ask(p.id, p.sessionId));
    assert.deepEqual(refusal.body.findings![0].jobs.map((job) => `${job.kind} ${job.state}`),
      ['LAND_TASK RUNNING']);

    // Landed on the project branch: nothing in flight, and the criterion is on the project branch.
    await answered(command, {
      state: 'LANDED',
      phase: 'VERIFY',
      sourceSha: sha('8'),
      targetShaBefore: sha('c'),
      upstreamSha: sha('9'),
      testedSha: sha('a'),
      testedTreeSha: sha('e'),
      landedSha: sha('a'),
      landedTreeSha: sha('e'),
    });
    const filed = await ask(p.id, p.sessionId);
    assert.deepEqual(reasons(filed.warnings), ['1 ON_PROJECT_BRANCH']);

    // Its merge into main, checked and then landed — each queued or running refuses.
    const check = await promotionJob(p, 'CHECK_PROMOTION', 'RUNNING');
    const land = await promotionJob(p, 'LAND_PROMOTION', 'QUEUED');
    refusal = await refused(() => ask(p.id, p.sessionId));
    assert.deepEqual(codes(refusal.body.findings), [
      'REFUSE DONE_INTEGRATION_IN_FLIGHT',
      'WARN DONE_CRITERION_UNLANDED',
    ]);
    assert.deepEqual(refusal.body.findings![0].jobs, [
      { integrationJobId: check, kind: 'CHECK_PROMOTION', state: 'RUNNING', taskId: null },
      { integrationJobId: land, kind: 'LAND_PROMOTION', state: 'QUEUED', taskId: null },
    ]);
    assert.deepEqual(reasons(refusal.body.findings), ['1 IN_FLIGHT'],
      'work on the project branch is in flight while its merge into main is');
    assert.equal((await requests(p.id)).filter((row) => row.state === 'OPEN').length, 1,
      'a refusal writes nothing — the request filed before it is still the one open');
  });

  await t.test('(1f) every refusal comes back in one answer, refusals first, warnings beside them', async () => {
    const p = await project('everything-at-once', ['the first thing holds', 'the second thing holds'],
      { line: true });
    const unmet = await task(p, 'everything · A', { serves: p.criteria[0], status: 'OPEN' });
    const moving = await task(p, 'everything · a chore', { status: 'IN_PROGRESS' });
    const asked = await openItems.askOwner(ownerId, p.id, p.sessionId, { question: 'Ship it on Friday?' });
    const promotion = await promotionJob(p, 'LAND_PROMOTION', 'QUEUED');

    const refusal = await refused(() => ask(p.id, p.sessionId));
    assert.equal(refusal.status, 409);
    assert.equal(refusal.body.code, 'DONE_REQUEST_NOT_READY');
    assert.deepEqual(codes(refusal.body.findings), [
      'REFUSE DONE_CRITERION_UNSATISFIED',
      'REFUSE DONE_CRITERION_UNSATISFIED',
      'REFUSE DONE_TASKS_IN_FLIGHT',
      'REFUSE DONE_OWNER_ITEMS_OPEN',
      'REFUSE DONE_INTEGRATION_IN_FLIGHT',
      'WARN DONE_CRITERION_UNLANDED',
      'WARN DONE_CRITERION_UNLANDED',
    ], 'every finding, refusals first — a coordinator fixes the project in one pass');
    assert.match(refusal.body.message ?? '', /5 checks refused it/);
    const findings = refusal.body.findings!;
    assert.deepEqual(findings[0].tasks, [ref(unmet)]);
    assert.deepEqual(findings[2].tasks, [ref(moving)]);
    assert.deepEqual(findings[3].items.map((item) => item.itemId), [asked.itemId]);
    assert.deepEqual(findings[4].jobs.map((job) => job.integrationJobId), [promotion]);
    for (const finding of findings) {
      assert.ok(finding.message && finding.requiredAction, `${finding.code} says what and what to do`);
    }
    assert.deepEqual(await requests(p.id), []);
  });

  // ═══ (2) the warnings, and the request filed ═══════════════════════════════════════════════════

  // One project whose every criterion is met, each landed — or not — in a different way. Built once:
  // (3) and (4) go on with it.
  const MAIN = 'its work merged into main';
  const BRANCH = 'its work merged into the project branch';
  const NOTHING = 'its work committed nothing';
  const RECEIPTLESS = 'its work ran a branch nobody recorded a merge of';
  const BRANCHLESS = 'its work ran no branch at all';
  const p = await project('closing', [MAIN, BRANCH, NOTHING, RECEIPTLESS, BRANCHLESS], { line: true });
  const [onMain, onBranch, nothing, receiptless, branchless] = p.criteria;

  const onMainTask = await task(p, 'closing · merged into main', { serves: onMain, status: 'DONE' });
  await merged(await workBranch(p, onMainTask.id, 'orbit/closing-main'), 'main', 'b');
  const onBranchTask = await task(p, 'closing · merged into the project branch', {
    serves: onBranch, status: 'DONE',
  });
  await merged(await workBranch(p, onBranchTask.id, 'orbit/closing-branch'), p.branch, 'd');
  // The line was handed its branch after it finished, and found no commit of its own on it — against
  // a line that had moved past main, so the answer cannot say the branch is on main.
  const nothingTask = await task(p, 'closing · the go-live', { serves: nothing, status: 'DONE' });
  await workBranch(p, nothingTask.id, 'orbit/closing-go-live');
  await answered(await claimed(await queuedLanding(nothingTask.id)), {
    state: 'NOTHING_TO_LAND',
    phase: 'REBASE',
    sourceSha: sha('1'),
    targetShaBefore: sha('c'),
    upstreamSha: sha('9'),
  });
  const receiptlessTask = await task(p, 'closing · merged by hand', { serves: receiptless, status: 'DONE' });
  await workBranch(p, receiptlessTask.id, 'orbit/closing-by-hand');
  const branchlessTask = await task(p, 'closing · the walkthrough', { serves: branchless, status: 'DONE' });

  /** The gaps the coordinator names: the two criteria Orbit can never prove by a merge. */
  const GAPS: RequestProjectDoneBody = {
    judgment: 'The goal is met. Two things Orbit cannot prove by itself — I checked both, below.',
    gaps: [
      {
        criterionKey: nothing.key,
        title: 'Go-live has nothing to land',
        whyNotProven: 'Its task made no commits, so there is no merge to hold a receipt for.',
        coordinatorChecked: 'main contains all 15 files this project added or changed',
        evidenceRefs: [`task ${nothingTask.id}`],
      },
      {
        // The definition's own uuid names the criterion too; it is filed as the key.
        criterionKey: branchless.definitionId,
        whyNotProven: 'The walkthrough ran no branch: nothing of it was ever going to land.',
        coordinatorChecked: 'the walkthrough log covers every screen on the card',
        evidenceRefs: ['https://example.invalid/walkthrough', `task ${branchlessTask.id}`],
      },
    ],
  };

  let filed: ProjectDoneRequestFiled;

  await t.test('(2) every criterion not LANDED warns with why, and the request is filed with them', async () => {
    filed = await ask(p.id, ` ${p.sessionId} `, GAPS);
    assert.equal(filed.state, 'OPEN');
    assert.equal(filed.alreadyOpen, false);
    assert.equal(filed.superseded, null);
    assert.deepEqual(reasons(filed.warnings), [
      '2 ON_PROJECT_BRANCH',
      '3 NOTHING_TO_LAND',
      '4 NO_RECEIPT',
      '5 CODELESS',
    ], 'one warning per criterion not LANDED — and none for the one merged into main');
    assert.deepEqual(codes(filed.warnings), Array(4).fill('WARN DONE_CRITERION_UNLANDED'));
    const byOrdinal = new Map(filed.warnings.map((finding) => [finding.criterion!.ordinal, finding]));
    assert.deepEqual(byOrdinal.get(2)!.tasks, [ref(onBranchTask)], 'naming the work on the project branch');
    assert.deepEqual(byOrdinal.get(3)!.tasks, [ref(nothingTask)]);
    assert.deepEqual(byOrdinal.get(4)!.tasks, [ref(receiptlessTask)]);
    assert.deepEqual(byOrdinal.get(5)!.tasks, [ref(branchlessTask)]);
    assert.equal(byOrdinal.get(5)!.criterion!.key, branchless.key);
    for (const finding of filed.warnings) {
      assert.ok(finding.message && finding.requiredAction, `${finding.reason} says what and what to do`);
    }
    // A warning says when no gap explains it: the owner reads the two side by side.
    assert.match(byOrdinal.get(2)!.message, /none of the gaps names it/);
    assert.match(byOrdinal.get(4)!.message, /none of the gaps names it/);
    assert.doesNotMatch(byOrdinal.get(3)!.message, /none of the gaps names it/);
    assert.doesNotMatch(byOrdinal.get(5)!.message, /none of the gaps names it/);

    const [stored] = await requests(p.id);
    assert.equal(stored.id, filed.itemId);
    assert.equal(stored.state, 'OPEN');
    assert.equal(stored.assignee, 'OWNER', 'a done request is the owner’s from birth');
    assert.equal(stored.assignee_reason, 'DEFAULT');
    assert.equal(stored.asked_by_session_id, p.sessionId, 'it records who asked');
    assert.equal(stored.dedupe_key, 'DONE_REQUEST');
    assert.equal(stored.title, 'Is this project done?');
    assert.equal(stored.escalate_at, null, 'already the owner’s: nowhere to escalate to');
    assert.equal(stored.payload.judgment, GAPS.judgment);
    assert.equal(stored.payload.criteriaDigest, await seal(p.id),
      'it names the seal the owner’s DONE compares');
    assert.match(stored.payload.stateDigest ?? '', /^[0-9a-f]{64}$/);
    assert.deepEqual(stored.payload.warnings, filed.warnings, 'the warnings are filed with it');
    assert.deepEqual(stored.payload.gaps, [
      GAPS.gaps[0],
      { ...GAPS.gaps[1], criterionKey: branchless.key },
    ], 'every gap as it was named, its criterion by key');

    // The owner reads it beside the exceptions rather than among them, as the start request is.
    const view = await openItems.list(ownerId, p.id);
    assert.equal(view.doneRequest?.itemId, filed.itemId);
    assert.equal(view.doneRequest?.kind, 'DONE_REQUEST');
    assert.equal(view.doneRequest?.title, 'Is this project done?');
    assert.equal(view.doneRequest?.detailLine, 'The coordinator asked · 2 gaps it couldn’t prove');
    assert.deepEqual(view.doneRequest?.doneRequest, stored.payload, 'the card is drawn from the payload');
    assert.deepEqual(view.doneRequest?.actions, []);
    assert.equal(view.startRequest, null);
    assert.deepEqual(view.needsYou, [], 'not among the exceptions');
    assert.deepEqual(view.withCoordinator, []);
  });

  // ═══ (3) one request, and only while it is true ════════════════════════════════════════════════

  await t.test('(3a) the same request again is the same row; a newer one supersedes it', async () => {
    const again = await ask(p.id, p.sessionId, GAPS);
    assert.equal(again.itemId, filed.itemId, 'the same request re-sent is the one already open');
    assert.equal(again.alreadyOpen, true);
    assert.equal((await requests(p.id)).length, 1, 'and it wrote nothing');

    const newer = await ask(p.id, p.sessionId, { ...GAPS, judgment: 'Done, and checked twice.' });
    assert.notEqual(newer.itemId, filed.itemId);
    assert.deepEqual(newer.superseded, { itemId: filed.itemId }, 'it says which request it replaced');
    const [old, current] = await requests(p.id);
    assert.equal(old.state, 'SUPERSEDED');
    assert.equal(old.superseded_by_item_id, newer.itemId, 'the old one names its successor');
    assert.equal(old.resolved_by, 'COORDINATOR');
    assert.equal(old.resolved_by_session_id, p.sessionId);
    assert.equal(current.state, 'OPEN');
    assert.equal((await openItems.list(ownerId, p.id)).doneRequest?.itemId, newer.itemId,
      'the owner is shown the newer one, and only it');
    filed = newer;
  });

  /** The request open now, superseded by the read that would show it, or still OPEN. */
  async function afterRead(itemId: string) {
    const view = await openItems.list(ownerId, p.id);
    const row = (await requests(p.id)).find((request) => request.id === itemId)!;
    return { view, row };
  }

  await t.test('(3b) a task filed after the request supersedes it, the next time it is read', async () => {
    assert.equal((await openItems.list(ownerId, p.id)).doneRequest?.itemId, filed.itemId,
      'drawn while the project is the one it was made about');
    await task(p, 'closing · one more chore', { status: 'OPEN' });
    const { view, row } = await afterRead(filed.itemId);
    assert.equal(view.doneRequest, null, 'the owner is no longer shown a card about a project that moved');
    assert.equal(row.state, 'SUPERSEDED');
    assert.equal(row.resolved_by, 'PLATFORM');
    assert.equal(row.superseded_by_item_id, null, 'nothing replaced it: the coordinator asks again');
    assert.match(row.resolution_note ?? '', /tasks/);
  });

  await t.test('(3c) the criteria edited after the request supersede it', async () => {
    const refiled = await ask(p.id, p.sessionId, GAPS);
    assert.equal(refiled.superseded, null, 'the moved request was already superseded');
    const added = 'the release notes are written';
    const criteria = await state(p.id, [MAIN, BRANCH, NOTHING, RECEIPTLESS, BRANCHLESS, added]);
    const { view, row } = await afterRead(refiled.itemId);
    assert.equal(view.doneRequest, null);
    assert.equal(row.state, 'SUPERSEDED');
    assert.match(row.resolution_note ?? '', /criteria/);
    // Served, so the project can be asked about again.
    await task(p, 'closing · the release notes', { serves: criteria[5], status: 'DONE', codeless: true });
  });

  await t.test('(3d) a merge recorded after the request supersedes it: where the work is has moved', async () => {
    const refiled = await ask(p.id, p.sessionId, GAPS);
    assert.deepEqual(reasons(refiled.warnings),
      ['2 ON_PROJECT_BRANCH', '3 NOTHING_TO_LAND', '4 NO_RECEIPT', '5 CODELESS']);
    // The branch that was merged by hand gets its receipt.
    const [handSession] = (await sql.query<{ id: string }>(
      `SELECT "id" FROM "session" WHERE "task_id" = $1::uuid`, [receiptlessTask.id],
    )).rows;
    await merged(handSession.id, 'main', 'f');
    const { view, row } = await afterRead(refiled.itemId);
    assert.equal(view.doneRequest, null);
    assert.equal(row.state, 'SUPERSEDED');
    assert.match(row.resolution_note ?? '', /landed/);
    // And asked again, the criterion that landed no longer warns.
    filed = await ask(p.id, p.sessionId, GAPS);
    assert.deepEqual(reasons(filed.warnings), ['2 ON_PROJECT_BRANCH', '3 NOTHING_TO_LAND', '5 CODELESS']);
  });

  await t.test('(3e) the owner’s press on a request whose work moved since is 409, and writes nothing', async () => {
    // A run starts, and nobody has read the open items since: the request is still OPEN.
    const started = await run(p, onMainTask.id, RunStatus.RUNNING);
    const [before] = (await sql.query<{ status: string; done_by: string | null }>(
      `SELECT "status", "done_by" FROM "project" WHERE "id" = $1::uuid`, [p.id],
    )).rows;
    const refusal = await refused(async () => acceptance.recordProjectDone(ownerId, p.id, {
      requestId: filed.itemId,
      criteriaDigest: await seal(p.id),
      acceptedGaps: GAPS.gaps,
    }));
    assert.equal(refusal.status, 409);
    assert.equal(refusal.body.code, 'PROJECT_DONE_REQUEST_STALE');
    const [after] = (await sql.query<{ status: string; done_by: string | null }>(
      `SELECT "status", "done_by" FROM "project" WHERE "id" = $1::uuid`, [p.id],
    )).rows;
    assert.deepEqual(after, before, 'the project is not recorded done');
    assert.equal((await requests(p.id)).find((row) => row.id === filed.itemId)!.state, 'OPEN',
      'and the refused press ended nothing — the next read supersedes it');
    assert.equal((await afterRead(filed.itemId)).row.state, 'SUPERSEDED');

    await sql.query(`UPDATE "session" SET "status" = 'SUCCEEDED', "finished_at" = now()
                      WHERE "id" = $1::uuid`, [started]);
  });

  // ═══ (4) Ready to close ════════════════════════════════════════════════════════════════════════

  await t.test('(4) while the request stands, the session row and the list say Ready to close', async () => {
    assert.equal((await sessionRow(p.sessionId)).pendingApprovals, 0,
      'with no request open, nothing is waiting on the coordinator conversation');
    assert.equal(await listed(p.id), null);

    filed = await ask(p.id, p.sessionId, GAPS);
    const row = await sessionRow(p.sessionId);
    assert.equal(row.pendingApprovals, 1, 'the coordinator row says somebody is waiting on it');
    assert.equal(row.waitingKind, 'DONE_REQUEST', 'and names what is waiting: Ready to close');
    const asking = await listed(p.id);
    assert.ok(asking, 'the list carries the open request');
    assert.ok(asking.waitingSince instanceof Date, 'and since when it has been asking');

    // The owner records it done on the card: the request is answered, and both go dark.
    const record = await acceptance.recordProjectDone(ownerId, p.id, {
      requestId: filed.itemId,
      criteriaDigest: await seal(p.id),
      acceptedGaps: GAPS.gaps,
    });
    assert.equal(record.doneBy, 'OWNER');
    const answer = (await requests(p.id)).find((request) => request.id === filed.itemId)!;
    assert.equal(answer.state, 'RESOLVED');
    assert.equal(answer.resolution, 'APPROVED');
    assert.equal(answer.resolved_by_user_id, ownerId);
    const dark = await sessionRow(p.sessionId);
    assert.equal(dark.pendingApprovals, 0);
    assert.equal(dark.waitingKind, null);
    assert.equal(await listed(p.id), null);
    assert.equal((await openItems.list(ownerId, p.id)).doneRequest, null);

    // A project recorded done has nothing left to ask.
    const done = await refused(() => ask(p.id, p.sessionId, GAPS));
    assert.equal(done.status, 409);
    assert.equal(done.body.code, 'PROJECT_ALREADY_DONE');
  });

  await t.test('(4b) a request left open on a project that is no longer OPEN asks nobody anything', async () => {
    const q = await project('cancelled', ['the work is finished']);
    await task(q, 'cancelled · the work', { serves: q.criteria[0], status: 'DONE', codeless: true });
    await ask(q.id, q.sessionId);
    assert.equal((await sessionRow(q.sessionId)).waitingKind, 'DONE_REQUEST');
    await projects.update(ownerId, q.id, { status: 'CANCELLED' } as never);
    assert.equal((await sessionRow(q.sessionId)).pendingApprovals, 0, 'the row goes dark');
    assert.equal(await listed(q.id), null, 'and so does the list');
    assert.equal((await openItems.list(ownerId, q.id)).doneRequest, null, 'the read supersedes it');
    assert.match((await requests(q.id))[0].resolution_note ?? '', /CANCELLED/);
    const cancelled = await refused(() => ask(q.id, q.sessionId));
    assert.equal(cancelled.status, 409);
    assert.equal(cancelled.body.code, 'PROJECT_CANCELLED');
  });

  // ═══ (5) who may ask, and what a gap is ════════════════════════════════════════════════════════

  await t.test('(5a) only the coordinating conversation may ask', async () => {
    const q = await project('who-may-ask', ['the work is finished']);
    await task(q, 'who-may-ask · the work', { serves: q.criteria[0], status: 'DONE', codeless: true });
    const stranger = await conversation(q.workspaceId, '一个别的会话');
    for (const [label, session] of [
      ['another session', stranger],
      ['no session at all', undefined],
      ['a blank session header', '   '],
    ] as const) {
      const refusal = await refused(() => ask(q.id, session));
      assert.equal(refusal.status, 403, `${label} may not ask`);
      assert.equal(refusal.body.code, 'DONE_REQUEST_COORDINATOR_ONLY');
    }
    assert.deepEqual(await requests(q.id), [], 'and the refusals filed nothing');
    assert.equal((await ask(q.id, q.sessionId)).state, 'OPEN', 'the conversation the project points at may');
  });

  await t.test('(5b) a call with no judgment, or a gap missing a part or about no stated criterion, is 400', async () => {
    const q = await project('bad-gaps', ['the work is finished']);
    await task(q, 'bad-gaps · the work', { serves: q.criteria[0], status: 'DONE', codeless: true });
    const gap = {
      criterionKey: q.criteria[0].key,
      whyNotProven: 'it is a judgment call',
      coordinatorChecked: 'I read it',
      evidenceRefs: ['the review comment'],
    };
    for (const [label, body] of [
      ['a blank judgment', { judgment: '  ', gaps: [] }],
      ['gaps that are not a list', { judgment: 'Done.', gaps: gap }],
      ['a gap with no criterion', { judgment: 'Done.', gaps: [{ ...gap, criterionKey: ' ' }] }],
      ['a gap with no reason', { judgment: 'Done.', gaps: [{ ...gap, whyNotProven: undefined }] }],
      ['a gap with nothing checked', { judgment: 'Done.', gaps: [{ ...gap, coordinatorChecked: '' }] }],
      ['a gap with no evidence', { judgment: 'Done.', gaps: [{ ...gap, evidenceRefs: [] }] }],
      ['a gap about a criterion the project does not state',
        { judgment: 'Done.', gaps: [{ ...gap, criterionKey: criterionKeyOf(randomUUID()) }] }],
    ] as const) {
      const refusal = await refused(() => ask(q.id, q.sessionId, body as never));
      assert.equal(refusal.status, 400, `${label} is a request the card cannot draw`);
    }
    assert.deepEqual(await requests(q.id), []);
  });
});

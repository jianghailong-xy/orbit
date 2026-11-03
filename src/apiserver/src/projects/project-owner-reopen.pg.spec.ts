/**
 * The account owner's Reopen project holds, and the projection is still the projection.
 *
 * WHAT THE OWNER DECIDED
 * ----------------------
 * On 2026-11-03: pressing Reopen project has to stand. Until then `PATCH /projects/:id` wrote OPEN and
 * the next task write, merge receipt or decision stored DONE again whenever the facts still proved it
 * (`bgj_9b358829537d`, task 34qvaUbhr9IEztJuVYJ3B), and R8 then refused every session's task writes. So
 * an owner who reopened a finished project to add work saw the coordinator's first new task close it
 * again, with that task out of reach. After the press the project stays OPEN until the owner records
 * it done, the seal moves, or a task serving a criterion changes: its status, a new evidence revision
 * or decision, a new verdict, a new merge receipt. A task that serves no criterion changes none of it,
 * and neither does pointing a task at a criterion or moving one off, which a session could otherwise
 * use to store DONE over the press.
 *
 * WHY THE CASES ARE SHAPED LIKE THIS
 * ----------------------------------
 * Each case starts from a fresh project the facts have settled, recorded DERIVED, because each is
 * about one change and a shared timeline would let an earlier one end the press for it. A case about a
 * fact that ends the press has both halves where they exist: the same kind of change leaving the
 * project OPEN because the facts do not prove DONE, and storing DERIVED DONE because they do.
 *
 * Every press goes over HTTP through the production controller and its JWT guard, because the owner
 * door is what makes a write the press. Every later fact is produced the way the product produces it,
 * and the projection runs on those writers' own post-commit edges. It is called directly in one case,
 * for a race that cannot be produced any other way. The stored row is read with SQL, past every service.
 *
 * It reads the new columns with `row_to_json`, so this file compiles and runs against code from before
 * the rule, and goes red there on the statuses rather than on a missing column.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-owner-reopen.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  CreatorType,
  ProjectStatus,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  type PrismaClient,
} from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { TasksService } from '../tasks/tasks.service';
import type { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { projectAcceptanceLandedFact } from './coordinator-wake';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { readDerivedProjectDone, storeDerivedProjectStatus } from './project-done-derived';
import { ProjectFuseService } from './project-fuse.service';
import { ProjectHandoffService } from './project-handoff.service';
import { projectsToRecordAsDone, readProjectFinish } from './project-looks-finished';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

// What `main.ts` installs: the project document this door answers with carries BIGINT columns.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const METHOD = 'HUMAN';
const STRICTER = 'VERIFICATION';
const FIRST = 'the first thing the project set out to do is done';
const SECOND = 'the second thing the project set out to do is done';
const OWN_STANDARD = 'this task’s own standard, which serves no criterion of the project';

/** One worktree-run task of a project. */
interface Work { id: string; run: string }

/** A project the facts have settled, with a task of each settling shape under each criterion. */
interface World {
  projectId: string;
  coordinator: string;
  firstKey: string;
  secondKey: string;
  firstDefinitionId: string;
  secondDefinitionId: string;
  /** EXECUTABLE: its status is its settlement. */
  plain: Work;
  /** EVIDENCE_JUDGMENT: settled by a CONFIRM of its newest revision. */
  judged: Work;
  /** The next revision number of `judged`'s evidence. */
  revisions: { judged: number };
}

test('the owner’s Reopen project stands until the facts it was pressed over change', {
  skip, concurrency: 1, timeout: 600_000,
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

  // ── the writers, wired the way the product wires them ─────────────────────────────────────────

  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
  const openItems = new ProjectOpenItemService(db, sessions);
  /** What a settled project WAKES is another unit's question, so these doors answer with nothing;
   *  what matters here is that the edges carrying the projection run. */
  const completionInputs = {
    routeSettledUnmerged: async () => [],
    routeSettledProjects: async () => [],
    routeReadyCriteria: async () => [],
    routeUnlandedCriteria: async () => [],
    routeReadyDependents: async () => [],
    routeTaskExceptions: async () => [],
    routeCompletionEvidence: async () => ({}),
  } as unknown as CompletionInputRouter;
  const receipts = new MergeReceiptService(db, completionInputs);
  const tasks = new TasksService(db as never, sessions, realtime as never, undefined, completionInputs);
  const evidence = new TaskCompletionEvidenceService(db, tasks, completionInputs);
  const deliveries = new CoordinatorDeliveryService(db, new CoordinatorWakeService(db), sessions);
  // The runner's door. It spends no orchestration credential on anything this file sends it.
  const door = new RunnerProjectsController(
    projects,
    acceptance,
    {} as never,
    { assert: async () => assert.fail('nothing here spends an orchestration credential') } as never,
    openItems,
  );

  // ── an owner, a machine, and the production controller over HTTP ──────────────────────────────

  const ownerId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `owner-reopen-${ownerId}@project-done.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const runner = await prisma.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'owner-reopen-runner',
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await prisma.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'owner-reopen-workspace', enabled: true },
  });
  const judge = randomUUID();
  await prisma.session.create({
    data: {
      id: judge,
      ownerId,
      creatorId: ownerId,
      title: 'the run that judges evidence',
      prompt: 'read the ledger and decide',
    },
  });

  @Module({
    controllers: [ProjectsController],
    providers: [
      { provide: ProjectsService, useValue: projects },
      { provide: ProjectAcceptanceService, useValue: acceptance },
      { provide: ProjectHandoffService, useValue: {} },
      { provide: SessionAttemptService, useValue: {} },
      { provide: TaskCheckpointService, useValue: {} },
      { provide: ProjectOpenItemService, useValue: {} },
      { provide: ProjectFuseService, useValue: {} },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: ownerId }) } },
      { provide: PrismaService, useValue: prisma },
    ],
  })
  class OwnerReopenModule {}
  const app = await NestFactory.create(OwnerReopenModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const owner = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${base}/api/projects/${path}`, {
      method,
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  /** One press of Reopen project, as every client sends it. */
  async function pressReopen(projectId: string) {
    const response = await owner('PATCH', uuidToBase62(projectId), { status: 'OPEN' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }

  async function currentSeal(projectId: string): Promise<string> {
    return (await acceptance.standardSetConfirmation(ownerId, projectId)).currentVersion.digest;
  }

  /** One press of Record as done, as the card sends it. */
  async function recordDone(projectId: string, requestId?: string) {
    const response = await owner('POST', `${uuidToBase62(projectId)}/done`, {
      ...(requestId ? { requestId: uuidToBase62(requestId) } : {}),
      criteriaDigest: await currentSeal(projectId),
      acceptedGaps: [],
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }

  // ── what is read back ─────────────────────────────────────────────────────────────────────────

  async function row(projectId: string): Promise<Record<string, unknown>> {
    const { rows } = await sql.query<{ row: Record<string, unknown> }>(
      `SELECT row_to_json(p) AS "row" FROM "project" p WHERE p."id" = $1::uuid`, [projectId],
    );
    assert.equal(rows.length, 1, 'the project must still exist');
    return rows[0]!.row;
  }

  async function stored(projectId: string): Promise<{ status: unknown; done_by: unknown }> {
    const { status, done_by } = await row(projectId);
    return { status, done_by };
  }

  const OPEN = { status: ProjectStatus.OPEN, done_by: null };
  const DERIVED = { status: ProjectStatus.DONE, done_by: 'DERIVED' };
  const BY_OWNER = { status: ProjectStatus.DONE, done_by: 'OWNER' };

  /** Whether a press is on record, off the row. */
  async function pressOnRecord(projectId: string): Promise<boolean> {
    const { reopened_at, reopened_facts } = await row(projectId);
    assert.equal(reopened_at == null, reopened_facts == null, 'a press is recorded whole');
    return reopened_at != null;
  }

  async function factsProve(projectId: string): Promise<boolean> {
    return (await readDerivedProjectDone(db, ownerId, projectId)).done;
  }

  // ── the fixture's own vocabulary ──────────────────────────────────────────────────────────────

  async function coordinatorSession(title: string): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
        title,
        prompt: title,
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        runtimeSessionId: randomUUID(),
        startsTaskWork: false,
      },
    });
    await prisma.conversationTurn.create({
      data: {
        sessionId: id,
        seq: 1,
        clientTurnId: SessionsService.initialTurnClientId(id),
        kind: 'message',
        content: title,
        status: 'ANSWERED',
      },
    });
    return id;
  }

  async function worktreeRun(taskId: string): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId,
        title: `ran ${taskId}`,
        prompt: 'do the work',
        status: RunStatus.SUCCEEDED,
        branch: `orbit/${taskId}`,
        isolationStatus: 'worktree',
      },
    });
    await prisma.toolCall.create({
      data: {
        sessionId: id,
        name: 'Bash',
        toolUseId: `toolu_${id}`,
        input: { command: 'true', description: 'the work this evidence cites' },
        isError: false,
      },
    });
    return id;
  }

  /** Through 0193/0230's fence, as a turn's acceptance settles an EXECUTABLE task. No edge runs. */
  async function settleExecutable(taskId: string) {
    const written = await sql.query(
      `UPDATE "task" SET "status" = 'DONE'
        WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')
          AND "completion_criterion" = 'EXECUTABLE' AND "acceptance_command" = 'true'
          AND "acceptance_expected_exit_code" = 0`,
      [taskId],
    );
    assert.equal(written.rowCount, 1, 'the task must reach DONE through the DONE fence');
  }

  /** A NEW receipt each call: the door is idempotent, and a re-report would be no edge at all. */
  let landings = 0;
  async function receipt(
    run: string,
    fields: { result?: 'MERGED' | 'CONFLICT'; targetBranch?: string; conflicts?: string[] } = {},
  ) {
    landings += 1;
    const result = fields.result ?? 'MERGED';
    const recorded = await receipts.record(ownerId, run, {
      result,
      sourceSha: landings.toString(16).padStart(40, '0'),
      targetBranch: fields.targetBranch ?? 'main',
      ...(result === 'MERGED' ? { targetShaBefore: 'a'.repeat(40), targetShaAfter: 'b'.repeat(40) } : {}),
      ...(fields.conflicts ? { conflicts: fields.conflicts } : {}),
    }, 'AGENT');
    assert.equal(recorded.created, true, 'the door recorded no new receipt');
  }

  const actor = { type: CreatorType.USER, id: ownerId } as const;

  async function submitEvidence(
    taskId: string,
    run: string,
    criterion: { key: string; text: string },
    revision: number,
  ): Promise<string> {
    await evidence.submit(ownerId, taskId, actor, {
      sourceSessionId: run,
      evidence: {
        claim: `the work is done, attempt ${revision}`,
        criterion,
        checks: [{ kind: 'TOOL_CALL', ref: `toolu_${run}` }],
        gaps: [],
      },
    });
    return String(revision);
  }

  async function decide(taskId: string, revision: string, decision: 'CONFIRM' | 'SEND_BACK') {
    await evidence.decide(ownerId, taskId, actor, {
      decidingSessionId: judge,
      evidenceRevision: revision,
      decision,
      ...(decision === 'SEND_BACK' ? { note: 'try again' } : {}),
    });
  }

  /** One more version of the judged task's evidence, through the door a run submits it through. */
  async function aNewRevision(world: World): Promise<string> {
    world.revisions.judged += 1;
    return submitEvidence(world.judged.id, world.judged.run, {
      key: world.secondKey, text: SECOND,
    }, world.revisions.judged);
  }

  /** A project with both criteria stated and each task's work done, and neither landed nor confirmed. */
  async function unsettledProject(title: string): Promise<World> {
    const projectId = randomUUID();
    const coordinator = await coordinatorSession(`Coordinating ${title}`);
    await prisma.project.create({
      data: {
        id: projectId,
        ownerId,
        title,
        coordinatorWorkspaceId: workspaceId,
        coordinatorSessionId: coordinator,
        coordinatorEnabled: true,
      },
    });
    await prisma.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
    const [first, second] = criteriaFromDefinitions(
      (await projects.update(ownerId, projectId, {
        acceptanceCriteriaItems: [FIRST, SECOND].map((text) => ({ text, verificationMethod: METHOD })),
      } as never)).acceptanceCriteriaItems,
    );
    assert.ok(first && second, 'the fixture states two criteria');

    const plain = await tasks.create(ownerId, {
      title: 'the plain work',
      projectId,
      criterionKey: first.key,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    const plainRun = await worktreeRun(plain.id);
    await settleExecutable(plain.id);

    const judged = await tasks.create(ownerId, {
      title: 'the judged work',
      projectId,
      criterionKey: second.key,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    } as never);
    const judgedRun = await worktreeRun(judged.id);
    const world: World = {
      projectId,
      coordinator,
      firstKey: first.key,
      secondKey: second.key,
      firstDefinitionId: first.definitionId,
      secondDefinitionId: second.definitionId,
      plain: { id: plain.id, run: plainRun },
      judged: { id: judged.id, run: judgedRun },
      revisions: { judged: 0 },
    };
    await decide(judged.id, await aNewRevision(world), 'CONFIRM');
    return world;
  }

  /** A project the facts have settled: the starting position of almost every case below. */
  async function settledProject(title: string): Promise<World> {
    const world = await unsettledProject(title);
    await receipt(world.plain.run);
    await receipt(world.judged.run);
    await acceptance.confirmStandardSet(ownerId, world.projectId, {
      criteriaDigest: await currentSeal(world.projectId),
    });
    assert.deepEqual(await stored(world.projectId), DERIVED, 'the fixture settles by the facts');
    assert.equal(await pressOnRecord(world.projectId), false);
    return world;
  }

  /** A settled project with the owner's press standing over it. */
  async function reopenedProject(title: string): Promise<World> {
    const world = await settledProject(title);
    await pressReopen(world.projectId);
    assert.deepEqual(await stored(world.projectId), OPEN, 'the press writes OPEN');
    assert.equal(await factsProve(world.projectId), true, 'and the facts still prove DONE');
    return world;
  }

  /** A task in the project that serves no criterion. */
  async function otherWork(world: World, title: string, fields: Record<string, unknown> = {}) {
    return tasks.create(ownerId, { title, projectId: world.projectId, ...fields } as never);
  }

  // ═══ the press stands while no fact moves ════════════════════════════════════════════════════

  await t.test('the press is recorded, on the owner door, and is not told to anyone', async () => {
    const world = await settledProject('the press');
    const turns = async () => (await sql.query(
      `SELECT count(*)::int AS "count" FROM "conversation_turn" WHERE "session_id" = $1::uuid`, [world.coordinator],
    )).rows[0].count as number;
    const toldBefore = await turns();
    const pressedAt = Date.now();
    await pressReopen(world.projectId);

    const pressed = await row(world.projectId);
    assert.equal(pressed.status, ProjectStatus.OPEN);
    assert.equal(pressed.done_by, null, 'a project taken out of DONE carries no record of one');
    assert.ok(Date.parse(pressed.reopened_at as string) >= pressedAt - 1_000, 'recorded when it was pressed');
    const facts = pressed.reopened_facts as { seal: string; tasks: Record<string, string> };
    assert.equal(facts.seal, await currentSeal(world.projectId));
    assert.deepEqual(Object.keys(facts.tasks).sort(), [world.plain.id, world.judged.id].sort(),
      'each task serving a criterion, and no other');
    for (const digest of Object.values(facts.tasks)) assert.match(digest, /^[0-9a-f]{64}$/u);
    const read = await projects.get(ownerId, world.projectId) as unknown as Record<string, unknown>;
    assert.ok(read.reopenedAt, 'the document says a press is on record');
    assert.equal('reopenedFacts' in read, false, 'and leaves out what only the projection reads');
    assert.equal(await turns(), toldBefore, 'the owner’s own press is not news to the coordinator');
  });

  await t.test('a write to a task serving a criterion that moves no fact leaves it OPEN', async () => {
    const world = await reopenedProject('a task write');
    await tasks.update(ownerId, world.plain.id, { title: 'the plain work, renamed' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'a rename stored DONE over the press');
    await tasks.update(ownerId, world.judged.id, { description: 'what the work was about' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'a description stored DONE over the press');
    assert.equal(await factsProve(world.projectId), true, 'and this is the facts proving DONE throughout');
  });

  await t.test('a new task serving no criterion leaves it OPEN, whatever becomes of that task', async () => {
    const world = await reopenedProject('new work');
    const added = await otherWork(world, 'the work the owner reopened it for', {
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    });
    await tasks.update(ownerId, added.id, { title: 'the work the owner reopened it for, filed' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'filing it stored DONE over the press');
    assert.equal(await factsProve(world.projectId), true, 'no criterion counts it');

    await settleExecutable(added.id);
    await tasks.update(ownerId, added.id, { title: 'the work the owner reopened it for, finished' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'finishing it stored DONE over the press');
  });

  await t.test('a merge receipt that is not about serving work leaves it OPEN', async () => {
    const world = await reopenedProject('a receipt');
    const added = await otherWork(world, 'work that merges', {
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    });
    await settleExecutable(added.id);
    await receipt(await worktreeRun(added.id));
    assert.deepEqual(await stored(world.projectId), OPEN, 'a receipt stored DONE over the press');
  });

  await t.test('a merge receipt of serving work that says nothing landed leaves it OPEN', async () => {
    const world = await reopenedProject('a failed merge');
    await receipt(world.plain.run, { result: 'CONFLICT', conflicts: ['src/a.ts'] });
    assert.deepEqual(await stored(world.projectId), OPEN, 'a conflict is not a landing');
    await receipt(world.plain.run, { targetBranch: 'some/other-branch' });
    assert.deepEqual(await stored(world.projectId), OPEN, 'nor is a merge into a branch this project does not land on');
  });

  await t.test('evidence and a verdict about work that serves no criterion leave it OPEN', async () => {
    const world = await reopenedProject('a judgment');
    // It serves no criterion of the project, so its evidence is measured against a standard of its own.
    const added = await otherWork(world, 'work that is judged', {
      completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: OWN_STANDARD,
    });
    const run = await worktreeRun(added.id);
    const revision = await submitEvidence(added.id, run, { key: 'task', text: OWN_STANDARD }, 1);
    assert.deepEqual(await stored(world.projectId), OPEN, 'a revision stored DONE over the press');
    await decide(added.id, revision, 'CONFIRM');
    assert.deepEqual(await stored(world.projectId), OPEN, 'a decision stored DONE over the press');

    const check = await tasks.create(ownerId, {
      title: 'a check of that work',
      projectId: world.projectId,
      verifiesTaskId: added.id,
      codeless: true,
      codelessReason: 'a check reads the work and commits nothing',
    } as never);
    await tasks.update(ownerId, check.id, { verdict: 'PASS' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'a verdict stored DONE over the press');
  });

  await t.test('the owner confirming the same criteria again leaves it OPEN', async () => {
    const world = await reopenedProject('a confirmation');
    await acceptance.confirmStandardSet(ownerId, world.projectId, {
      criteriaDigest: await currentSeal(world.projectId),
    });
    assert.deepEqual(await stored(world.projectId), OPEN, 'a confirmation is not a record of DONE');
  });

  await t.test('a check filed on serving work and cancelled having concluded nothing leaves it OPEN', async () => {
    const world = await reopenedProject('a check that said nothing');
    const check = await tasks.create(ownerId, {
      title: 'a check nobody ran',
      projectId: world.projectId,
      verifiesTaskId: world.plain.id,
      codeless: true,
      codelessReason: 'a check reads the work and commits nothing',
    } as never);
    assert.equal(await factsProve(world.projectId), false, 'a check not yet concluded holds the work');
    assert.deepEqual(await stored(world.projectId), OPEN);

    await tasks.update(ownerId, check.id, { status: 'CANCELLED', terminalReason: 'ABANDONED' } as never);
    assert.equal(await factsProve(world.projectId), true, 'and a cancelled one holds nothing');
    assert.deepEqual(await stored(world.projectId), OPEN, 'no verdict was reached, so no fact moved');
  });

  await t.test('a task pointed at a criterion and moved off again leaves it OPEN', async () => {
    const world = await reopenedProject('a task pointed and moved');
    const added = await otherWork(world, 'work pointed at the wrong criterion', { criterionKey: world.firstKey });
    assert.equal(await factsProve(world.projectId), false, 'it holds the criterion while it serves it');
    await tasks.update(ownerId, added.id, { criterionKey: null } as never);
    assert.equal(await factsProve(world.projectId), true);
    assert.deepEqual(await stored(world.projectId), OPEN, 'what serves the criteria is what it was');
  });

  await t.test('a finished task from before the press, pointed at a criterion, leaves it OPEN', async () => {
    const world = await settledProject('a finished task pointed');
    const added = await otherWork(world, 'work finished before the press', {
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    });
    await settleExecutable(added.id);
    await receipt(await worktreeRun(added.id));
    await pressReopen(world.projectId);

    await tasks.update(ownerId, added.id, { criterionKey: world.firstKey } as never);
    assert.equal(await factsProve(world.projectId), true, 'it is finished and landed, so the facts still prove DONE');
    assert.deepEqual(await stored(world.projectId), OPEN,
      'editing a task that served no criterion stored DONE over the press');
    assert.equal(await pressOnRecord(world.projectId), true);
  });

  await t.test('serving work moved off a criterion, or deleted, leaves it OPEN', async () => {
    const world = await settledProject('serving work moved off');
    const more = async (title: string) => {
      const task = await otherWork(world, title, {
        criterionKey: world.firstKey,
        completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
      });
      await settleExecutable(task.id);
      await receipt(await worktreeRun(task.id));
      return task.id as string;
    };
    const movedOff = await more('more work under the first criterion');
    const deleted = await more('and more');
    assert.deepEqual(await stored(world.projectId), DERIVED, 'all of it is finished and landed');
    await pressReopen(world.projectId);

    await tasks.update(ownerId, movedOff, { criterionKey: null } as never);
    assert.equal(await factsProve(world.projectId), true, 'the plain work still serves it');
    assert.deepEqual(await stored(world.projectId), OPEN, 'moving a task off stored DONE over the press');

    await tasks.remove(ownerId, deleted);
    await tasks.update(ownerId, world.plain.id, { title: 'the plain work, after the delete' } as never);
    assert.equal(await factsProve(world.projectId), true);
    assert.deepEqual(await stored(world.projectId), OPEN, 'deleting a task stored DONE over the press');
  });

  await t.test('the work a serving check is pointed at serves nothing itself, so it moving leaves it OPEN', async () => {
    const world = await settledProject('a check’s subject');
    const subject = await otherWork(world, 'work only a check serves through', {
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    });
    await settleExecutable(subject.id);
    const check = await otherWork(world, 'the check serving the first criterion', {
      criterionKey: world.firstKey,
      verifiesTaskId: subject.id,
      codeless: true,
      codelessReason: 'a check reads the work and commits nothing',
    });
    await tasks.update(ownerId, check.id, { verdict: 'PASS' } as never);
    assert.deepEqual(await stored(world.projectId), DERIVED);
    await pressReopen(world.projectId);

    await tasks.update(ownerId, subject.id, { status: 'OPEN' } as never);
    assert.equal(await factsProve(world.projectId), false, 'the check counts only while its subject is DONE');
    await settleExecutable(subject.id);
    await tasks.update(ownerId, subject.id, { title: 'work only a check serves through, again' } as never);
    assert.equal(await factsProve(world.projectId), true);
    assert.deepEqual(await stored(world.projectId), OPEN, 'it serves no criterion, so it moved no fact');
  });

  await t.test('reads do not move it, and the facts go on being read as the facts', async () => {
    const world = await reopenedProject('reads');
    const read = await projects.get(ownerId, world.projectId) as unknown as {
      status: string;
      derivedDone: { status: string; done: boolean; withheld: string[] };
    };
    assert.equal(read.status, ProjectStatus.OPEN, 'the column is the owner’s decision');
    assert.deepEqual(
      [read.derivedDone.status, read.derivedDone.done, read.derivedDone.withheld],
      [ProjectStatus.DONE, true, []],
      'derivedDone says what the facts say, and the press does not change that',
    );
    assert.deepEqual(await stored(world.projectId), OPEN);
  });

  // ═══ the coordinator can work: what the owner reopened it for ════════════════════════════════

  await t.test('the coordinator files a task serving no criterion, and goes on writing tasks', async () => {
    const world = await reopenedProject('the coordinator');
    const creator = { type: CreatorType.AGENT, id: workspaceId };

    const filed = await tasks.create(ownerId, {
      title: 'the new work', projectId: world.projectId,
    } as never, creator, world.coordinator);
    assert.deepEqual(await stored(world.projectId), OPEN);

    await tasks.update(ownerId, filed.id, { title: 'the new work, edited' } as never, world.coordinator);
    assert.deepEqual(await stored(world.projectId), OPEN, 'R8 would refuse the next one if this were DONE');

    const another = await tasks.create(ownerId, {
      title: 'more new work', projectId: world.projectId,
    } as never, creator, world.coordinator);
    await tasks.update(ownerId, another.id, { priority: 1 } as never, world.coordinator);
    assert.deepEqual(await stored(world.projectId), OPEN);
  });

  // ═══ a fact about serving work changes: the projection answers ═══════════════════════════════

  await t.test('status: reopened serving work keeps it OPEN, and finishing it stores DERIVED DONE', async () => {
    const world = await reopenedProject('a status');
    await tasks.update(ownerId, world.plain.id, { status: 'OPEN' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'the facts do not prove DONE');

    await settleExecutable(world.plain.id);
    assert.equal(await factsProve(world.projectId), true);
    await tasks.update(ownerId, world.plain.id, { title: 'the plain work, again' } as never);
    assert.deepEqual(await stored(world.projectId), DERIVED,
      'DONE again is not the DONE it was pressed over: a reopened task is a new epoch of its work');
    assert.equal(await pressOnRecord(world.projectId), false, 'and the press has ended');
  });

  await t.test('evidence: a new revision keeps it OPEN, and its CONFIRM stores DERIVED DONE', async () => {
    const world = await reopenedProject('a revision');
    const revision = await aNewRevision(world);
    assert.deepEqual(await stored(world.projectId), OPEN, 'the newest revision is not confirmed');
    await decide(world.judged.id, revision, 'SEND_BACK');
    assert.deepEqual(await stored(world.projectId), OPEN, 'a send-back settles nothing');

    await decide(world.judged.id, await aNewRevision(world), 'CONFIRM');
    assert.deepEqual(await stored(world.projectId), DERIVED);
  });

  await t.test('a decision alone: a CONFIRM of a revision the press was made over stores DERIVED DONE', async () => {
    const world = await settledProject('a decision');
    // The newest revision is undecided, so the projection takes DONE back. The owner records it done
    // over that, then reopens it: the press is made over facts in which nobody has decided it.
    const revision = await aNewRevision(world);
    assert.deepEqual(await stored(world.projectId), OPEN);
    await recordDone(world.projectId);
    assert.deepEqual(await stored(world.projectId), BY_OWNER);
    await pressReopen(world.projectId);
    assert.deepEqual(await stored(world.projectId), OPEN);

    await decide(world.judged.id, revision, 'CONFIRM');
    assert.equal(await factsProve(world.projectId), true);
    assert.deepEqual(await stored(world.projectId), DERIVED, 'only the decision moved');
  });

  await t.test('a verdict: a FAIL keeps it OPEN, and a PASS stores DERIVED DONE', async () => {
    const world = await reopenedProject('a verdict');
    const check = await tasks.create(ownerId, {
      title: 'the check of the plain work',
      projectId: world.projectId,
      verifiesTaskId: world.plain.id,
      codeless: true,
      codelessReason: 'a check reads the work and commits nothing',
    } as never);
    await tasks.update(ownerId, check.id, { verdict: 'FAIL' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'the check said no');

    await tasks.update(ownerId, check.id, { verdict: 'PASS' } as never);
    assert.deepEqual(await stored(world.projectId), DERIVED);
  });

  await t.test('a task filed under a criterion after the press keeps it OPEN, and finishing it stores DERIVED DONE', async () => {
    const world = await reopenedProject('a new serving task');
    const added = await otherWork(world, 'new work under the first criterion', {
      criterionKey: world.firstKey,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
      codeless: true,
      codelessReason: 'nothing to land, so its status is the only fact it has',
    });
    await tasks.update(ownerId, added.id, { title: 'new work under the first criterion, filed' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'it holds the criterion until it is finished');

    await settleExecutable(added.id);
    await tasks.update(ownerId, added.id, { title: 'new work under the first criterion, finished' } as never);
    assert.deepEqual(await stored(world.projectId), DERIVED, 'its status changed after the press');
  });

  await t.test('a task from before the press, pointed at a criterion: a landing after the press stores DERIVED DONE', async () => {
    const world = await settledProject('a task pointed, then landed');
    const added = await otherWork(world, 'work from before the press', {
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    });
    await pressReopen(world.projectId);

    await tasks.update(ownerId, added.id, { criterionKey: world.firstKey } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'it holds the criterion until it is finished');
    await settleExecutable(added.id);
    await receipt(await worktreeRun(added.id));
    assert.deepEqual(await stored(world.projectId), DERIVED, 'a new landing of serving work is a fact');
  });

  await t.test('a merge receipt of serving work that landed stores DERIVED DONE when the facts prove it', async () => {
    const world = await reopenedProject('a landing');
    await receipt(world.plain.run);
    assert.deepEqual(await stored(world.projectId), DERIVED, 'a new landing is a fact, and the facts prove DONE');
  });

  await t.test('a merge receipt of serving work keeps it OPEN while the facts do not prove DONE', async () => {
    // Only the first criterion's work has landed. The owner records it done over that, then reopens it.
    const world = await unsettledProject('a landing that is not the last');
    await receipt(world.plain.run);
    await acceptance.confirmStandardSet(ownerId, world.projectId, {
      criteriaDigest: await currentSeal(world.projectId),
    });
    assert.deepEqual(await stored(world.projectId), OPEN, 'the second criterion has not landed');
    await recordDone(world.projectId);
    await pressReopen(world.projectId);
    assert.deepEqual(await stored(world.projectId), OPEN);

    await receipt(world.plain.run);
    assert.equal(await factsProve(world.projectId), false);
    assert.deepEqual(await stored(world.projectId), OPEN, 'the fact moved and the facts still do not prove it');

    await receipt(world.judged.run);
    assert.equal(await factsProve(world.projectId), true);
    assert.deepEqual(await stored(world.projectId), DERIVED, 'the last landing proves it');
  });

  // ═══ the seal moves ══════════════════════════════════════════════════════════════════════════

  await t.test('the seal: an edit keeps it OPEN, and the facts proving the new set store DERIVED DONE', async () => {
    const world = await reopenedProject('a new seal');
    await projects.update(ownerId, world.projectId, {
      acceptanceCriteriaItems: [
        { id: world.firstDefinitionId, text: FIRST, verificationMethod: STRICTER },
        { id: world.secondDefinitionId, text: SECOND, verificationMethod: METHOD },
      ],
    } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'nobody has confirmed the new set');
    assert.ok(
      (await readDerivedProjectDone(db, ownerId, world.projectId)).withheld.includes('STANDARD_SET_UNCONFIRMED'),
    );

    await tasks.update(ownerId, world.plain.id, { criterionKey: world.firstKey } as never);
    assert.deepEqual(await stored(world.projectId), OPEN);
    await acceptance.confirmStandardSet(ownerId, world.projectId, {
      criteriaDigest: await currentSeal(world.projectId),
    });
    assert.deepEqual(await stored(world.projectId), DERIVED);
  });

  // ═══ the owner records it done again ═════════════════════════════════════════════════════════

  await t.test('the owner recording it done ends the press, and the OWNER rule is what it was', async () => {
    const world = await reopenedProject('recorded again');
    await recordDone(world.projectId);
    assert.deepEqual(await stored(world.projectId), BY_OWNER);
    assert.equal(await pressOnRecord(world.projectId), false, 'the record replaces the press');

    await tasks.update(ownerId, world.plain.id, { title: 'the plain work, renamed' } as never);
    await receipt(world.plain.run);
    assert.deepEqual(await stored(world.projectId), BY_OWNER, 'an ordinary write leaves an owner’s record');

    // What takes an owner's record away is what always did, and no press is left to hold it after.
    await tasks.update(ownerId, world.plain.id, { status: 'OPEN' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN);
    await settleExecutable(world.plain.id);
    await tasks.update(ownerId, world.plain.id, { title: 'the plain work, finished' } as never);
    assert.deepEqual(await stored(world.projectId), DERIVED, 'nothing holds DONE back any more');
  });

  await t.test('a second round: the owner reopens and records as often as they press', async () => {
    const world = await reopenedProject('rounds');
    await recordDone(world.projectId);
    await pressReopen(world.projectId);
    assert.deepEqual(await stored(world.projectId), OPEN);
    assert.equal(await pressOnRecord(world.projectId), true);
    await tasks.update(ownerId, world.plain.id, { title: 'the plain work, second round' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'the second press holds as the first did');
  });

  await t.test('a press over a record the facts do not prove holds when a confirmation makes them prove it', async () => {
    // Everything is finished and landed, and nobody has confirmed: the owner records it done over that.
    const world = await unsettledProject('an unproven record');
    await receipt(world.plain.run);
    await receipt(world.judged.run);
    await recordDone(world.projectId);
    assert.deepEqual(await stored(world.projectId), BY_OWNER);
    await pressReopen(world.projectId);
    assert.equal(await pressOnRecord(world.projectId), true);

    await acceptance.confirmStandardSet(ownerId, world.projectId, {
      criteriaDigest: await currentSeal(world.projectId),
    });
    assert.equal(await factsProve(world.projectId), true, 'the confirmation was all that was missing');
    assert.deepEqual(await stored(world.projectId), OPEN, 'and it is not a record of DONE');
  });

  // ═══ which write is the press ════════════════════════════════════════════════════════════════

  await t.test('from a session it is refused whole, and writes nothing', async () => {
    const world = await settledProject('a session asks');
    const before = await row(world.projectId);
    await assert.rejects(
      projects.update(ownerId, world.projectId, { status: ProjectStatus.OPEN } as never, world.coordinator),
      (error: { response?: { code?: string } }) => error.response?.code === 'PROJECT_STATUS_NOT_SESSION_WRITABLE',
    );
    assert.deepEqual(await row(world.projectId), before);
  });

  await t.test('from a token it is refused whole, and writes nothing', async () => {
    const world = await settledProject('a token asks');
    const before = await row(world.projectId);
    await assert.rejects(projects.update(
      ownerId, world.projectId, { status: ProjectStatus.OPEN } as never, undefined,
      { kind: 'PAT', tokenId: randomUUID(), scopes: [], workspaceIds: [] } as never,
    ));
    assert.deepEqual(await row(world.projectId), before);
  });

  await t.test('the runner credential with no session header writes the column, and that is no press', async () => {
    const world = await settledProject('a headless call');
    await door.updateProject(runner, world.projectId, undefined, { status: ProjectStatus.OPEN } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'the door still writes it, as the matrix says');
    assert.equal(await pressOnRecord(world.projectId), false);

    await tasks.update(ownerId, world.plain.id, { title: 'the plain work, renamed' } as never);
    assert.deepEqual(await stored(world.projectId), DERIVED,
      'and the projection answers it, because the owner decided nothing');
  });

  await t.test('OPEN on a project already OPEN is no press, and leaves one standing as it was', async () => {
    const world = await unsettledProject('nothing to reopen');
    await pressReopen(world.projectId);
    assert.deepEqual(await stored(world.projectId), OPEN);
    assert.equal(await pressOnRecord(world.projectId), false, 'nothing was reopened');
    await receipt(world.plain.run);
    await receipt(world.judged.run);
    await acceptance.confirmStandardSet(ownerId, world.projectId, {
      criteriaDigest: await currentSeal(world.projectId),
    });
    assert.deepEqual(await stored(world.projectId), DERIVED, 'so the projection is held by nothing');

    await pressReopen(world.projectId);
    const pressed = await row(world.projectId);
    await pressReopen(world.projectId);
    assert.deepEqual(await row(world.projectId), { ...pressed, updated_at: (await row(world.projectId)).updated_at },
      'a second OPEN moved the press');
  });

  await t.test('reopening a cancelled project is the press too', async () => {
    const world = await settledProject('cancelled and reopened');
    const cancelled = await owner('PATCH', uuidToBase62(world.projectId), { status: 'CANCELLED' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal((await row(world.projectId)).status, ProjectStatus.CANCELLED);
    await pressReopen(world.projectId);
    await tasks.update(ownerId, world.plain.id, { title: 'the plain work, back' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN);
  });

  await t.test('a status written over a press ends it', async () => {
    const world = await reopenedProject('written over');
    const cancelled = await owner('PATCH', uuidToBase62(world.projectId), { status: 'CANCELLED' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(await pressOnRecord(world.projectId), false);
  });

  await t.test('a press committed between the projection’s read and its write is not projected over', async () => {
    // Facts that prove DONE with the column OPEN and no press: the position a projection is about to
    // write DONE from. Another edge writes that DONE, and the owner presses Reopen over it, before this
    // projection's statement reaches the row. Status and record read the same as when it read them.
    const world = await settledProject('a race');
    await door.updateProject(runner, world.projectId, undefined, { status: ProjectStatus.OPEN } as never);
    assert.deepEqual(await stored(world.projectId), OPEN);

    const interleaved = new Proxy(prisma, {
      get(target, key, receiver) {
        if (key !== 'project') return Reflect.get(target, key, receiver);
        return new Proxy(target.project, {
          get(delegate, method, inner) {
            if (method !== 'updateMany') return Reflect.get(delegate, method, inner);
            return async (args: never) => {
              await storeDerivedProjectStatus(db, ownerId, world.projectId);
              assert.deepEqual(await stored(world.projectId), DERIVED);
              await pressReopen(world.projectId);
              return target.project.updateMany(args);
            };
          },
        });
      },
    }) as unknown as PrismaService;

    await storeDerivedProjectStatus(interleaved, ownerId, world.projectId);
    assert.deepEqual(await stored(world.projectId), OPEN, 'the projection wrote DONE over the press');
    assert.equal(await pressOnRecord(world.projectId), true);
  });

  await t.test('the database will not hold half a press', async () => {
    const world = await reopenedProject('half a press');
    await assert.rejects(
      sql.query(`UPDATE "project" SET "reopened_at" = NULL WHERE "id" = $1::uuid`, [world.projectId]),
      (error: { constraint?: string }) => error.constraint === 'project_reopened_record_chk',
    );
    await assert.rejects(
      sql.query(`UPDATE "project" SET "reopened_facts" = NULL WHERE "id" = $1::uuid`, [world.projectId]),
      (error: { constraint?: string }) => error.constraint === 'project_reopened_record_chk',
    );
    await assert.rejects(
      sql.query(`UPDATE "project" SET "reopened_facts" = '[]'::jsonb WHERE "id" = $1::uuid`, [world.projectId]),
      (error: { constraint?: string }) => error.constraint === 'project_reopened_facts_chk',
    );
  });

  // ═══ who reads what, while the press stands ══════════════════════════════════════════════════

  await t.test('the coordinator asks with project_request_done, and the owner’s answer records it', async () => {
    const world = await reopenedProject('the request');
    const added = await otherWork(world, 'the work the owner reopened it for', {
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    });
    await settleExecutable(added.id);
    await tasks.update(ownerId, added.id, { title: 'the work the owner reopened it for, finished' } as never);
    assert.deepEqual(await stored(world.projectId), OPEN, 'a DONE here would leave nothing to ask');

    const filed = await door.requestDone(runner, world.coordinator, world.projectId, {
      judgment: 'The new work is finished and every criterion still holds.',
      gaps: [],
    } as never) as unknown as { itemId: string; state: string };
    assert.equal(filed.state, 'OPEN', 'the closing check passes on the facts');
    assert.deepEqual(await stored(world.projectId), OPEN, 'asking records nothing');

    const { rows: [before] } = await sql.query<{ state: string }>(
      `SELECT "state" FROM "project_open_item" WHERE "id" = $1::uuid`, [filed.itemId],
    );
    assert.equal(before!.state, 'OPEN');

    await recordDone(world.projectId, filed.itemId);
    assert.deepEqual(await stored(world.projectId), BY_OWNER);
    assert.equal(await pressOnRecord(world.projectId), false);
    const { rows: [answered] } = await sql.query<{ state: string; resolution: string }>(
      `SELECT "state", "resolution" FROM "project_open_item" WHERE "id" = $1::uuid`, [filed.itemId],
    );
    assert.deepEqual(answered, { state: 'RESOLVED', resolution: 'APPROVED' });
  });

  await t.test('the closing guardrail says not finished, and the owner is not asked by itself', async () => {
    const world = await reopenedProject('the guardrail');
    const finish = await readProjectFinish(db as never, world.projectId);
    assert.equal(finish.state, 'NOT_FINISHED');

    // Even with the coordinator told, the window run out and nobody asking: it is the owner's press.
    await sql.query(
      `INSERT INTO "project_coordinator_wake"
         ("id", "project_id", "event", "subject_type", "subject_id", "subject_version", "idempotency_key",
          "status", "session_id", "updated_at")
       VALUES ($1::uuid, $2::uuid, 'PROJECT_TASKS_SETTLED', 'PROJECT', $2::text, 'v', $3, 'DELIVERED', $4::uuid,
               now() - interval '1 day')`,
      [randomUUID(), world.projectId, `reopen-${world.projectId}`, world.coordinator],
    );
    const due = await projectsToRecordAsDone(db as never, ownerId, [world.projectId], new Date());
    assert.equal(due.size, 0);
  });

  /** The landed fact as the settled-project producer derives it, delivered through the real door. */
  async function deliverLanded(world: World): Promise<string> {
    const rows = await prisma.task.findMany({
      where: { projectId: world.projectId },
      select: { id: true, status: true, criterionDefinitionId: true, title: true },
    });
    const criterion = (key: string, text: string, definitionId: string) => ({
      key,
      text,
      satisfied: true,
      landing: 'LANDED' as const,
      serving: rows
        .filter((row) => row.criterionDefinitionId === definitionId)
        .map((row) => ({ taskId: row.id, title: row.title, status: row.status })),
    });
    const fact = projectAcceptanceLandedFact(
      world.projectId,
      rows.map((row) => ({ taskId: row.id, status: row.status })),
      [
        criterion(world.firstKey, FIRST, world.firstDefinitionId),
        criterion(world.secondKey, SECOND, world.secondDefinitionId),
      ],
    );
    assert.ok(fact, 'every task is terminal and every criterion is on main');
    // `queue`, because the fixture's conversation has a turn of its own waiting. What is under test is
    // the words: this door and `deliver` write the same ones.
    const outcome = await deliveries.queue(fact, async () => ({ allowed: true }));
    assert.notEqual(outcome.outcome, 'REFUSED', JSON.stringify(outcome));
    const { rows: [turn] } = await sql.query<{ content: string }>(
      `SELECT "content" FROM "conversation_turn" WHERE "session_id" = $1::uuid ORDER BY "seq" DESC LIMIT 1`,
      [world.coordinator],
    );
    return turn!.content;
  }

  await t.test('the coordinator is told the owner reopened it, and not that it is recorded DONE', async () => {
    const world = await reopenedProject('the message');
    const words = await deliverLanded(world);
    assert.match(words, /the account owner reopened it, so it stays open/u);
    assert.match(words, /project_request_done/u);
    assert.doesNotMatch(words, /recorded as DONE/iu);
  });

  await t.test('asked to get a confirmation, the coordinator is told that alone will not close it', async () => {
    const world = await unsettledProject('the message, unconfirmed');
    await receipt(world.plain.run);
    await receipt(world.judged.run);
    await recordDone(world.projectId);
    await pressReopen(world.projectId);

    const words = await deliverLanded(world);
    assert.match(words, /please confirm they express the goal you want/u, 'the reading is still the confirmation’s');
    assert.match(words, /A confirmation alone does not end that/u);
    assert.match(words, /project_request_done/u);
  });

  await t.test('with the press ended, the same fact is told as it always was', async () => {
    // The owner's press, then a landing: the facts have moved, so the projection is free to store DONE.
    // The message is written on the edge before it does, and must not call that a press still standing.
    const world = await reopenedProject('the message, press ended');
    await sql.query(
      `INSERT INTO "session_merge_receipt"
         ("id", "owner_id", "session_id", "task_id", "project_id", "result", "source_branch", "source_sha",
          "target_branch", "target_sha_before", "target_sha_after", "recorded_by", "idempotency_key")
       VALUES ($8::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MERGED', 'orbit/raw', $5, 'main', $6, $7, 'AGENT', 'raw')`,
      [ownerId, world.plain.run, world.plain.id, world.projectId, 'c'.repeat(40), 'a'.repeat(40), 'b'.repeat(40), randomUUID()],
    );
    assert.deepEqual(await stored(world.projectId), OPEN, 'no edge has run on this row');
    assert.match(await deliverLanded(world), /recorded as DONE/iu);
  });
});

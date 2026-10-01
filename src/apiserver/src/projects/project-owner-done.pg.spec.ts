/**
 * The owner's DONE (`POST /projects/:id/done`), and the projection that no longer overrules it.
 *
 * WHAT IS UNDER TEST
 * ------------------
 * A project the facts cannot prove done — here, a criterion whose work is a rollout with nothing to
 * land — is recorded done by its owner in person, once, with the gap they accepted. The door is
 * refused whole from a session, and a press made against a seal or a request that has moved is a 409
 * that writes nothing. What the record buys is `storeDerivedProjectStatus`'s rule: a task write, a
 * merge receipt or a confirmation leaves it alone, and only the criteria changing or a task serving
 * one being reopened takes it away — with the coordinator told why. A DONE the projection derives by
 * itself is recorded DERIVED, and is still a reading the next fact can take back.
 *
 * WHY IT IS A `.pg.spec`
 * ----------------------
 * The claims are about rows. Every press goes over HTTP through the production controller, so the
 * 403 is the header rule and not a service argument, and "zero writes" is the project row, the
 * project's open items and the coordinator conversation read back with SQL either side of a refusal.
 * Every later fact is produced the way the product produces it — criteria through
 * `ProjectsService.update`, tasks through `TasksService`, receipts through `MergeReceiptService`, the
 * confirmation through `ProjectAcceptanceService` — and the projection is never called directly: it
 * runs on those writers' own post-commit edges. The coordinator is told through a real
 * `SessionsService`, so what it was told is the `conversation_turn` it will read.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-owner-done.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  Prisma,
  ProjectStatus,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  type PrismaClient,
} from '@prisma/client';
import { type AcceptedGap, type DoneRequest, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import type { CompletionInputRouter } from './completion-input-router.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { classifyCriteriaEdit } from './criteria-edit-classification';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { readDerivedProjectDone } from './project-done-derived';
import {
  DONE_REQUEST_DEDUPE_KEY,
  DONE_REQUEST_KIND,
  DONE_REQUEST_TITLE,
} from './project-done-request';
import { ProjectFuseService } from './project-fuse.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/**
 * The HUMAN → VERIFICATION → EXECUTABLE ladder. A criteria edit takes effect only when it walks a
 * criterion UP it (a rewording is held as a proposal, and moves nothing), so both edits below are a
 * step up, and each is asserted to be one before it is made.
 */
const METHOD = 'HUMAN';
const STRICTER = 'VERIFICATION';

const BUILT = 'the closing door is built and its specs pass';
const ROLLED_OUT = 'the closing door is rolled out to production';

/** A full 40-hex object name, which is the only kind a receipt accepts. */
const sha = (nibble: string) => nibble.repeat(40);

/** The one turn prefix an owner's reopened record is told under (`projectReopenedTurnId`). */
const REOPENED_TURN = 'project-started:v1:reopened:';

interface StoredRecord {
  status: string;
  done_by: string | null;
  done_at: Date | null;
  done_criteria_digest: string | null;
  accepted_gaps: unknown;
}

test('the owner records a project done in person, and the projection keeps that record', {
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

  // ── the writers, wired the way the product wires them ─────────────────────────────────────────

  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma as unknown as PrismaService, queue, realtime);
  const acceptance = new ProjectAcceptanceService(prisma as unknown as PrismaService, sessions);
  const projects = new ProjectsService(prisma as unknown as PrismaService, acceptance, sessions);
  /** The router every post-commit edge is held behind. What a settled project WAKES is another
   *  unit's question, so its doors answer with nothing; what matters here is that the edges run. */
  const completionInputs = {
    routeSettledUnmerged: async () => [],
    routeSettledProjects: async () => [],
    routeReadyCriteria: async () => [],
    routeUnlandedCriteria: async () => [],
    routeReadyDependents: async () => [],
    routeTaskExceptions: async () => [],
  } as unknown as CompletionInputRouter;
  const receipts = new MergeReceiptService(prisma as unknown as PrismaService, completionInputs);
  const tasks = new TasksService(
    prisma as never,
    sessions,
    realtime as never,
    undefined,
    completionInputs,
  );

  // ── an owner, and a project coordinated from a conversation a turn can reach ──────────────────

  const ownerId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `owner-done-${ownerId}@project-done.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const projectId = randomUUID();
  await prisma.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'owner-done-runner',
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await prisma.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'owner-done-workspace', enabled: true },
  });
  await prisma.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: 'Coordinating the closing door',
      prompt: 'Coordinate the closing door',
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  await prisma.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: 'Coordinate the closing door',
      status: 'ANSWERED',
    },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      ownerId,
      title: 'The closing door',
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await prisma.projectRuntime.upsert({
    where: { projectId }, create: { projectId }, update: {},
  });

  // ── the production controller over HTTP: the door a person's press reaches ────────────────────

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
  class OwnerDoneModule {}
  const app = await NestFactory.create(OwnerDoneModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  /** One press of Record as done, as the card sends it. */
  async function press(
    id: string,
    body: { requestId?: string; criteriaDigest: string; acceptedGaps: AcceptedGap[] },
    actingSessionId?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}/api/projects/${uuidToBase62(id)}/done`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer owner',
        'content-type': 'application/json',
        ...(actingSessionId ? { 'x-orbit-session-id': uuidToBase62(actingSessionId) } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  // ── the fixture's own vocabulary ───────────────────────────────────────────────────────────────

  /** The DONE record, off the row. */
  async function record(id = projectId): Promise<StoredRecord> {
    const { rows } = await sql.query<StoredRecord>(
      `SELECT "status"::text AS "status", "done_by", "done_at", "done_criteria_digest",
              "accepted_gaps"
         FROM "project" WHERE "id" = $1::uuid`,
      [id],
    );
    assert.equal(rows.length, 1, 'the project must still exist');
    return rows[0]!;
  }

  /**
   * Everything a press could have written, and what it could have told: the whole project row, every
   * open item of the project, and every turn on its coordinator conversation. Equal either side of a
   * refusal is what "nothing was written" means.
   */
  async function everything(): Promise<unknown> {
    const { rows: [project] } = await sql.query(
      `SELECT row_to_json(p) AS "row" FROM "project" p WHERE p."id" = $1::uuid`, [projectId],
    );
    const { rows: [items] } = await sql.query(
      `SELECT coalesce(json_agg(i ORDER BY i."id"), '[]'::json) AS "rows"
         FROM "project_open_item" i WHERE i."project_id" = $1::uuid`,
      [projectId],
    );
    const { rows: [turns] } = await sql.query(
      `SELECT count(*)::int AS "count" FROM "conversation_turn" WHERE "session_id" = $1::uuid`,
      [coordinatorSessionId],
    );
    return { project, items, turns };
  }

  /** What the coordinator conversation was told about a reopened record, in order. */
  async function reopenedTurns(): Promise<Array<{ client_turn_id: string; content: string }>> {
    const { rows } = await sql.query<{ client_turn_id: string; content: string }>(
      `SELECT "client_turn_id", "content" FROM "conversation_turn"
        WHERE "session_id" = $1::uuid AND starts_with("client_turn_id", $2)
        ORDER BY "seq"`,
      [coordinatorSessionId, REOPENED_TURN],
    );
    return rows;
  }

  async function seal(id = projectId): Promise<string> {
    return (await acceptance.standardSetConfirmation(ownerId, id)).currentVersion.digest;
  }

  /** A coordinator's request that the owner record it done — the payload task ② files. */
  async function fileDoneRequest(criteriaDigest: string): Promise<string> {
    const id = randomUUID();
    const request: DoneRequest = {
      criteriaDigest,
      judgment: 'Everything Orbit can prove is done; the rollout is the one gap, and it is live.',
      gaps,
    };
    await prisma.projectOpenItem.create({
      data: {
        id,
        projectId,
        ownerId,
        kind: DONE_REQUEST_KIND,
        state: 'OPEN',
        assignee: 'OWNER',
        assigneeReason: 'DEFAULT',
        dedupeKey: DONE_REQUEST_DEDUPE_KEY,
        title: DONE_REQUEST_TITLE,
        payload: request as unknown as Prisma.InputJsonValue,
        waitingSince: new Date(),
        assignedAt: new Date(),
      },
    });
    return id;
  }

  /** A request the platform has since ended — what a newer request, or work moving, does to one. */
  async function supersede(itemId: string) {
    await sql.query(
      `UPDATE "project_open_item"
          SET "state" = 'SUPERSEDED', "resolved_at" = CURRENT_TIMESTAMP, "resolved_by" = 'PLATFORM'
        WHERE "id" = $1::uuid`,
      [itemId],
    );
  }

  /** The worktree session a task's branch belongs to — what a receipt is recorded against. */
  async function sessionFor(taskId: string, branch: string) {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId,
        title: `ran ${branch}`,
        prompt: 'do the work',
        status: RunStatus.SUCCEEDED,
        branch,
        isolationStatus: 'worktree',
      },
    });
    return id;
  }

  /** One EXECUTABLE task filed against a criterion, through the task door. */
  async function servingTask(id: string, criterionKey: string, title: string) {
    const task = await tasks.create(ownerId, {
      title,
      projectId: id,
      criterionKey,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    return task.id as string;
  }

  /** Settle an EXECUTABLE task the way a turn's acceptance settles one: through 0193/0230's fence. */
  async function settle(taskId: string) {
    const written = await sql.query(
      `UPDATE "task" SET "status" = 'DONE'
        WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')
          AND "completion_criterion" = 'EXECUTABLE' AND "acceptance_command" = 'true'
          AND "acceptance_expected_exit_code" = 0`,
      [taskId],
    );
    assert.equal(written.rowCount, 1, 'the task must reach DONE through the DONE fence');
  }

  async function landOnMain(sessionId: string, nibble: string) {
    return receipts.record(ownerId, sessionId, {
      result: 'MERGED',
      sourceSha: sha(nibble),
      targetBranch: 'main',
      targetShaBefore: sha('a'),
      targetShaAfter: sha('b'),
    }, 'AGENT');
  }

  // ── the starting position: one criterion built and landed, one that nothing can land ──────────

  const [built, rolledOut] = criteriaFromDefinitions(
    (await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: [BUILT, ROLLED_OUT].map((text) => ({ text, verificationMethod: METHOD })),
    } as never)).acceptanceCriteriaItems,
  );
  assert.ok(built && rolledOut, 'the fixture states two criteria');

  const buildWork = await servingTask(projectId, built.key, 'build the closing door');
  const buildSession = await sessionFor(buildWork, 'orbit/closing-door');
  const rolloutWork = await servingTask(projectId, rolledOut.key, 'roll the closing door out');
  await settle(buildWork);
  await landOnMain(buildSession, '1');
  // The owner starts the project by confirming its criteria, as the start card does.
  await acceptance.confirmStandardSet(ownerId, projectId, { criteriaDigest: await seal() });

  const gaps: AcceptedGap[] = [{
    criterionKey: rolledOut.key,
    whyNotProven: 'the rollout is a deploy with nothing to merge, so no receipt can land it',
    coordinatorChecked: 'the production bundle serves the new card',
    evidenceRefs: ['deploy:2026-10-01'],
  }];
  const firstSeal = await seal();
  const firstRequest = await fileDoneRequest(firstSeal);

  assert.equal((await record()).status, ProjectStatus.OPEN,
    'the control every case below needs: the facts alone do not settle this project');
  assert.ok((await readDerivedProjectDone(prisma as unknown as PrismaService, ownerId, projectId))
    .withheld.includes('CRITERION_UNSATISFIED'), 'and the rollout criterion is why');

  // ═══ refusals: every one before the first write ═══════════════════════════════════════════════

  await t.test('a press carrying an acting session is refused 403, and writes nothing', async () => {
    const before = await everything();
    const response = await press(projectId, {
      requestId: uuidToBase62(firstRequest),
      criteriaDigest: firstSeal,
      acceptedGaps: gaps,
    }, coordinatorSessionId);

    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'PROJECT_STATUS_NOT_SESSION_WRITABLE',
      'the rule every session-authored write of project.status meets, not a second spelling of it');
    assert.deepEqual(await everything(), before);
  });

  let currentSeal = firstSeal;

  await t.test('a seal that moved is 409, and writes nothing', async () => {
    // The criteria move: the rollout criterion steps up the ladder, which takes effect.
    assert.equal(classifyCriteriaEdit(
      [
        { id: built.definitionId, text: BUILT, verificationMethod: METHOD },
        { id: rolledOut.definitionId, text: ROLLED_OUT, verificationMethod: METHOD },
      ],
      [
        { id: built.definitionId, text: BUILT, verificationMethod: METHOD },
        { id: rolledOut.definitionId, text: ROLLED_OUT, verificationMethod: STRICTER },
      ],
    ), 'ADDITIVE');
    await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: [
        { id: built.definitionId, text: BUILT, verificationMethod: METHOD },
        { id: rolledOut.definitionId, text: ROLLED_OUT, verificationMethod: STRICTER },
      ],
    } as never);
    currentSeal = await seal();
    assert.notEqual(currentSeal, firstSeal, 'the edit moved the seal');

    const before = await everything();
    const response = await press(projectId, {
      requestId: uuidToBase62(firstRequest),
      criteriaDigest: firstSeal,
      acceptedGaps: gaps,
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'PROJECT_DONE_CRITERIA_VERSION_MOVED');
    assert.equal(response.body.currentDigest, currentSeal, 'and it says which seal stands now');
    assert.deepEqual(await everything(), before);
  });

  await t.test('a request made about another seal is 409, and writes nothing', async () => {
    // The owner read the criteria as they stand, but the coordinator's request is about the old set.
    const before = await everything();
    const response = await press(projectId, {
      requestId: uuidToBase62(firstRequest),
      criteriaDigest: currentSeal,
      acceptedGaps: gaps,
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'PROJECT_DONE_REQUEST_STALE');
    assert.deepEqual(await everything(), before);
  });

  await t.test('a request that is no longer open is 409, and writes nothing', async () => {
    // A request about the seal that stands, superseded since — what a newer request, or a task or a
    // landing moving under it, does to one.
    await supersede(firstRequest);
    const superseded = await fileDoneRequest(currentSeal);
    await supersede(superseded);

    const before = await everything();
    const response = await press(projectId, {
      requestId: uuidToBase62(superseded),
      criteriaDigest: currentSeal,
      acceptedGaps: gaps,
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'PROJECT_DONE_REQUEST_STALE');
    assert.deepEqual(await everything(), before);
  });

  // ═══ the record ════════════════════════════════════════════════════════════════════════════════

  let recorded: StoredRecord | null = null;

  await t.test('Record as done writes DONE, OWNER, the instant, the seal and the gaps, and answers the request', async () => {
    const request = await fileDoneRequest(currentSeal);
    const pressedAt = Date.now();
    const response = await press(projectId, {
      requestId: uuidToBase62(request),
      criteriaDigest: currentSeal,
      acceptedGaps: gaps,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.status, 'DONE');
    assert.equal(response.body.doneBy, 'OWNER');
    assert.equal(response.body.criteriaDigest, currentSeal);

    recorded = await record();
    assert.equal(recorded.status, ProjectStatus.DONE);
    assert.equal(recorded.done_by, 'OWNER');
    assert.ok(recorded.done_at && recorded.done_at.getTime() >= pressedAt - 1_000,
      'recorded when it was pressed');
    assert.equal(recorded.done_criteria_digest, currentSeal);
    assert.deepEqual(recorded.accepted_gaps, gaps, 'the gaps the owner accepted, as the card sent them');

    const { rows: [item] } = await sql.query(
      `SELECT "state", "resolution", "resolved_by", "resolved_by_user_id"::text, "resolved_at", "answer"
         FROM "project_open_item" WHERE "id" = $1::uuid`,
      [request],
    );
    assert.equal(item.state, 'RESOLVED');
    assert.equal(item.resolution, 'APPROVED');
    assert.equal(item.resolved_by, 'USER');
    assert.equal(item.resolved_by_user_id, ownerId);
    assert.equal(item.resolved_at.getTime(), recorded.done_at!.getTime(),
      'one write: the request is answered at the record’s own instant');
    assert.deepEqual(item.answer, gaps);

    assert.notEqual(
      (await readDerivedProjectDone(prisma as unknown as PrismaService, ownerId, projectId)).status,
      ProjectStatus.DONE,
      'the record is the owner’s, not a reading: the facts still say OPEN',
    );
  });

  // ═══ what does not take it away ════════════════════════════════════════════════════════════════

  await t.test('a task write, a new task, a merge receipt and a confirmation leave it DONE', async () => {
    assert.ok(recorded, 'the record above was written');

    await tasks.update(ownerId, rolloutWork, { title: 'roll the closing door out, again' } as never);
    assert.deepEqual(await record(), recorded, 'a task write took the owner’s record away');

    // Filing is not an edge of its own; the write after it is, as in project-done-derived (4).
    const more = await servingTask(projectId, built.key, 'more work on the closing door');
    await tasks.update(ownerId, more, { title: 'more work on the closing door, filed' } as never);
    assert.deepEqual(await record(), recorded, 'a newly filed task took the owner’s record away');

    const receipt = await landOnMain(buildSession, '3');
    assert.equal(receipt.created, true, 'the receipt is a new one, not a re-report');
    assert.deepEqual(await record(), recorded, 'a merge receipt took the owner’s record away');

    await acceptance.confirmStandardSet(ownerId, projectId, { criteriaDigest: currentSeal });
    assert.deepEqual(await record(), recorded, 'a confirmation took the owner’s record away');

    assert.deepEqual(await reopenedTurns(), [], 'and nobody was told it was reopened');
  });

  // ═══ what does ═════════════════════════════════════════════════════════════════════════════════

  await t.test('reopening a task that serves a criterion reopens the project, and tells the coordinator', async () => {
    await tasks.update(ownerId, buildWork, {
      status: 'OPEN', supersededByTaskId: null, terminalReason: null,
    } as never);

    assert.deepEqual(await record(), {
      status: ProjectStatus.OPEN,
      done_by: null,
      done_at: null,
      done_criteria_digest: null,
      accepted_gaps: [],
    }, 'the owner’s record goes with the DONE it recorded');

    const told = await reopenedTurns();
    assert.equal(told.length, 1, 'the coordinator is told once');
    assert.match(told[0]!.content, /^From Orbit · project reopened/u);
    assert.ok(told[0]!.content.includes('“build the closing door”'), 'naming the task');
    assert.ok(told[0]!.content.includes(uuidToBase62(buildWork)), 'by an id it can use');
    assert.match(told[0]!.content, /was reopened after the owner recorded it done/u);
  });

  await t.test('changing the criteria reopens the project, and tells the coordinator', async () => {
    // Recorded again by the owner unasked. The task reopened above was reopened BEFORE this record,
    // so a later edge does not hold it against this one.
    const response = await press(projectId, { criteriaDigest: currentSeal, acceptedGaps: gaps });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    await tasks.update(ownerId, rolloutWork, { title: 'roll the closing door out' } as never);
    assert.equal((await record()).done_by, 'OWNER',
      'a reopen from before the record took the new record away');

    assert.equal(classifyCriteriaEdit(
      [
        { id: built.definitionId, text: BUILT, verificationMethod: METHOD },
        { id: rolledOut.definitionId, text: ROLLED_OUT, verificationMethod: STRICTER },
      ],
      [
        { id: built.definitionId, text: BUILT, verificationMethod: STRICTER },
        { id: rolledOut.definitionId, text: ROLLED_OUT, verificationMethod: STRICTER },
      ],
    ), 'ADDITIVE');
    await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: [
        { id: built.definitionId, text: BUILT, verificationMethod: STRICTER },
        { id: rolledOut.definitionId, text: ROLLED_OUT, verificationMethod: STRICTER },
      ],
    } as never);
    currentSeal = await seal();

    assert.deepEqual(await record(), {
      status: ProjectStatus.OPEN,
      done_by: null,
      done_at: null,
      done_criteria_digest: null,
      accepted_gaps: [],
    }, 'the edit alone reopened it — no task write followed');

    const told = await reopenedTurns();
    assert.equal(told.length, 2, 'the coordinator is told once more');
    assert.match(told[1]!.content, /its acceptance criteria changed after the owner recorded it done/u);
  });

  await t.test('the owner reopening it by hand clears the record, and is not told back to anyone', async () => {
    const response = await press(projectId, { criteriaDigest: currentSeal, acceptedGaps: [] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal((await record()).done_by, 'OWNER');

    await projects.update(ownerId, projectId, { status: ProjectStatus.OPEN } as never);
    assert.deepEqual(await record(), {
      status: ProjectStatus.OPEN,
      done_by: null,
      done_at: null,
      done_criteria_digest: null,
      accepted_gaps: [],
    }, 'a project taken out of DONE carries no record of one');
    assert.equal((await reopenedTurns()).length, 2, 'the owner’s own press is not news to the coordinator');
  });

  // ═══ a DONE the facts prove by themselves ═════════════════════════════════════════════════════

  await t.test('a DONE the projection derives is recorded DERIVED, and the next fact can take it back', async () => {
    const derivedId = randomUUID();
    await prisma.project.create({
      data: { id: derivedId, ownerId, title: 'A project the facts settle' },
    });
    const [only] = criteriaFromDefinitions(
      (await projects.update(ownerId, derivedId, {
        acceptanceCriteriaItems: [{ text: BUILT, verificationMethod: METHOD }],
      } as never)).acceptanceCriteriaItems,
    );
    assert.ok(only, 'the second fixture states one criterion');
    const work = await servingTask(derivedId, only.key, 'build it');
    const workSession = await sessionFor(work, 'orbit/derived');
    await settle(work);
    await landOnMain(workSession, '4');
    const derivedSeal = await seal(derivedId);
    await acceptance.confirmStandardSet(ownerId, derivedId, { criteriaDigest: derivedSeal });

    const settled = await record(derivedId);
    assert.equal(settled.status, ProjectStatus.DONE, 'satisfied, landed and confirmed: DONE');
    assert.equal(settled.done_by, 'DERIVED', 'recorded by Orbit, not by the owner');
    assert.ok(settled.done_at, 'with the instant it was derived');
    assert.equal(settled.done_criteria_digest, derivedSeal);
    assert.deepEqual(settled.accepted_gaps, []);

    const more = await servingTask(derivedId, only.key, 'more of it');
    await tasks.update(ownerId, more, { title: 'more of it, filed' } as never);
    assert.deepEqual(await record(derivedId), {
      status: ProjectStatus.OPEN,
      done_by: null,
      done_at: null,
      done_criteria_digest: null,
      accepted_gaps: [],
    }, 'a DERIVED record is a reading, so new work against its criterion takes it back');
  });
});

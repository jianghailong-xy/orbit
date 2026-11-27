/**
 * AN AGENT ASKS TO REOPEN A SETTLED PROJECT (docs/project-reopen-request-design.md §4, §8).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-reopen-request.pg.spec.ts
 *
 * Each card is filed through the runner door `POST /runner/projects/:id/reopen-requests` (the production controller,
 * called in process with the runner and the X-Orbit-Session-Id it would carry) and answered through the owner's door
 * `POST /owner-requests/:id/reopen-project`: in process, and in case 5 over HTTP against the production apiserver
 * (`build/main.js`), where the guards that refuse a token and an acting session stand.
 *
 * THE CASES (design §8)
 * =========
 *   (1) filing on a DONE and on a CANCELLED project files one PENDING card with the server's title and payload; filing
 *       on an OPEN project is 409 PROJECT_ALREADY_OPEN with nothing filed; a filing without its text or its session is
 *       refused;
 *   (2) a second session asking gets the same card with `alreadyOpen: true` and both are its askers; both get its
 *       ending; a joined asker that withdraws leaves the card waiting for the rest;
 *   (3) a re-file after a decline is 409 REOPEN_REQUEST_DECLINED with the decline's date and reason; once the project is
 *       reopened and settled again, the same session may ask again;
 *   (4) the answer writes OPEN with `reopened_at`/`reopened_facts` equal to what the project page's press records,
 *       settles every pending card DONE, and tells the coordinator once — and not at all when it is the asker, whose
 *       ending says it instead;
 *   (5) an answer carrying an acting session is 403 REOPEN_OWNER_CHANNEL_ONLY, and a personal access token is refused
 *       OWNER_INTERACTIVE; both write nothing, and the owner's login reopens;
 *   (6) the project page's Reopen press settles the card DONE, and a project delete withdraws it;
 *   (7) the projection does not store DONE over the answered request while nothing moved (the 0469 rule, through this
 *       door).
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own account.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ProjectStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  type PrismaClient,
  type Runner,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { PROJECT_REOPEN_NOTES, uuidToBase62, type ProjectReopenPayload } from '@orbit/shared';
import { Client } from 'pg';

import { PatService, PAT_SCOPES } from '../auth/pat.service';
import { call, startApiserver } from '../auth/pat-test-apiserver';
import type { AuthCredential, AuthUser } from '../common/current-user.decorator';
import type { DeclineOwnerRequestDto, RequestProjectReopenDto } from '../owner-requests/dto';
import { OwnerRequestsController } from '../owner-requests/owner-requests.controller';
import { OwnerRequestsService } from '../owner-requests/owner-requests.service';
import { OwnerSecretsService } from '../owner-requests/owner-secrets.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { WatchDeliveryService } from '../watches/watch-delivery.service';
import type { CompletionInputRouter } from './completion-input-router.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { readDerivedProjectDone, reopenRecordOfPress, storeDerivedProjectStatus } from './project-done-derived';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WHY = 'The release checklist found the Android share sheet still opens the old screen.';
const PLANNED = 'Add a criterion for the Android share target and one task to fix it.';

test('project reopen requests: an agent asks, the owner answers once, and the press stands', {
  skip, concurrency: 1, timeout: 900_000,
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
  const push = { notifyOwnerRequest: async () => undefined } as unknown as PushService;
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
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
  const delivery = new WatchDeliveryService(db, sessions, push, { retryBaseMs: 0, retryMaxMs: 0, pollIntervalMs: 3_600_000 });
  const secrets = new OwnerSecretsService(db);
  const requests = new OwnerRequestsService(db, secrets, push, delivery, realtime, undefined, sessions);
  const runnerDoor = new RunnerProjectsController(
    projects,
    acceptance,
    {} as never,
    { assert: async () => assert.fail('asking to reopen spends no orchestration credential') } as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    requests,
  );
  const ownerDoor = new OwnerRequestsController(requests, secrets);

  // ── one account, one machine ──────────────────────────────────────────────────────────────────

  const ownerId = randomUUID();
  const email = `project-reopen-request-${ownerId}@project-reopen-request.invalid`;
  await prisma.user.create({ data: { id: ownerId, email, name: 'The account owner', passwordHash: 'x' } });
  const runnerId = randomUUID();
  const runner: Runner = await prisma.runner.create({
    data: {
      id: runnerId, ownerId, name: 'project-reopen-request-runner', tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await prisma.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'project-reopen-request', enabled: true } });
  const auth = { userId: ownerId } as unknown as AuthUser;
  const LOGIN = { kind: 'LOGIN' } as unknown as AuthCredential;

  // ── the fixture's vocabulary ──────────────────────────────────────────────────────────────────

  /** A live session of this runner that a turn can be queued on. */
  async function session(title: string): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: title, provider: 'claude',
        turnState: null, dispatchOrigin: SessionDispatchOrigin.USER, numTurns: 1, startedAt: new Date(),
        runtimeSessionId: randomUUID(), startsTaskWork: false,
      },
    });
    return id;
  }

  /** A project settled by hand: DONE recorded by the owner, or CANCELLED. No criteria. */
  async function settled(title: string, status: 'DONE' | 'CANCELLED' = 'DONE', coordinator?: string): Promise<string> {
    const id = randomUUID();
    await prisma.project.create({
      data: {
        id, ownerId, title, status,
        ...(status === 'DONE' ? { doneBy: 'OWNER', doneAt: new Date(Date.now() - 60_000) } : {}),
        ...(coordinator ? { coordinatorSessionId: coordinator, coordinatorWorkspaceId: workspaceId } : {}),
      },
    });
    return id;
  }

  const file = (sessionId: string | undefined, projectId: string, body: Partial<RequestProjectReopenDto> = {}) =>
    runnerDoor.requestReopen(runner, sessionId, projectId, { why: WHY, plannedWork: PLANNED, ...body } as RequestProjectReopenDto);
  const answer = (id: string, headers: Record<string, string> = {}) => ownerDoor.reopenProject(auth, id, { headers }, 'web/1.0');
  const decline = (id: string, reason: string) =>
    ownerDoor.decline(auth, id, { reason, sendAsWritten: true } as DeclineOwnerRequestDto, 'web/1.0');
  const refusal = async (pending: Promise<unknown>) => {
    const error = await pending.then(() => assert.fail('expected a refusal'), (e: unknown) => e);
    assert.ok(error instanceof HttpException, String(error));
    return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
  };
  const cards = (projectId: string) => prisma.ownerRequest.findMany({
    where: { ownerId, projectId, kind: 'PROJECT_REOPEN' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, state: true, title: true, why: true, payload: true, askedBySessionId: true, resolutionNote: true,
      resolvedByUserId: true, resolvedClient: true,
    },
  });
  const deliveries = (requestId: string) => prisma.watchDelivery.count({ where: { ownerRequestId: requestId } });
  const turns = async (sessionId: string) => (await sql.query<{ clientTurnId: string; content: string }>(
    `SELECT "client_turn_id" AS "clientTurnId", "content" FROM "conversation_turn" WHERE "session_id" = $1::uuid ORDER BY "seq"`,
    [sessionId],
  )).rows;
  const endingsOn = async (sessionId: string, requestId: string) =>
    (await turns(sessionId)).filter((turn) => turn.clientTurnId === `owner-request:${requestId}:resolved`);
  const reopenNotices = async (sessionId: string) =>
    (await turns(sessionId)).filter((turn) => turn.content.startsWith('From Orbit · project reopened'));
  async function projectRow(projectId: string) {
    const { rows } = await sql.query<{ row: Record<string, unknown> }>(
      `SELECT row_to_json(p) AS "row" FROM "project" p WHERE p."id" = $1::uuid`, [projectId],
    );
    return rows[0]?.row ?? null;
  }

  // A project the facts settle (one criterion, one landed task serving it, the standard set confirmed), as the owner
  // reopen spec builds it: the only kind the projection would store DONE over again.
  let landings = 0;
  async function factSettledProject(title: string, coordinator: string): Promise<string> {
    const projectId = randomUUID();
    await prisma.project.create({
      data: { id: projectId, ownerId, title, coordinatorWorkspaceId: workspaceId, coordinatorSessionId: coordinator, coordinatorEnabled: true },
    });
    await prisma.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
    const [criterion] = criteriaFromDefinitions((await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: [{ text: 'the share target opens the new screen', verificationMethod: 'HUMAN' }],
    } as never)).acceptanceCriteriaItems);
    assert.ok(criterion);
    const task = await tasks.create(ownerId, {
      title: 'the share target work', projectId, criterionKey: criterion.key,
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    } as never);
    const run = randomUUID();
    await prisma.session.create({
      data: {
        id: run, ownerId, creatorId: ownerId, taskId: task.id, title: `ran ${task.id}`, prompt: 'do the work',
        turnState: null, finishedAt: new Date(), branch: `orbit/${task.id}`, isolationStatus: 'worktree',
      },
    });
    const done = await sql.query(
      `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid AND "completion_criterion" = 'EXECUTABLE'
          AND "acceptance_command" = 'true' AND "acceptance_expected_exit_code" = 0`,
      [task.id],
    );
    assert.equal(done.rowCount, 1);
    landings += 1;
    await receipts.record(ownerId, run, {
      result: 'MERGED', sourceSha: landings.toString(16).padStart(40, '0'), targetBranch: 'main',
      targetShaBefore: 'a'.repeat(40), targetShaAfter: 'b'.repeat(40),
    }, 'AGENT');
    await acceptance.confirmStandardSet(ownerId, projectId, {
      criteriaDigest: (await acceptance.standardSetConfirmation(ownerId, projectId)).currentVersion.digest,
    });
    const row = await projectRow(projectId);
    assert.equal(row?.status, ProjectStatus.DONE, 'the fixture settles by the facts');
    assert.equal(row?.done_by, 'DERIVED');
    return projectId;
  }

  // ══ (1) ═══════════════════════════════════════════════════════════════════════════════════════

  await t.test('(1) a DONE and a CANCELLED project each get one PENDING card; an OPEN one gets none', async () => {
    const asker = await session('Shipping the Android share target');
    const done = await settled('Share to Orbit');
    const doneAt = (await prisma.project.findUniqueOrThrow({ where: { id: done }, select: { doneAt: true } })).doneAt!;

    const filed = await file(asker, done, { why: `  ${WHY}  `, plannedWork: `\n${PLANNED}\n` });
    assert.equal(filed.state, 'PENDING');
    assert.equal(filed.created, true);
    assert.equal(filed.alreadyOpen, false);
    const [card] = await cards(done);
    assert.equal(card.id, filed.id);
    assert.equal(card.title, 'Reopen project “Share to Orbit”?', 'the server writes the title');
    assert.equal(card.why, WHY, 'why is trimmed');
    assert.equal(card.askedBySessionId, asker);
    const payload = card.payload as unknown as ProjectReopenPayload;
    assert.equal(payload.projectId, done);
    assert.equal(payload.statusAtAsk, 'DONE');
    assert.equal(payload.settledAt, doneAt.toISOString(), 'a DONE project was settled when it was recorded done');
    assert.equal(payload.plannedWork, PLANNED, 'plannedWork is trimmed');
    assert.deepEqual(payload.askers.map((a) => a.sessionId), [asker]);
    assert.deepEqual(filed.askers?.map((a) => [a.sessionId, a.title]), [[asker, 'Shipping the Android share target']],
      'the card names its asker by title');
    assert.equal((await projectRow(done))?.status, ProjectStatus.DONE, 'filing reopens nothing');

    const cancelled = await settled('Old share sheet', 'CANCELLED');
    await file(asker, cancelled);
    const [cancelledCard] = await cards(cancelled);
    assert.equal((cancelledCard.payload as unknown as ProjectReopenPayload).statusAtAsk, 'CANCELLED');
    assert.equal(cancelledCard.state, 'PENDING');

    const open = randomUUID();
    await prisma.project.create({ data: { id: open, ownerId, title: 'Still going' } });
    const refused = await refusal(file(asker, open));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'PROJECT_ALREADY_OPEN');
    assert.deepEqual(await cards(open), [], 'nothing filed');

    const other = await settled('Needs its words');
    for (const body of [{ why: '   ' }, { plannedWork: '' }, { why: 'x'.repeat(2_001) }, { plannedWork: 'y'.repeat(2_001) }]) {
      const bad = await refusal(file(asker, other, body));
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
    const headerless = await refusal(file(undefined, other));
    assert.equal(headerless.status, 400, 'a request is always some session’s');
    assert.deepEqual(await cards(other), [], 'nothing filed by a refused filing');
  });

  // ══ (2) ═══════════════════════════════════════════════════════════════════════════════════════

  await t.test('(2) a second asker joins the waiting card, and every asker gets its ending', async () => {
    const first = await session('The first asker');
    const second = await session('The second asker');
    const projectId = await settled('Joined');
    const filed = await file(first, projectId);
    const joined = await file(second, projectId, { why: 'Another reason', plannedWork: 'Other work' });
    assert.equal(joined.id, filed.id, 'one card per project');
    assert.equal(joined.alreadyOpen, true);
    assert.equal(joined.created, false);
    assert.deepEqual(joined.askers?.map((a) => [a.sessionId, a.title]), [[first, 'The first asker'], [second, 'The second asker']]);
    const again = await file(first, projectId);
    assert.equal(again.alreadyOpen, true, 'asking twice is answered with the card');
    assert.equal((await cards(projectId)).length, 1);
    assert.deepEqual(((await cards(projectId))[0].payload as unknown as ProjectReopenPayload).askers.map((a) => a.sessionId),
      [first, second], 'an asker is listed once');

    // A third asker that no longer needs it withdraws: the card waits on for the other two.
    const third = await session('The asker that changed its mind');
    await file(third, projectId);
    const left = await requests.withdraw(ownerId, third, filed.id, 'not needed');
    assert.equal(left.state, 'PENDING');
    assert.deepEqual(left.askers?.map((a) => a.sessionId), [first, second]);

    await decline(filed.id, 'Not this project: open a new one.');
    assert.equal(await deliveries(filed.id), 1, 'one delivery carries the ending');
    await delivery.drain();
    for (const asker of [first, second]) {
      const ending = await endingsOn(asker, filed.id);
      assert.equal(ending.length, 1, `${asker} is told once`);
      assert.match(ending[0].content, /ended DECLINED/);
      assert.match(ending[0].content, /Do not ask again/);
      assert.match(ending[0].content, /Not this project: open a new one\./);
    }
    assert.deepEqual(await endingsOn(third, filed.id), [], 'a session that withdrew is not told');
    await delivery.drain();
    assert.equal((await endingsOn(second, filed.id)).length, 1, 'a second pass queues nothing twice');
  });

  // ══ (3) ═══════════════════════════════════════════════════════════════════════════════════════

  await t.test('(3) a re-file after a decline is refused until the project is reopened and settled again', async () => {
    const asker = await session('Asks again');
    const projectId = await settled('Declined once');
    const filed = await file(asker, projectId);
    await decline(filed.id, 'This finding belongs to a new project.');

    const refused = await refusal(file(asker, projectId));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'REOPEN_REQUEST_DECLINED');
    assert.equal(refused.body.reason, 'This finding belongs to a new project.');
    const declinedAt = (await prisma.ownerRequest.findUniqueOrThrow({ where: { id: filed.id }, select: { resolvedAt: true } })).resolvedAt!;
    assert.equal(refused.body.declinedAt, declinedAt.toISOString());
    assert.match(String(refused.body.message), new RegExp(declinedAt.toISOString().slice(0, 10)));
    assert.equal((await cards(projectId)).length, 1, 'nothing filed');

    // The owner reopens it on the page and settles it again: a new settlement, which the old decline was not about.
    await projects.update(ownerId, projectId, { status: 'OPEN' } as never, undefined, LOGIN);
    await projects.update(ownerId, projectId, { status: 'DONE' } as never, undefined, LOGIN);
    const asked = await file(asker, projectId);
    assert.equal(asked.created, true, 'the same session may ask again');
    assert.equal(asked.state, 'PENDING');
  });

  // ══ (4) and (7) ═══════════════════════════════════════════════════════════════════════════════

  await t.test('(4) the answer reopens as the page’s press does, settles every card, and tells the coordinator once', async () => {
    const coordinator = await session('Coordinating Share to Orbit');
    const projectId = await factSettledProject('Share to Orbit, by the facts', coordinator);
    const first = await session('Found the share bug');
    const second = await session('Also found it');
    const filed = await file(first, projectId);
    await file(second, projectId);

    const pressedAt = Date.now();
    const answered = await answer(filed.id);
    assert.equal(answered.state, 'DONE');
    const row = (await projectRow(projectId))!;
    assert.equal(row.status, ProjectStatus.OPEN);
    assert.equal(row.done_by, null, 'a project taken out of DONE carries no record of one');
    assert.ok(Date.parse(row.reopened_at as string) >= pressedAt - 1_000, 'the press is recorded when it was made');
    const press = await reopenRecordOfPress(db, ownerId, projectId);
    assert.deepEqual(row.reopened_facts, press.reopenedFacts, 'the record is exactly what the page’s press writes');

    const [card] = await cards(projectId);
    assert.equal(card.state, 'DONE');
    assert.equal(card.resolvedByUserId, ownerId);
    assert.equal(card.resolvedClient, 'web');
    assert.equal(card.resolutionNote, null);
    assert.equal(await deliveries(filed.id), 1);
    await delivery.drain();
    for (const asker of [first, second]) {
      const ending = await endingsOn(asker, filed.id);
      assert.equal(ending.length, 1, 'every asker gets the ending');
      assert.match(ending[0].content, /ended DONE\. The project is OPEN again: the owner reopened it\. Retry the write that was refused\./);
    }
    const told = await reopenNotices(coordinator);
    assert.equal(told.length, 1, 'the coordinator is told once');
    assert.match(told[0].content, new RegExp(uuidToBase62(filed.id)));
    assert.match(told[0].content, /Add a criterion for the Android share target/);

    const twice = await refusal(answer(filed.id));
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'OWNER_REQUEST_NOT_PENDING', 'a second press is refused');
    assert.equal((await reopenNotices(coordinator)).length, 1, 'and tells nobody again');

    // (7): nothing moved, so the projection leaves the press standing although the facts still prove DONE.
    assert.equal((await readDerivedProjectDone(db, ownerId, projectId)).done, true, 'the facts prove DONE throughout');
    await storeDerivedProjectStatus(db, ownerId, projectId);
    const after = (await projectRow(projectId))!;
    assert.equal(after.status, ProjectStatus.OPEN, '(7) the projection stored DONE over the answered request');
    assert.equal(after.reopened_at, row.reopened_at, '(7) and the press is still on record');
    await tasks.update(ownerId, (await prisma.task.findFirstOrThrow({ where: { projectId } })).id, { title: 'renamed' } as never);
    assert.equal((await projectRow(projectId))?.status, ProjectStatus.OPEN, '(7) a task write that moves no fact leaves it OPEN');
  });

  await t.test('(4) a coordinator that asked is told by its ending, not twice', async () => {
    const coordinator = await session('Coordinating and asking');
    const projectId = await settled('Coordinator asks', 'DONE', coordinator);
    const filed = await file(coordinator, projectId);
    await answer(filed.id);
    await delivery.drain();
    assert.equal((await endingsOn(coordinator, filed.id)).length, 1, 'its ending');
    assert.deepEqual(await reopenNotices(coordinator), [], 'and no second notice');
  });

  await t.test('(4) an answer on a project the owner reopened meanwhile settles the card “Already reopened”', async () => {
    const asker = await session('Asked before the owner pressed');
    const projectId = await settled('Reopened meanwhile');
    const filed = await file(asker, projectId);
    // Written past the page's door, which would itself settle the card (6).
    await prisma.project.update({ where: { id: projectId }, data: { status: 'OPEN', doneBy: null, doneAt: null } });
    const answered = await answer(filed.id);
    assert.equal(answered.state, 'DONE');
    assert.equal(answered.resolutionNote, PROJECT_REOPEN_NOTES.alreadyReopened);
    assert.equal((await projectRow(projectId))?.reopened_at, null, 'no second press is recorded');
  });

  // ══ (5) ═══════════════════════════════════════════════════════════════════════════════════════

  await t.test('(5) a session and a token are refused the answer; the owner’s login reopens', async (tt) => {
    const asker = await session('Asks over HTTP');
    const projectId = await settled('Answered over HTTP');
    const filed = await file(asker, projectId);

    const inProcess = await refusal(answer(filed.id, { 'x-orbit-session-id': asker }));
    assert.equal(inProcess.status, 403);
    assert.equal(inProcess.body.code, 'REOPEN_OWNER_CHANNEL_ONLY');

    const jwtSecret = `project-reopen-request-${randomUUID()}`;
    const server = await startApiserver(url, jwtSecret);
    tt.after(() => server.stop());
    const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: ownerId, email });
    const token = (await new PatService(db).issue(ownerId, {
      name: 'every scope', scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB',
    })).token;
    const path = `/api/owner-requests/${uuidToBase62(filed.id)}/reopen-project`;

    const bySession = await call(server, 'POST', path, login, {}, { 'x-orbit-session-id': uuidToBase62(asker) });
    assert.equal(bySession.status, 403, bySession.text);
    assert.equal(bySession.json.code, 'REOPEN_OWNER_CHANNEL_ONLY');
    const byToken = await call(server, 'POST', path, token, {});
    assert.equal(byToken.status, 403, byToken.text);
    assert.equal(byToken.json.code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
    assert.equal(byToken.json.reason, 'OWNER_INTERACTIVE');
    assert.equal((await cards(projectId))[0].state, 'PENDING', 'neither wrote the card');
    assert.equal((await projectRow(projectId))?.status, ProjectStatus.DONE, 'nor the project');

    const byOwner = await call(server, 'POST', path, login, {}, { 'x-orbit-client': 'ios/1.0' });
    assert.equal(byOwner.status, 200, byOwner.text);
    assert.equal(byOwner.json.state, 'DONE');
    assert.equal((await projectRow(projectId))?.status, ProjectStatus.OPEN);
    assert.equal((await cards(projectId))[0].resolvedClient, 'ios');
  });

  // ══ (6) ═══════════════════════════════════════════════════════════════════════════════════════

  await t.test('(6) the page’s Reopen press settles the card, and a project delete withdraws it', async () => {
    const asker = await session('Waits on the page');
    const pressed = await settled('Pressed on the page');
    const filed = await file(asker, pressed);
    await projects.update(ownerId, pressed, { status: 'OPEN' } as never, undefined, LOGIN);
    const [card] = await cards(pressed);
    assert.equal(card.state, 'DONE');
    assert.equal(card.resolutionNote, PROJECT_REOPEN_NOTES.reopenedFromPage);
    assert.equal(card.resolvedByUserId, ownerId);
    assert.ok((await projectRow(pressed))?.reopened_at, 'the press itself is recorded as always');
    assert.equal(await deliveries(filed.id), 1);
    const late = await refusal(answer(filed.id));
    assert.equal(late.body.code, 'OWNER_REQUEST_NOT_PENDING', 'the card cannot be answered after the page’s press');

    const deleted = await settled('Deleted while asked');
    const gone = await file(asker, deleted);
    await projects.remove(ownerId, deleted);
    const withdrawn = await prisma.ownerRequest.findUniqueOrThrow({ where: { id: gone.id }, select: { state: true, resolutionNote: true } });
    assert.deepEqual(withdrawn, { state: 'WITHDRAWN', resolutionNote: PROJECT_REOPEN_NOTES.projectDeleted });
    assert.equal(await deliveries(gone.id), 1);
    await delivery.drain();
    assert.match((await endingsOn(asker, filed.id))[0].content, /ended DONE/);
    assert.match((await endingsOn(asker, gone.id))[0].content, /The project was deleted while the request waited/);
  });

  // ── the refusals the filing door answers stay coded ───────────────────────────────────────────

  await t.test('refusals are coded HTTP errors, not 500s', async () => {
    const asker = await session('Codes');
    const bad = await file(asker, await settled('Codes'), { why: '' }).catch((e: unknown) => e);
    assert.ok(bad instanceof BadRequestException);
    const open = randomUUID();
    await prisma.project.create({ data: { id: open, ownerId, title: 'Open' } });
    assert.ok(await file(asker, open).catch((e: unknown) => e) instanceof ConflictException);
    // A JSON column the server wrote and nothing else: the CHECK holds a PROJECT_REOPEN to its project.
    await assert.rejects(sql.query(
      `INSERT INTO "owner_request" ("id", "owner_id", "asked_by_session_id", "kind", "title", "why", "payload", "updated_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'PROJECT_REOPEN', 't', 'w', '{}'::jsonb, now())`,
      [randomUUID(), ownerId, asker],
    ), /owner_request_project_reopen_chk/);
  });
});

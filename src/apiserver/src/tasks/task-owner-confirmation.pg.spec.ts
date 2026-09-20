/**
 * OWNER_CONFIRMED end to end against real PostgreSQL: the account owner's own decision is what
 * settles the task, no agent session can make it, a send-back is delivered as the next message of
 * the same session, and a run waiting on its owner is counted on the session its card is drawn in.
 *
 * In the order a task lives through them:
 *
 *   (1) migration 0267 — the label, the two tables, and the DONE fence's new lane;
 *   (2) the label is declarable inside a project and outside one, through the real create door;
 *   (3) the fence refuses DONE until the owner's NEWEST decision is a CONFIRM, the table refuses a
 *       decision the owner did not make, and deleting the task still takes its rows with it;
 *   (4) an agent session is refused at both doors, and nothing is written;
 *   (5) a direct DONE is still refused, and names who settles this task;
 *   (6) the owner confirms a task that never ran — a record — and DONE is derived, in a project or
 *       in none; this is (4)'s call without the session, which is what makes (4) mean anything;
 *   (7) a run that ends its turn successfully — the real /turn-complete — asks the owner, and the
 *       session is counted as waiting for confirmation; a turn that failed asks nobody;
 *   (8) a send-back needs a reason, files it as the next message of that session, and leaves the
 *       task open and no longer waiting;
 *   (9) the next successful turn asks again, and an answer to the report it replaced is refused;
 *  (10) the owner confirms the new report: DONE, the session goes dark, and both decisions stay.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type HttpException,
} from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';
import { RunEventType, RunStatus as SharedRunStatus } from '@orbit/shared';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import {
  countOwnerDecisionsBySession,
  readOwnerDecisionsBySession,
  sessionWaitingKind,
} from '../projects/owner-decision-signal';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerTaskOwnerConfirmationController } from '../runner-api/runner-task-owner-confirmation.controller';
import { SessionsService } from '../sessions/sessions.service';
import type { CreateTaskDto, DecideOwnerConfirmationDto, UpdateTaskDto } from './dto';
import { TaskOwnerConfirmationController } from './task-owner-confirmation.controller';
import { TaskOwnerConfirmationService } from './task-owner-confirmation.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const FIRST_REPORT = 'Done. 38 invoices are renamed and filed under finance/2026-09/.';
const SECOND_REPORT = 'Filled in the Aliyun amount from the bank statement and re-totalled summary.csv.';
const REASON = 'The Aliyun invoice from 09-17 still needs its amount — take it from the bank statement.';

interface RefusalBody {
  code?: string;
  criterion?: string;
  requiredAction?: string;
  message?: string;
}

/** The body an HTTP exception carries, asserting which exception it was. */
async function refusedWith(
  call: Promise<unknown>,
  kind: typeof ForbiddenException | typeof ConflictException | typeof BadRequestException,
): Promise<RefusalBody> {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof kind, `expected ${kind.name}, got ${error}`);
    return (error as HttpException).getResponse() as RefusalBody;
  }
  assert.fail(`expected ${kind.name}, but the call was accepted`);
}

suite('OWNER_CONFIRMED: the owner settles it, no session can, and a send-back goes back to the run',
  async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL });
    await sql.connect();
    const db = prismaClientFor(URL!);
    t.after(async () => {
      await db.$disconnect();
      await sql.end();
    });
    await verifyCoordinatorPgIdentity(sql);
    await sql.query(`
      TRUNCATE "task", "session", "project", "workspace", "runner", "user"
      RESTART IDENTITY CASCADE
    `);

    const prisma = db as unknown as PrismaService;
    const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
    const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
    const sessions = new SessionsService(prisma, queue, realtime);
    const tasks = new TasksService(prisma, sessions, realtime);
    const confirmations = new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime);
    const userDoor = new TaskOwnerConfirmationController(confirmations);
    const runnerDoor = new RunnerTaskOwnerConfirmationController(confirmations);
    const runnerApi = new RunnerApiController(
      prisma,
      queue,
      realtime,
      {} as never,
      {} as never,
      {} as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
      undefined,
      undefined,
      tasks,
    );

    // ── the account and its two kinds of caller ────────────────────────────────────────────────
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const coordinatorSessionId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `owner-${ownerId}@invalid.test`, name: 'Owner', passwordHash: 'x' },
    });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: 'owner-confirmation-runner',
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: [],
        capabilitiesReportedAt: new Date(),
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: 'owner-confirmation', enabled: true },
    });
    await db.project.create({ data: { id: projectId, ownerId, title: 'finance-ops' } });
    // An agent session of this same owner that executes no task — the shape a coordinator has.
    await db.session.create({
      data: {
        id: coordinatorSessionId,
        ownerId,
        creatorId: ownerId,
        taskId: null,
        workspaceId,
        assignedRunnerId: runnerId,
        title: 'the project coordinator',
        prompt: 'read the ledger and decide',
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: false,
      },
    });
    const runner = await db.runner.findUniqueOrThrow({ where: { id: runnerId } });
    const owner = { userId: ownerId, email: `owner-${ownerId}@invalid.test` };

    const statusOf = async (taskId: string): Promise<string> => (await sql.query<{ status: string }>(
      'SELECT "status" FROM "task" WHERE "id" = $1', [taskId],
    )).rows[0].status;
    const decisionsOf = async (taskId: string): Promise<number> => Number((await sql.query<{ n: string }>(
      'SELECT count(*) AS n FROM "task_owner_decision" WHERE "task_id" = $1', [taskId],
    )).rows[0].n);
    const turnsOf = async (sessionId: string): Promise<number> => Number((await sql.query<{ n: string }>(
      'SELECT count(*) AS n FROM "conversation_turn" WHERE "session_id" = $1', [sessionId],
    )).rows[0].n);
    const decide = (dto: Partial<DecideOwnerConfirmationDto>) => dto as DecideOwnerConfirmationDto;

    // (1) -----------------------------------------------------------------------------------------
    await t.test('migration 0267 adds the label, the two tables and the fence lane', async () => {
      const labels = (await sql.query<{ label: string }>(
        `SELECT unnest(enum_range(NULL::"task_completion_criterion"))::text AS label`,
      )).rows.map((row) => row.label);
      assert.deepEqual(labels, ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT', 'OWNER_CONFIRMED']);
      const tables = (await sql.query<{ request: string | null; decision: string | null }>(
        `SELECT to_regclass('task_owner_confirmation_request')::text AS request,
                to_regclass('task_owner_decision')::text AS decision`,
      )).rows[0];
      assert.equal(tables.request, 'task_owner_confirmation_request');
      assert.equal(tables.decision, 'task_owner_decision');
      const fence = (await sql.query<{ src: string }>(
        `SELECT prosrc AS src FROM pg_proc WHERE proname = 'task_done_canonical_writer_fence'`,
      )).rows[0].src;
      assert.match(fence, /'OWNER_CONFIRMED'::"task_completion_criterion"/u);
      assert.match(fence, /FROM "task_owner_decision" decided/u);
      // The lanes before it are still there: CREATE OR REPLACE restated them.
      assert.match(fence, /'EVIDENCE_JUDGMENT'::"task_completion_criterion"/u);
      assert.match(fence, /'EXECUTABLE'::"task_completion_criterion"/u);
    });

    // (2) -----------------------------------------------------------------------------------------
    let recordTaskId = '';
    let projectTaskId = '';
    await t.test('OWNER_CONFIRMED is declarable in a project and in none, through the create door',
      async () => {
        const record = await tasks.create(ownerId, {
          title: 'Archive the September invoices',
          completionCriterion: 'OWNER_CONFIRMED',
          autoRunWhenReady: false,
        } as CreateTaskDto);
        const inProject = await tasks.create(ownerId, {
          title: 'Sign off the Q3 vendor review',
          projectId,
          completionCriterion: 'OWNER_CONFIRMED',
          autoRunWhenReady: false,
        } as CreateTaskDto);
        recordTaskId = record.id;
        projectTaskId = inProject.id;
        for (const [taskId, project] of [[recordTaskId, null], [projectTaskId, projectId]] as const) {
          const row = (await sql.query<{ criterion: string; policy: string; project: string | null }>(
            `SELECT "completion_criterion"::text AS criterion, "completion_policy"::text AS policy,
                    "project_id" AS project
               FROM "task" WHERE "id" = $1`,
            [taskId],
          )).rows[0];
          assert.deepEqual(row, { criterion: 'OWNER_CONFIRMED', policy: 'MANUAL', project });
          assert.equal(await statusOf(taskId), 'OPEN');
        }
        // A declaration with a command attached is still refused: the criterion takes none.
        await assert.rejects(tasks.create(ownerId, {
          title: 'not a valid declaration',
          completionCriterion: 'OWNER_CONFIRMED',
          acceptanceCommand: 'true',
          acceptanceExpectedExitCode: 0,
        } as CreateTaskDto), /OWNER_CONFIRMED cannot also declare executable acceptance/u);
      });

    // (3) -----------------------------------------------------------------------------------------
    await t.test('the fence refuses DONE until the owner\'s newest decision is a CONFIRM', async () => {
      const scratchId = randomUUID();
      await db.task.create({
        data: {
          id: scratchId,
          ownerId,
          title: 'a task the fence is asked about directly',
          creatorType: CreatorType.USER,
          creatorId: ownerId,
          status: TaskStatus.OPEN,
          completionCriterion: 'OWNER_CONFIRMED',
          autoRunWhenReady: false,
        },
      });
      const done = () => sql.query(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1`, [scratchId]);
      const request = async (): Promise<string> => {
        const id = randomUUID();
        await sql.query(
          `INSERT INTO "task_owner_confirmation_request" ("id", "task_id", "owner_id", "session_id", "turn_id")
           VALUES ($1, $2, $3, $4, $5)`,
          [id, scratchId, ownerId, randomUUID(), randomUUID()],
        );
        return id;
      };
      const decision = (
        requestId: string | null,
        value: 'CONFIRM' | 'SEND_BACK',
        secondsAgo: number,
        over: { note?: string | null; byType?: string; byId?: string } = {},
      ) => sql.query(
        `INSERT INTO "task_owner_decision"
           ("id", "task_id", "owner_id", "request_id", "decision", "note", "decided_at",
            "decided_by_type", "decided_by_id")
         VALUES ($1, $2, $3, $4, $5::"task_owner_decision_value", $6,
                 now() - make_interval(secs => $7), $8::"creator_type", $9)`,
        [randomUUID(), scratchId, ownerId, requestId, value, over.note ?? null, secondsAgo,
          over.byType ?? 'USER', over.byId ?? ownerId],
      );

      await assert.rejects(done(), /TASK_DONE_CANONICAL_FACT_REQUIRED/u, 'no decision at all');
      // Only the owner, and a send-back only with a reason and a report it answers.
      const first = await request();
      await assert.rejects(decision(first, 'CONFIRM', 3, { byType: 'AGENT' }), /task_owner_decision_by_owner/u);
      await assert.rejects(decision(first, 'CONFIRM', 3, { byId: randomUUID() }), /task_owner_decision_by_owner/u);
      await assert.rejects(decision(first, 'SEND_BACK', 3), /task_owner_decision_send_back_shape/u);
      await assert.rejects(decision(null, 'SEND_BACK', 3, { note: REASON }), /task_owner_decision_send_back_shape/u);
      await assert.rejects(decision(first, 'CONFIRM', 3, { note: '   ' }), /task_owner_decision_note_nonblank/u);
      assert.equal(await decisionsOf(scratchId), 0, 'every refused decision wrote nothing');

      // A CONFIRM that a later SEND_BACK overruled is not the owner's word any more.
      await decision(first, 'CONFIRM', 3);
      const second = await request();
      await decision(second, 'SEND_BACK', 2, { note: REASON });
      await assert.rejects(done(), /TASK_DONE_CANONICAL_FACT_REQUIRED/u, 'the newest decision is a SEND_BACK');
      assert.equal(await statusOf(scratchId), 'OPEN');

      await decision(null, 'CONFIRM', 1);
      await done();
      assert.equal(await statusOf(scratchId), 'DONE', 'the newest decision is a CONFIRM');

      // A request is RESTRICTed under its decision, and deleting the task still takes both.
      await sql.query('DELETE FROM "task" WHERE "id" = $1', [scratchId]);
      const left = (await sql.query<{ requests: string; decisions: string }>(
        `SELECT (SELECT count(*) FROM "task_owner_confirmation_request" WHERE "task_id" = $1) AS requests,
                (SELECT count(*) FROM "task_owner_decision" WHERE "task_id" = $1) AS decisions`,
        [scratchId],
      )).rows[0];
      assert.deepEqual(left, { requests: '0', decisions: '0' });
    });

    // (4) -----------------------------------------------------------------------------------------
    await t.test('an agent session cannot confirm, at either door, and nothing is written', async () => {
      const overRunner = await refusedWith(
        runnerDoor.decide(runner, recordTaskId, coordinatorSessionId, decide({ decision: 'CONFIRM' })),
        ForbiddenException,
      );
      assert.equal(overRunner.code, 'OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER');
      assert.equal(overRunner.requiredAction, 'HAVE_THE_ACCOUNT_OWNER_CONFIRM_IN_THE_APP');
      // The owner's own credential in an agent's hands is still an agent deciding.
      const withHeader = await refusedWith(
        userDoor.decide(owner, recordTaskId, coordinatorSessionId, decide({ decision: 'CONFIRM' })),
        ForbiddenException,
      );
      assert.equal(withHeader.code, 'OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER');
      const sendBack = await refusedWith(
        runnerDoor.decide(runner, recordTaskId, coordinatorSessionId, decide({ decision: 'SEND_BACK', note: REASON })),
        ForbiddenException,
      );
      assert.equal(sendBack.code, 'OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER');
      assert.equal(await decisionsOf(recordTaskId), 0, 'a refused decision writes no row');
      assert.equal(await statusOf(recordTaskId), 'OPEN', 'and settles nothing');
    });

    // (5) -----------------------------------------------------------------------------------------
    await t.test('a direct DONE is still refused, and says the owner confirms it in the app', async () => {
      for (const actingSessionId of [undefined, coordinatorSessionId]) {
        const body = await refusedWith(
          tasks.update(ownerId, recordTaskId, { status: TaskStatus.DONE } as unknown as UpdateTaskDto, actingSessionId),
          ForbiddenException,
        );
        assert.equal(body.code, 'DIRECT_TASK_DONE_REFUSED');
        assert.equal(body.criterion, 'OWNER_CONFIRMED');
        assert.equal(body.requiredAction, 'HAVE_THE_ACCOUNT_OWNER_CONFIRM_IN_THE_APP');
        assert.match(body.message ?? '', /only the account owner can settle this task/u);
      }
      assert.equal(await statusOf(recordTaskId), 'OPEN');
    });

    // (6) -----------------------------------------------------------------------------------------
    await t.test('the owner confirms a task that never ran, and DONE is derived — in no project and in one',
      async () => {
        for (const taskId of [recordTaskId, projectTaskId]) {
          assert.equal((await confirmations.read(ownerId, taskId)).waiting, null, 'no run is waiting');
          const receipt = await userDoor.decide(owner, taskId, undefined, decide({ decision: 'CONFIRM' }));
          assert.equal(receipt.decision, 'CONFIRM');
          assert.equal(receipt.requestId, null, 'it answered no run');
          assert.equal(receipt.completed, true);
          assert.equal(await statusOf(taskId), 'DONE', 'read from the row, not from the receipt');
          const row = (await sql.query<{ decision: string; by_type: string; by_id: string; request: string | null }>(
            `SELECT "decision"::text AS decision, "decided_by_type"::text AS by_type,
                    "decided_by_id" AS by_id, "request_id" AS request
               FROM "task_owner_decision" WHERE "task_id" = $1`,
            [taskId],
          )).rows;
          assert.deepEqual(row, [{ decision: 'CONFIRM', by_type: 'USER', by_id: ownerId, request: null }]);
          const again = await refusedWith(
            userDoor.decide(owner, taskId, undefined, decide({ decision: 'CONFIRM' })),
            ConflictException,
          );
          assert.equal(again.code, 'OWNER_CONFIRMATION_TASK_SETTLED');
        }
      });

    // ── a task that runs ───────────────────────────────────────────────────────────────────────
    const runTaskId = randomUUID();
    const runSessionId = randomUUID();
    const firstTurnId = randomUUID();
    await db.task.create({
      data: {
        id: runTaskId,
        ownerId,
        title: '整理 9 月发票并归档',
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        assigneeId: workspaceId,
        status: TaskStatus.OPEN,
        completionCriterion: 'OWNER_CONFIRMED',
        acceptanceCriteria: 'Every September invoice is filed under finance/2026-09/.',
        autoRunWhenReady: false,
      },
    });
    await db.session.create({
      data: {
        id: runSessionId,
        ownerId,
        creatorId: ownerId,
        taskId: runTaskId,
        workspaceId,
        assignedRunnerId: runnerId,
        title: '整理 9 月发票并归档',
        prompt: 'file the September invoices',
        provider: 'claude',
        status: RunStatus.RUNNING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
        startedAt: new Date(),
      },
    });
    /** One turn of the run: the message is being worked on, and the engine says what it did. */
    const runTurn = async (turnId: string, seq: number, report: string) => {
      await db.conversationTurn.upsert({
        where: { id: turnId },
        create: {
          id: turnId,
          sessionId: runSessionId,
          seq,
          clientTurnId: `message:${turnId}`,
          kind: 'message',
          content: 'file the September invoices',
          status: 'IN_FLIGHT',
          // `dequeueTurn` marks the turn delivered in the same UPDATE that claims it, and
          // `turnComplete`'s idempotency ack matches on `delivered_at IS NOT NULL`: a claimed
          // turn that was never delivered is not a state the runner door produces, and its
          // completion is discarded whole — the run would never be asked about.
          deliveredAt: new Date(),
        },
        update: { status: 'IN_FLIGHT', deliveredAt: new Date() },
      });
      await db.session.update({ where: { id: runSessionId }, data: { status: RunStatus.RUNNING } });
      await db.runEvent.create({
        data: { sessionId: runSessionId, seq, type: 'assistant', payload: { text: report }, turnId },
      });
    };
    const waitingOn = async (sessionId: string) =>
      (await countOwnerDecisionsBySession(db, ownerId, { sessionIds: [sessionId, coordinatorSessionId] }))
        .get(sessionId) ?? 0;
    let firstRequestId = '';

    // (7) -----------------------------------------------------------------------------------------
    await t.test('a run that ends its turn successfully asks the owner, on its own session', async () => {
      await runTurn(firstTurnId, 1, FIRST_REPORT);
      assert.equal((await confirmations.read(ownerId, runTaskId)).waiting, null, 'nothing asked yet');
      assert.equal(await waitingOn(runSessionId), 0);

      await runnerApi.turnComplete({ id: runnerId }, runSessionId, {
        turnId: firstTurnId,
        status: SharedRunStatus.SUCCEEDED,
      } as never);

      const view = await confirmations.read(ownerId, runTaskId);
      assert.ok(view.waiting, 'the successful turn is now waiting on the owner');
      assert.equal(view.waiting.sessionId, runSessionId);
      assert.equal(view.waiting.report?.text, FIRST_REPORT, 'with what the run said');
      firstRequestId = view.waiting.requestId;
      assert.equal(await statusOf(runTaskId), 'OPEN', 'asking is not concluding');

      // Counted on the task's own session — not on a coordinator, and in no project.
      assert.equal(await waitingOn(runSessionId), 1);
      const bySession = await readOwnerDecisionsBySession(db, ownerId, { sessionIds: [runSessionId, coordinatorSessionId] });
      assert.equal(bySession.has(coordinatorSessionId), false);
      assert.equal(sessionWaitingKind(0, bySession.get(runSessionId)), 'OWNER_CONFIRMATION');
      assert.equal(sessionWaitingKind(1, bySession.get(runSessionId)), null,
        'a blocked tool call on the same row keeps the approval wording');
      const rows = await sessions.list(ownerId, { view: 'open' }) as Array<{
        id: string; pendingApprovals: number; waitingKind?: string | null;
      }>;
      const row = rows.find((each) => each.id === runSessionId);
      assert.equal(row?.pendingApprovals, 1, 'the list lights the row');
      assert.equal(row?.waitingKind, 'OWNER_CONFIRMATION', 'and says what it is waiting for');
      const coordinatorRow = rows.find((each) => each.id === coordinatorSessionId);
      assert.equal(coordinatorRow?.pendingApprovals, 0);
      assert.equal(coordinatorRow?.waitingKind ?? null, null);

      // A turn that FAILED asks nobody: the same call, one field different, on a task of its own.
      const failedTaskId = randomUUID();
      const failedSessionId = randomUUID();
      const failedTurnId = randomUUID();
      await db.task.create({
        data: {
          id: failedTaskId, ownerId, title: 'a run that fails', creatorType: CreatorType.USER,
          creatorId: ownerId, assigneeId: workspaceId, status: TaskStatus.OPEN,
          completionCriterion: 'OWNER_CONFIRMED', autoRunWhenReady: false,
        },
      });
      await db.session.create({
        data: {
          id: failedSessionId, ownerId, creatorId: ownerId, taskId: failedTaskId, workspaceId,
          assignedRunnerId: runnerId, title: 'a run that fails', prompt: 'fail', provider: 'claude',
          status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
          startedAt: new Date(),
        },
      });
      await db.conversationTurn.create({
        data: {
          id: failedTurnId, sessionId: failedSessionId, seq: 1, clientTurnId: `message:${failedTurnId}`,
          kind: 'message', content: 'fail', status: 'IN_FLIGHT',
          // Delivered, as `dequeueTurn` leaves it: the ack matches on `delivered_at IS NOT
          // NULL`, so without this the failing completion below is discarded instead of
          // being settled.
          deliveredAt: new Date(),
        },
      });
      // The engine's reply, which is what makes this turn ANSWERED rather than requeued: the
      // completion boundary asks the transcript for an assistant/result event under the turn, and a
      // message turn with none is put back in the queue instead (see
      // `turn-complete-unanswered.pg.spec.ts`). A replied-to turn that then completed is the
      // ordinary shape these fixtures simulate.
      await db.runEvent.create({
        data: {
          sessionId: failedSessionId, seq: 1000, type: RunEventType.ASSISTANT,
          payload: { text: FIRST_REPORT }, turnId: failedTurnId,
        },
      });
      await runnerApi.turnComplete({ id: runnerId }, failedSessionId, {
        turnId: failedTurnId,
        status: SharedRunStatus.FAILED,
      } as never);
      assert.equal((await confirmations.read(ownerId, failedTaskId)).waiting, null);
      assert.equal(await waitingOn(failedSessionId), 0);
    });

    // (8) -----------------------------------------------------------------------------------------
    let sendBackTurnId = '';
    await t.test('a send-back needs a reason, goes to the same session as the next message, and keeps the task open',
      async () => {
        const turnsBefore = await turnsOf(runSessionId);
        for (const note of [undefined, '   ']) {
          const body = await refusedWith(
            userDoor.decide(owner, runTaskId, undefined, decide({ decision: 'SEND_BACK', requestId: firstRequestId, note })),
            BadRequestException,
          );
          assert.equal(body.code, 'OWNER_CONFIRMATION_SEND_BACK_REQUIRES_REASON');
        }
        assert.equal(await decisionsOf(runTaskId), 0, 'no reason, no row');
        assert.equal(await turnsOf(runSessionId), turnsBefore, 'and no message');

        const receipt = await userDoor.decide(owner, runTaskId, undefined, decide({
          decision: 'SEND_BACK',
          requestId: firstRequestId,
          note: `  ${REASON}  `,
        }));
        assert.equal(receipt.decision, 'SEND_BACK');
        assert.equal(receipt.note, REASON);
        assert.equal(receipt.completed, false);
        assert.equal(receipt.sessionId, runSessionId);
        assert.ok(receipt.turnId);
        sendBackTurnId = receipt.turnId;

        const delivered = (await sql.query<{ id: string; kind: string; content: string; status: string; client: string }>(
          `SELECT "id", "kind", "content", "status", "client_turn_id" AS client
             FROM "conversation_turn" WHERE "session_id" = $1 AND "client_turn_id" = $2`,
          [runSessionId, `owner-send-back:${receipt.id}`],
        )).rows;
        assert.equal(delivered.length, 1, 'the reason is one message in the SAME session');
        assert.deepEqual(
          { ...delivered[0], id: undefined, client: undefined },
          { id: undefined, kind: 'message', content: REASON, status: 'PENDING', client: undefined },
        );
        assert.equal(delivered[0].id, sendBackTurnId);
        assert.equal(await statusOf(runTaskId), 'OPEN', 'the task stays open');
        const decided = (await sql.query<{ decision: string; request: string; note: string }>(
          `SELECT "decision"::text AS decision, "request_id" AS request, "note"
             FROM "task_owner_decision" WHERE "task_id" = $1`,
          [runTaskId],
        )).rows;
        assert.deepEqual(decided, [{ decision: 'SEND_BACK', request: firstRequestId, note: REASON }]);
        assert.equal((await confirmations.read(ownerId, runTaskId)).waiting, null, 'answered, so not waiting');
        assert.equal(await waitingOn(runSessionId), 0, 'and the row goes dark');
      });

    // (9) -----------------------------------------------------------------------------------------
    let secondRequestId = '';
    await t.test('the next turn that ends successfully asks again, and the old report cannot be answered',
      async () => {
        await runTurn(sendBackTurnId, 2, SECOND_REPORT);
        await runnerApi.turnComplete({ id: runnerId }, runSessionId, {
          turnId: sendBackTurnId,
          status: SharedRunStatus.SUCCEEDED,
        } as never);
        const view = await confirmations.read(ownerId, runTaskId);
        assert.ok(view.waiting, 'waiting on the owner again');
        assert.notEqual(view.waiting.requestId, firstRequestId, 'about the new report');
        assert.equal(view.waiting.report?.text, SECOND_REPORT);
        assert.equal(view.waiting.sessionId, runSessionId);
        secondRequestId = view.waiting.requestId;
        assert.equal(await waitingOn(runSessionId), 1);

        const old = await refusedWith(
          userDoor.decide(owner, runTaskId, undefined, decide({ decision: 'CONFIRM', requestId: firstRequestId })),
          ConflictException,
        );
        assert.equal(old.code, 'OWNER_CONFIRMATION_STALE');
        const aroundTheCard = await refusedWith(
          userDoor.decide(owner, runTaskId, undefined, decide({ decision: 'CONFIRM' })),
          ConflictException,
        );
        assert.equal(aroundTheCard.code, 'OWNER_CONFIRMATION_STALE', 'the panel does not answer a waiting run');
        assert.equal(await decisionsOf(runTaskId), 1, 'neither wrote a row');
        assert.equal(await statusOf(runTaskId), 'OPEN');
      });

    // (10) ----------------------------------------------------------------------------------------
    await t.test('the owner confirms the new report, and the task is DONE with both decisions kept', async () => {
      const receipt = await userDoor.decide(owner, runTaskId, undefined, decide({
        decision: 'CONFIRM',
        requestId: secondRequestId,
      }));
      assert.equal(receipt.completed, true);
      assert.equal(receipt.sessionId, runSessionId);
      assert.equal(await statusOf(runTaskId), 'DONE');
      assert.equal(await waitingOn(runSessionId), 0, 'the row goes dark');

      const view = await confirmations.read(ownerId, runTaskId);
      assert.equal(view.waiting, null);
      assert.deepEqual(
        view.decisions.map((each) => ({
          decision: each.decision,
          sessionId: each.sessionId,
          report: each.report?.text ?? null,
          byType: each.decidedByType,
        })),
        [
          { decision: 'SEND_BACK', sessionId: runSessionId, report: FIRST_REPORT, byType: 'USER' },
          { decision: 'CONFIRM', sessionId: runSessionId, report: SECOND_REPORT, byType: 'USER' },
        ],
      );
      const later = await refusedWith(
        userDoor.decide(owner, runTaskId, undefined, decide({ decision: 'SEND_BACK', requestId: secondRequestId, note: REASON })),
        ConflictException,
      );
      assert.equal(later.code, 'OWNER_CONFIRMATION_TASK_SETTLED');
    });
  });

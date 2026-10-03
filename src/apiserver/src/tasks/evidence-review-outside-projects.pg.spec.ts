/**
 * Outside a project, the session that dispatched a task settles it on its run's evidence, and the
 * owner is asked only when that session does not (the B line, `evidence-review.ts`), against real
 * PostgreSQL:
 *
 *   (1) EVIDENCE_JUDGMENT is declarable in no project by a session that files the work, at every
 *       write door, and still refused to a write no session makes;
 *   (2) each revision is delivered to the dispatching session once, as a platform turn: the block
 *       queued is the block handed out, a replayed submission adds nothing, and the run is told
 *       nothing; a failed one is re-sent as itself, and nobody else may take the key;
 *   (3) while that session holds it nobody is asked — not the owner, not any other conversation;
 *   (4) the dispatching session decides it with `task_evidence_decide`, the run still cannot, and a
 *       CONFIRM settles the task;
 *   (5) 30 minutes after the delivery the owner's card is drawn in the dispatching session and
 *       counted there, and the owner's press settles it;
 *   (6) a dispatching session that has ended stops holding at once, and one that has ended before the
 *       revision arrives is not handed it;
 *   (7) a dispatching session in Trash: the card moves to the task's run, decided in the dispatching
 *       session's name;
 *   (8) a send-back leaves the task open, and the next revision is delivered and held again;
 *   (9) a task in no project that no session dispatched is read exactly as before.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/evidence-review-outside-projects.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BadRequestException, ForbiddenException, type HttpException } from '@nestjs/common';
import {
  CreatorType,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
  type Prisma,
} from '@prisma/client';
import { Client } from 'pg';
import { uuidToBase62 } from '@orbit/shared';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { countOwnerDecisionsBySession, readOwnerDecisionSignals } from '../projects/owner-decision-signal';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { assertClientTurnIdNotReserved } from '../sessions/watch-turn-key';
import { EvidenceReviewService } from './evidence-review.service';
import {
  confirmationReviewRetryTurnId,
  isConfirmationReviewContentTurn,
  queuedConfirmationReviewContent,
} from './owner-confirmation-review-turn';
import { readPendingEvidenceJudgments, type PendingEvidenceJudgment } from './pending-evidence-judgments';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const PREFIX = 'evidence-review:v1:';
const WINDOW_MS = 30 * 60_000;
const STANDARD = 'npm test passes and the report names the file it wrote';

suite('outside a project the dispatching session settles the evidence, and the owner covers it',
  { timeout: 300_000 }, async (t) => {
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
    const reviews = new EvidenceReviewService(prisma, sessions);
    const evidence = new TaskCompletionEvidenceService(prisma, tasks, undefined, realtime, reviews);
    const runnerApi = new RunnerApiController(
      prisma,
      queue,
      realtime,
      {} as never,
      {} as never,
      { expand: async (_owner: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _id: string, content?: string) => content } as never,
      undefined,
      undefined,
      tasks,
      undefined,
      sessions,
    );

    // ── the account ───────────────────────────────────────────────────────────────────────────
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `owner-${ownerId}@invalid.test`, name: 'Owner', passwordHash: 'x' },
    });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: 'evidence-review-runner',
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: [],
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: 'evidence-review', enabled: true, canCreateTasks: true },
    });
    const agent = { type: CreatorType.AGENT, id: workspaceId };
    const theOwner = { type: CreatorType.USER, id: ownerId };

    /** A conversation of this account; with `taskId`, a run of that task. */
    async function conversation(title: string, over: Partial<Prisma.SessionUncheckedCreateInput> = {}) {
      const id = randomUUID();
      await db.session.create({
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
          numTurns: 1,
          startedAt: new Date(),
          runtimeSessionId: randomUUID(),
          ...over,
        },
      });
      return id;
    }

    interface Work { taskId: string; run: string }

    /** A task the session files in no project, through the runner's own create door, and its run. */
    async function dispatched(title: string, dispatcher: string): Promise<Work> {
      const created = await tasks.create(ownerId, {
        title,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        acceptanceCriteria: STANDARD,
        assigneeId: workspaceId,
        autoRunWhenReady: false,
      } as never, agent, dispatcher);
      const run = await conversation(`${title} — run`, { taskId: created.id, startsTaskWork: true });
      await db.toolCall.create({
        data: {
          sessionId: run, name: 'Bash', toolUseId: `toolu_${run.slice(0, 8)}`,
          input: { command: 'npm test', description: 'the suite' }, isError: false,
        },
      });
      return { taskId: created.id, run };
    }

    /** The run submits a revision quoting the task's own standard. */
    async function submit(work: Work, claim: string, key: string = randomUUID()) {
      return evidence.submit(ownerId, work.taskId, agent, {
        sourceSessionId: work.run,
        evidence: {
          claim,
          criterion: { key: uuidToBase62(work.taskId), text: STANDARD },
          checks: [{ kind: 'TOOL_CALL', ref: `toolu_${work.run.slice(0, 8)}`, command: 'npm test', succeeded: true }],
          gaps: ['the report was not opened'],
        },
        idempotencyKey: key,
      });
    }

    async function latestEvidence(taskId: string) {
      return db.taskCompletionEvidence.findFirstOrThrow({ where: { taskId }, orderBy: { revision: 'desc' } });
    }

    async function deliveredTo(sessionId: string) {
      return db.conversationTurn.findMany({
        where: { sessionId, clientTurnId: { startsWith: PREFIX } },
        orderBy: { seq: 'asc' },
      });
    }

    /** The owner's evidence card in this conversation, if any, as a client's filter finds it. */
    async function cardIn(sessionId: string, taskId: string, readAt?: Date) {
      const reader = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { id: true, taskId: true } });
      const queue = await readPendingEvidenceJudgments(db, ownerId, reader, readAt);
      return queue.pending.find((row) => row.taskId === taskId && row.ownerCard?.sessionId === sessionId)
        ?? null;
    }

    async function anywhere(taskId: string, readers: readonly string[], readAt?: Date): Promise<string[]> {
      const found: string[] = [];
      for (const reader of readers) {
        const session = await db.session.findUniqueOrThrow({ where: { id: reader }, select: { id: true, taskId: true } });
        const queue = await readPendingEvidenceJudgments(db, ownerId, session, readAt);
        if (queue.pending.some((row: PendingEvidenceJudgment) => row.taskId === taskId)) found.push(reader);
      }
      return found;
    }

    async function waitingOn(sessionId: string): Promise<number> {
      return (await countOwnerDecisionsBySession(db, ownerId, { sessionIds: [sessionId] })).get(sessionId) ?? 0;
    }

    async function status(taskId: string) {
      return (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } })).status;
    }

    /** Move a delivery back in time: the read's clock is the only clock this rule has. */
    async function age(sessionId: string, evidenceId: string, ms: number) {
      await sql.query(
        `UPDATE "conversation_turn" SET "created_at" = "created_at" - ($3 || ' milliseconds')::interval
          WHERE "session_id" = $1::uuid AND "client_turn_id" = $2`,
        [sessionId, `${PREFIX}${evidenceId}`, String(ms)],
      );
    }

    const bystander = await conversation('another conversation of the account');

    // (1) -----------------------------------------------------------------------------------------
    await t.test('(1) a session may declare EVIDENCE_JUDGMENT in no project; a write no session makes may not',
      async () => {
        const dispatcher = await conversation('files work, (1)');
        const single = await dispatched('declared from a session', dispatcher);
        const row = await db.task.findUniqueOrThrow({ where: { id: single.taskId } });
        assert.equal(row.projectId, null);
        assert.equal(row.completionCriterion, 'EVIDENCE_JUDGMENT');
        assert.equal(row.creatorSessionId, dispatcher);

        const batch = await tasks.createMany(ownerId, { tasks: [
          { title: 'batch, from a session', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: STANDARD },
        ] } as never, agent, dispatcher);
        assert.equal(batch.length, 1);

        // The update door, on a row the session filed: EXECUTABLE to EVIDENCE_JUDGMENT, in no project.
        const executable = await tasks.create(ownerId, {
          title: 'executable first', completionCriterion: 'EXECUTABLE',
          acceptanceCommand: 'npm test', acceptanceExpectedExitCode: 0,
        } as never, agent, dispatcher);
        await tasks.update(ownerId, executable.id, {
          completionCriterion: 'EVIDENCE_JUDGMENT',
          acceptanceCommand: null,
          acceptanceExpectedExitCode: null,
          acceptanceCriteria: STANDARD,
          completionCriterionOverrideReason: 'a reviewer reads the report; no exit code says it',
        } as never, dispatcher);
        assert.equal((await db.task.findUniqueOrThrow({ where: { id: executable.id } })).completionCriterion,
          'EVIDENCE_JUDGMENT');

        // No session: nobody would be handed its evidence, so the refusal stands.
        let refusal: { code?: string; message?: string } | null = null;
        try {
          await tasks.create(ownerId, { title: 'the owner’s own', completionCriterion: 'EVIDENCE_JUDGMENT' } as never);
        } catch (error) {
          assert.ok(error instanceof BadRequestException, `expected a 400, got ${error}`);
          refusal = (error as HttpException).getResponse() as { code?: string; message?: string };
        }
        assert.equal(refusal?.code, 'EVIDENCE_JUDGMENT_REQUIRES_PROJECT');
        assert.match(refusal?.message ?? '', /filed from a session/);
      });

    // (2)–(4) ---------------------------------------------------------------------------------------
    const dispatcher = await conversation('files work and reviews it');
    const work = await dispatched('rename the September invoices', dispatcher);

    await t.test('(2) the revision is delivered to the dispatching session once, and its block says what to do',
      async () => {
        const receipt = await submit(work, 'renamed all 38 and the suite passes', 'first');
        assert.equal(receipt.revision, '1');
        const revision = await latestEvidence(work.taskId);
        const turns = await deliveredTo(dispatcher);
        assert.equal(turns.length, 1, 'one platform turn, in the dispatching session');
        const [turn] = turns;
        assert.equal(turn.clientTurnId, `${PREFIX}${revision.id}`);
        assert.equal(turn.content, '', 'nobody’s words: the block is rendered when it is handed out');
        assert.equal(turn.status, 'PENDING');
        assert.equal(turn.senderSessionId, null, 'not a message from another session');
        assert.deepEqual(await deliveredTo(work.run), [], 'the run that did the work is told nothing');

        // A retried submission replays the revision, and the delivery with it.
        await submit(work, 'renamed all 38 and the suite passes', 'first');
        assert.equal((await deliveredTo(dispatcher)).length, 1, 'a replayed submission delivers nothing new');

        // The block queued is the block handed out, read by the same function.
        const queued = (await sessions.listQueuedTurns(ownerId, dispatcher)) as unknown as Array<{
          turnId: string; content: string; authoredByOrbit?: true;
        }>;
        const listed = queued.find((each) => each.turnId === turn.id);
        assert.ok(listed, 'the queued delivery is listed');
        assert.equal(listed.authoredByOrbit, true, 'Orbit wrote it, so nothing goes back to a composer');
        const block = listed.content;
        assert.match(block, new RegExp(
          `<orbit-evidence-review task="${uuidToBase62(work.taskId)}" revision="1" run-session="${uuidToBase62(work.run)}" due-at="`,
        ));
        const dueAt = new Date(turn.createdAt.getTime() + WINDOW_MS).toISOString().slice(0, 19);
        assert.ok(block.includes(`due-at="${dueAt}Z"`), 'due 30 minutes after the delivery');
        assert.ok(block.includes(`What settles it (the task's acceptance criteria, first 2000 characters): ${STANDARD}`));
        assert.ok(block.includes('What the run claims: renamed all 38 and the suite passes'));
        assert.ok(block.includes('What it says it did not establish: the report was not opened'));
        assert.match(block, new RegExp(`- TOOL_CALL toolu_${work.run.slice(0, 8)}: `));
        assert.ok(block.includes(`task_evidence_decide (taskId "${uuidToBase62(work.taskId)}", evidenceRevision "1")`));
        assert.match(block, /SEND_BACK/);
        assert.match(block, /the owner decides it on their card after due-at/);
        assert.equal(await queuedConfirmationReviewContent(db, turn.clientTurnId), block);

        // What the runner's claim does: the next queued turn of the session, handed out.
        await db.session.update({ where: { id: dispatcher }, data: { status: RunStatus.RUNNING } });
        const handed = await (runnerApi as unknown as {
          dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: null): Promise<{ turnId: string; content?: string } | null>;
        }).dequeueTurn(dispatcher, runnerId, null);
        assert.equal(handed?.turnId, turn.id);
        assert.equal(handed?.content, block, 'the same bytes are handed to the engine');

        // A failed delivery turn is re-sent as itself, and no caller may take the key.
        assert.equal(isConfirmationReviewContentTurn(turn.clientTurnId), true);
        const retry = confirmationReviewRetryTurnId(turn.clientTurnId, 'n1');
        assert.equal(retry, `${PREFIX}${revision.id}:retry:n1`);
        assert.equal(await queuedConfirmationReviewContent(db, retry!), block, 'the re-send says the same');
        assert.throws(() => assertClientTurnIdNotReserved(`${PREFIX}${revision.id}`), BadRequestException);
      });

    await t.test('(3) while the dispatching session holds it, nobody is asked', async () => {
      assert.equal(await cardIn(dispatcher, work.taskId), null, 'no owner card in the dispatching session');
      assert.deepEqual(await anywhere(work.taskId, [dispatcher, bystander, work.run]), [],
        'and none in any other conversation: the revision is not broadcast');
      assert.equal(await waitingOn(dispatcher), 0);
      assert.equal(await waitingOn(bystander), 0);
      // 29 minutes on, still held.
      const almost = new Date(Date.now() + WINDOW_MS - 60_000);
      assert.equal(await cardIn(dispatcher, work.taskId, almost), null);
    });

    await t.test('(4) the dispatching session decides it; the run still cannot; CONFIRM settles the task', async () => {
      let refused: { code?: string } | null = null;
      try {
        await evidence.decide(ownerId, work.taskId, agent, {
          decidingSessionId: work.run, evidenceRevision: '1', decision: 'CONFIRM',
        });
      } catch (error) {
        assert.ok(error instanceof ForbiddenException, `expected a 403, got ${error}`);
        refused = (error as HttpException).getResponse() as { code?: string };
      }
      assert.equal(refused?.code, 'EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION');
      assert.equal(await status(work.taskId), TaskStatus.OPEN);

      const decision = await evidence.decide(ownerId, work.taskId, agent, {
        decidingSessionId: dispatcher, evidenceRevision: '1', decision: 'CONFIRM',
      });
      assert.equal(decision.decision, 'CONFIRM');
      assert.equal(await status(work.taskId), TaskStatus.DONE, 'the reviewer’s CONFIRM settled it');
      // Even past the window, a decided revision is nobody's question.
      assert.equal(await cardIn(dispatcher, work.taskId, new Date(Date.now() + 2 * WINDOW_MS)), null);
      // And a block handed out now says so rather than asking again.
      const turn = (await deliveredTo(dispatcher))[0];
      assert.match(await queuedConfirmationReviewContent(db, turn.clientTurnId),
        /was decided CONFIRM by a session at .*\nNothing to decide; end your turn\./);
    });

    // (5) -------------------------------------------------------------------------------------------
    await t.test('(5) 30 minutes after delivery the owner’s card is drawn and counted where it was dispatched',
      async () => {
        const reviewer = await conversation('files work, then is busy elsewhere');
        const late = await dispatched('archive the August receipts', reviewer);
        await submit(late, 'archived all 51');
        const revision = await latestEvidence(late.taskId);
        assert.equal(await cardIn(reviewer, late.taskId), null, 'held at first');

        // The read's clock alone ends it: half a minute past the window.
        const past = new Date(Date.now() + WINDOW_MS + 30_000);
        const card = await cardIn(reviewer, late.taskId, past);
        assert.ok(card, 'past the window the owner is asked, in the dispatching session');
        assert.deepEqual(card.ownerCard, { sessionId: reviewer, decidingSessionId: reviewer });
        assert.equal(card.independence.independent, true);
        assert.equal(card.decidability.decidable, true);
        assert.deepEqual(await anywhere(late.taskId, [bystander, late.run], past), [],
          'in that conversation and no other');

        // The badge counts it once the delivery is that old — on the same conversation, and only there.
        assert.equal(await waitingOn(reviewer), 0);
        await age(reviewer, revision.id, WINDOW_MS + 30_000);
        assert.equal(await waitingOn(reviewer), 1);
        const signals = await readOwnerDecisionSignals(db, ownerId, { sessionIds: [reviewer] });
        assert.deepEqual(signals, [{ sessionId: reviewer, projectId: null, count: 1, kind: 'EVIDENCE_DECISION' }]);
        const listed = (await sessions.list(ownerId, { view: 'open' }) as unknown as Array<{
          id: string; pendingApprovals: number; waitingKind?: string | null;
        }>).find((each) => each.id === reviewer);
        assert.equal(listed?.pendingApprovals, 1, 'the conversation’s row is lit');
        assert.equal(await waitingOn(late.run), 0);

        // The owner presses the card: the decision is the dispatching session's, and settles the task.
        await evidence.decide(ownerId, late.taskId, theOwner, {
          decidingSessionId: card.ownerCard!.decidingSessionId, evidenceRevision: '1', decision: 'CONFIRM',
        });
        assert.equal(await status(late.taskId), TaskStatus.DONE);
        assert.equal(await waitingOn(reviewer), 0, 'and the row goes dark');
      });

    // (6) -------------------------------------------------------------------------------------------
    await t.test('(6) a dispatching session that has ended holds nothing, and one already ended is not handed it',
      async () => {
        const reviewer = await conversation('files work, then fails');
        const ended = await dispatched('reconcile the ledger', reviewer);
        await submit(ended, 'reconciled');
        assert.equal(await cardIn(reviewer, ended.taskId), null, 'held while it is open');
        await db.session.update({ where: { id: reviewer }, data: { status: RunStatus.FAILED } });
        const card = await cardIn(reviewer, ended.taskId);
        assert.ok(card, 'its end hands the card to the owner at once, without the window');
        assert.equal(await waitingOn(reviewer), 1);

        // Ended before the revision arrives: nothing is delivered, and the owner is asked at once.
        const gone = await conversation('files work and is completed', {});
        const unheld = await dispatched('close the books', gone);
        await db.session.update({ where: { id: gone }, data: { status: RunStatus.SUCCEEDED, completedAt: new Date() } });
        const turnsBefore = await db.conversationTurn.count({ where: { sessionId: gone } });
        await submit(unheld, 'closed');
        assert.equal(await db.conversationTurn.count({ where: { sessionId: gone } }), turnsBefore,
          'nothing is filed on a conversation that has ended');
        assert.ok(await cardIn(gone, unheld.taskId), 'the card is drawn in it');
        assert.equal(await waitingOn(gone), 0, 'but a conversation filed away lights no badge');
      });

    // (7) -------------------------------------------------------------------------------------------
    await t.test('(7) with the dispatching session in Trash the card moves to the run, decided in its name',
      async () => {
        const trashed = await conversation('files work, then is deleted');
        const moved = await dispatched('rotate the staging keys', trashed);
        await submit(moved, 'rotated');
        await db.session.update({ where: { id: trashed }, data: { deletedAt: new Date() } });

        assert.equal(await cardIn(trashed, moved.taskId), null, 'no card in a conversation in Trash');
        const card = await cardIn(moved.run, moved.taskId);
        assert.ok(card, 'the card is drawn in the task’s run');
        assert.deepEqual(card.ownerCard, { sessionId: moved.run, decidingSessionId: trashed });
        assert.equal(card.independence.independent, true, 'decided as the dispatching session, which did no work');
        assert.equal(await waitingOn(moved.run), 1);
        assert.equal(await waitingOn(trashed), 0);

        // The door is unchanged: in the run's own name it is refused …
        let refused: { code?: string } | null = null;
        try {
          await evidence.decide(ownerId, moved.taskId, theOwner, {
            decidingSessionId: moved.run, evidenceRevision: '1', decision: 'CONFIRM',
          });
        } catch (error) {
          assert.ok(error instanceof ForbiddenException);
          refused = (error as HttpException).getResponse() as { code?: string };
        }
        assert.equal(refused?.code, 'EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION');
        // … and in the name the card carries it is taken.
        await evidence.decide(ownerId, moved.taskId, theOwner, {
          decidingSessionId: card.ownerCard!.decidingSessionId, evidenceRevision: '1', decision: 'CONFIRM',
        });
        assert.equal(await status(moved.taskId), TaskStatus.DONE);
        assert.equal(await waitingOn(moved.run), 0);
      });

    // (8) -------------------------------------------------------------------------------------------
    await t.test('(8) a send-back leaves the task open, and the next revision is delivered and held again',
      async () => {
        const reviewer = await conversation('files work and sends it back');
        const again = await dispatched('migrate the wiki images', reviewer);
        await submit(again, 'migrated');
        await evidence.decide(ownerId, again.taskId, agent, {
          decidingSessionId: reviewer, evidenceRevision: '1', decision: 'SEND_BACK',
          note: 'show the count of images before and after',
        });
        assert.equal(await status(again.taskId), TaskStatus.OPEN);
        assert.equal(await cardIn(reviewer, again.taskId, new Date(Date.now() + 2 * WINDOW_MS)), null,
          'an answered revision is nobody’s question');
        await submit(again, 'migrated: 412 before, 412 after');
        const second = await latestEvidence(again.taskId);
        assert.equal(second.revision, 2n);
        const turns = await deliveredTo(reviewer);
        assert.deepEqual(turns.map((turn) => turn.clientTurnId).sort(),
          [`${PREFIX}${(await db.taskCompletionEvidence.findFirstOrThrow({
            where: { taskId: again.taskId, revision: 1n },
          })).id}`, `${PREFIX}${second.id}`].sort(), 'each revision is delivered on its own turn');
        assert.equal(await cardIn(reviewer, again.taskId), null, 'and the new one is held again');
        // The first revision's block, handed out now, points at the newer one.
        assert.match(await queuedConfirmationReviewContent(db, turns[0].clientTurnId),
          /has submitted revision 2 since this one/);
      });

    // (9) -------------------------------------------------------------------------------------------
    await t.test('(9) a task in no project that no session dispatched is read exactly as before', async () => {
      // As the population that already exists: written to the table, filed from no session.
      const taskId = randomUUID();
      await db.task.create({
        data: {
          id: taskId, ownerId, title: 'the owner’s standalone task', creatorType: CreatorType.USER,
          creatorId: ownerId, assigneeId: workspaceId, status: TaskStatus.IN_PROGRESS,
          completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: STANDARD,
        },
      });
      const run = await conversation('standalone run', { taskId, startsTaskWork: true });
      await db.toolCall.create({
        data: {
          sessionId: run, name: 'Bash', toolUseId: `toolu_${run.slice(0, 8)}`,
          input: { command: 'npm test', description: 'the suite' }, isError: false,
        },
      });
      const turnsBefore = await db.conversationTurn.count({ where: { clientTurnId: { startsWith: PREFIX } } });
      await submit({ taskId, run }, 'done');
      assert.equal(await db.conversationTurn.count({ where: { clientTurnId: { startsWith: PREFIX } } }), turnsBefore,
        'nobody is handed it');
      const reader = await db.session.findUniqueOrThrow({ where: { id: bystander }, select: { id: true, taskId: true } });
      const row = (await readPendingEvidenceJudgments(db, ownerId, reader)).pending
        .find((each) => each.taskId === taskId);
      assert.ok(row, 'it is still on the derived read of a session that may answer it');
      assert.equal(row.ownerCard, null, 'and no conversation is named for an owner card');
      assert.equal(await waitingOn(bystander), 0);
    });
  });

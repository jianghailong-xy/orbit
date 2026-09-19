import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from './sessions.service';

/**
 * A card nobody can answer any more stops being offered as the live question.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/approvals-still-being-asked.pg.spec.ts
 *
 * THE TWO WAYS THE ASKING ENDS WITH NOBODY HAVING ANSWERED
 * ========================================================
 * An `AskUserQuestion` card is raised by an engine and answered by a person, and two things end the
 * asking without writing anything to the approval row:
 *
 *   1. the engine gives up on the tool call (`runner-go/mcp.go` polls uncapped; the deadline is the
 *      engine's and `approval` has no expiry column), and the turn runs on;
 *   2. the turn itself is reclaimed — a 4h TTL and an LRU over long-blocked turns — so the poll loop
 *      dies with it and the runtime handshake parks the conversation.
 *
 * The row outlives the question in both. A surface that goes on offering it takes a person's answer
 * and delivers it to nobody, which is worse than showing nothing — so each case asserts what the
 * browser's own read (`SessionsService.listApprovals`, the door behind
 * `GET /sessions/:id/approvals?status=PENDING`) offers, and asserts it while the question was still
 * live as the paired positive.
 *
 * THE READER THAT IS NOT THE TURN — AND THE ONE THAT WAS INVISIBLE
 * ===============================================================
 * Both cases above end the asking by ending the turn, which is right for every card whose reader IS
 * the turn. A runner-hosted job is the reader that outlives it (`approval.background_job_id`,
 * migration 0291; the reap and the reasoning are in `abandoned-approvals.ts`), and the surfaces
 * went on reading "the engine is not running" as "nothing is being asked": the row stayed PENDING,
 * the job stayed up and polling, and the owner was shown nothing to answer. The third case is that
 * reading, with the turn's card parked beside it as the negative control — one conversation, one
 * session status, two cards, and the reader each names deciding which of them is still a question.
 * It asserts all three of the reads that were blind: the door, the session list's
 * `pendingApprovals`, and the rail's per-workspace `needsYou`.
 *
 * WHY THIS FILE IS HERE
 * =====================
 * Until 2026-09-10 these two cases were half of `tasks/coordinator-evidence-unanswered.pg.spec.ts`,
 * asked over the completion-evidence card a coordinator conversation was told to raise. That card is
 * gone — the evidence question is drawn from the pending read, and no conversation is told to ask
 * it — and what these cases hold was never about evidence, so they moved here with it taken out.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

/** A collaborator this file's question is not about: every call answers undefined. */
function inert<T>(): T {
  return new Proxy({}, { get: () => () => undefined }) as T;
}

interface Stack {
  db: PrismaClient;
  /** The runner's permission tool, as the control plane receives it. */
  runner: RunnerApiController;
  /** The browser's session doors — including the approval listing this file is about. */
  sessions: SessionsService;
}

/**
 * The production wiring, over one client.
 *
 * The stand-ins are the notification transports and nothing else: a realtime publish, a push
 * notification and a queue nudge are how other processes hear about a row, never how the row is
 * read, so a proxy for them removes no check this file makes.
 */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = inert<ConstructorParameters<typeof SessionsService>[2]>();
  const queue = inert<ConstructorParameters<typeof SessionsService>[1]>();
  return {
    db,
    runner: new RunnerApiController(prisma, queue, realtime, inert(), inert(), inert()),
    sessions: new SessionsService(prisma, queue, realtime),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  /** The workspace the conversation runs in — the rail tallies `needsYou` per workspace. */
  workspaceId: string;
  /** The conversation the card is raised in. */
  sessionId: string;
}

/** One conversation on a heartbeating runner, parked between turns with its opening prompt on it. */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@approvals-still-being-asked.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
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
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `${label} 会话`,
      prompt: `${label} 会话`,
      provider: 'claude',
      providerBuiltin: true,
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(sessionId),
      kind: 'message',
      content: `${label} 会话`,
      status: 'ANSWERED',
    },
  });
  return { ownerId, runnerId, workspaceId, sessionId };
}

/** The tool-use id the card is raised under, one per fixture. */
const askToolUseId = (f: Fixture) => `toolu_ask_${f.sessionId}`;

/** The runner-hosted job this file's second kind of asker is, one per fixture. */
const backgroundJobIdOf = (f: Fixture) => `bgj_${f.sessionId}`;

/** What the engine asks with: one question, two options, and nothing behind it but the asking. */
const QUESTION = {
  questions: [{
    question: 'Which branch should this work land on?',
    header: 'Branch',
    options: [
      { label: 'main', description: 'Merge it now.' },
      { label: 'release', description: 'Hold it for the release branch.' },
    ],
    multiSelect: false,
  }],
};

/**
 * The runner claims the turn and the engine starts it.
 *
 * Written on the row rather than driven through the runner door, and named so the shortcut is
 * visible. The status matters to this file because it is half of what says a card can still be
 * answered — a question can only be live while something is generating.
 */
async function theRunnerTakesTheTurn(db: PrismaClient, f: Fixture): Promise<void> {
  await db.session.update({
    where: { id: f.sessionId },
    data: { status: RunStatus.RUNNING, engineTurnActive: true },
  });
}

/**
 * The model asks the person, through the door `--permission-prompt-tool` posts to.
 *
 * The `tool_call` row beside it is what the runner's own event ingestion writes when the tool_use
 * event lands (`runner-api.controller.ts`), and it is written here for the same reason: it is the
 * row that later carries the engine's result, and "this call already has a result" is the only
 * committed fact that tells a dead card from a live one while the turn runs on.
 */
async function theModelAsks(stack: Stack, f: Fixture): Promise<string> {
  const raised = await stack.runner.createApproval(
    { id: f.runnerId },
    f.sessionId,
    { toolName: 'AskUserQuestion', input: QUESTION, toolUseId: askToolUseId(f) },
  );
  await stack.db.toolCall.create({
    data: {
      sessionId: f.sessionId,
      name: 'AskUserQuestion',
      toolUseId: askToolUseId(f),
      input: QUESTION as unknown as object,
      startedAt: new Date(),
    },
  });
  return raised.id;
}

/**
 * The engine gives up on the tool call and moves on, which writes exactly one thing: the result.
 *
 * Mirrors the ingestion's own update — output, `is_error`, `finished_at`, matched on
 * (sessionId, toolUseId) — because that is the only trace this failure leaves. The approval row is
 * deliberately not touched: nothing in the product writes to it here, and a spec that tidied it up
 * would be testing a cleanup nobody performs.
 */
async function theEngineAbandonsTheCall(db: PrismaClient, f: Fixture): Promise<void> {
  const updated = await db.toolCall.updateMany({
    where: { sessionId: f.sessionId, toolUseId: askToolUseId(f) },
    data: {
      output: { content: 'the user did not answer in time' },
      isError: true,
      finishedAt: new Date(),
    },
  });
  assert.equal(updated.count, 1, 'the abandoned call was never recorded against its tool_use id');
}

/**
 * The engine's turn is reclaimed while the card is still open.
 *
 * What the control plane sees of it is a runtime handshake, which clears `engine_turn_active`, and
 * a conversation that parks. Nothing is written to the approval and nothing answers the tool call:
 * this failure is the one that leaves NO trace on the question at all, which is why it is a separate
 * case from the one above.
 */
async function theTurnIsReclaimed(db: PrismaClient, f: Fixture): Promise<void> {
  await db.session.update({
    where: { id: f.sessionId },
    data: { status: RunStatus.AWAITING_INPUT, engineTurnActive: false },
  });
}

/**
 * A runner-hosted job claims itself as the reader of the card it is asking.
 *
 * The other kind of asker, and the one that makes the turn rule above false: the job goes on
 * running — and polling — after the turn that started it ends, because that is what hosting the
 * process on the runner is FOR. The runner exports the job's id to the job's own environment
 * (`ORBIT_BG_JOB_ID`), the CLI hands it back on the create request, and the row carries it
 * (`approval.background_job_id`, migration 0291). `Session.running_bg_shells` is where the runner
 * reports which of those processes are still up.
 *
 * No `tool_call` row beside this one, deliberately: the ask was made through the runner's own MCP
 * server, not by an engine tool_use, so there is no call for the engine to have abandoned and
 * nothing on the row that could pair with one. What the card is read by is the job.
 */
async function theJobAsks(stack: Stack, f: Fixture): Promise<string> {
  const raised = await stack.runner.createApproval(
    { id: f.runnerId },
    f.sessionId,
    {
      toolName: 'orbit_blocker_resolve',
      input: { projectId: f.sessionId, blockerId: f.sessionId, reason: 'the condition is gone' },
      toolUseId: `toolu_job_${f.sessionId}`,
      backgroundJobId: backgroundJobIdOf(f),
    },
  );
  return raised.id;
}

/** The job is up, as the runner reports it: its id is in the session's live shell set. */
async function theJobIsUp(db: PrismaClient, f: Fixture): Promise<void> {
  await db.session.update({
    where: { id: f.sessionId },
    data: { runningBgShells: [backgroundJobIdOf(f)] },
  });
}

/** The job ends — the runner reports its id gone, and the poll loop goes with the process. */
async function theJobGoes(db: PrismaClient, f: Fixture): Promise<void> {
  await db.session.update({ where: { id: f.sessionId }, data: { runningBgShells: [] } });
}

/** What the browser is offered when it asks for this conversation's pending approvals. */
function cardsOffered(stack: Stack, f: Fixture) {
  return stack.sessions.listApprovals(f.ownerId, f.sessionId, 'PENDING');
}

/** The ids it is offered, sorted: the listing orders by `created_at`, which ties for cards filed
 *  in the same millisecond, so a case holding two of them compares the set rather than a sequence. */
async function cardsOfferedById(stack: Stack, f: Fixture): Promise<string[]> {
  return (await cardsOffered(stack, f)).map((card) => card.id).sort();
}

/** The conversation's row as the session list serves it — the other read the count is on. */
async function listedRow(stack: Stack, f: Fixture) {
  const rows = await stack.sessions.list(f.ownerId, {});
  const row = rows.find((s: { id: string }) => s.id === f.sessionId);
  assert.ok(row, 'the conversation is in this owner’s Open list');
  return row as { id: string; status: RunStatus; pendingApprovals: number };
}

/** The per-workspace tally the rail draws, for the workspace this conversation runs in. */
async function workspaceTally(stack: Stack, f: Fixture) {
  const rows = await stack.sessions.workspaceSessionCounts(f.ownerId);
  return rows.find((r) => r.workspaceId === f.workspaceId) ?? null;
}

test('the engine abandons the card: it stops being offered, and the row is left as it was',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack.db, 'abandoned');
      await theRunnerTakesTheTurn(stack.db, f);
      const approvalId = await theModelAsks(stack, f);

      // The paired positive: while the turn is running and the call has no result, this IS the
      // live question, and the browser is offered it.
      const live = await cardsOffered(stack, f);
      assert.deepEqual(
        live.map((card) => card.id), [approvalId],
        'the card was not offered while the question was still live',
      );
      assert.equal(live[0]!.toolName, 'AskUserQuestion');

      await theEngineAbandonsTheCall(stack.db, f);

      // Nothing was written to the approval — the row is still PENDING, and the conversation is
      // still generating, so the ONLY thing that changed is the committed fact that the call this
      // card was raised for already has its result.
      const row = await stack.db.approval.findUniqueOrThrow({ where: { id: approvalId } });
      assert.equal(row.status, 'PENDING');
      assert.equal(row.decidedAt, null);
      assert.equal(
        (await stack.db.session.findUniqueOrThrow({ where: { id: f.sessionId } })).status,
        RunStatus.RUNNING,
      );
      assert.deepEqual(
        await cardsOffered(stack, f), [],
        'a card whose call the engine already answered is still offered as the live question',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the turn is reclaimed: the card goes with it, and the row is left as it was',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack.db, 'reclaimed');
      await theRunnerTakesTheTurn(stack.db, f);
      const approvalId = await theModelAsks(stack, f);
      assert.deepEqual((await cardsOffered(stack, f)).map((card) => card.id), [approvalId],
        'the card was not offered while the question was still live');

      await theTurnIsReclaimed(stack.db, f);

      // This failure leaves no mark on the question at all: the approval is untouched and the call
      // it was raised for never got a result. What says the card is dead is the conversation.
      const row = await stack.db.approval.findUniqueOrThrow({ where: { id: approvalId } });
      assert.equal(row.status, 'PENDING');
      assert.equal(
        (await stack.db.toolCall.findFirstOrThrow({
          where: { sessionId: f.sessionId, toolUseId: askToolUseId(f) },
        })).finishedAt,
        null,
        'the reclaimed turn answered the tool call, which is the other case',
      );
      assert.deepEqual(
        await cardsOffered(stack, f), [],
        'a card left behind by a reclaimed turn is still offered as the live question',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the job is still reading: the card outlives the turn, and goes when the job does',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack.db, 'job-read');
      await theRunnerTakesTheTurn(stack.db, f);
      // Two cards on one conversation, and the only thing that tells them apart is the reader each
      // names: one the turn is asking, one a runner-hosted job is asking. Both are live while the
      // turn is — asserted before anything ends, so what follows is a difference the parking made
      // and not a card that was never offered.
      const turnCard = await theModelAsks(stack, f);
      const jobCard = await theJobAsks(stack, f);
      await theJobIsUp(stack.db, f);
      assert.deepEqual(
        await cardsOfferedById(stack, f), [jobCard, turnCard].sort(),
        'a card a live job is reading was not offered while the turn was running too',
      );

      await theTurnIsReclaimed(stack.db, f);

      // The negative control, in the same conversation and the same state: "the engine is not
      // running" is true of both rows, and it is still the whole answer for the turn's card. The
      // job's card is the one thing parked beside it that it does not speak for.
      assert.equal(
        (await stack.db.approval.findUniqueOrThrow({ where: { id: turnCard } })).status, 'PENDING',
        'the reclaimed turn wrote to the card, which is not how this failure presents',
      );
      assert.deepEqual(
        await cardsOfferedById(stack, f), [jobCard],
        'the card a live runner-hosted job is still reading was taken down with the turn',
      );

      // The two counting reads a surface draws from agree with the door, and they count the same
      // one: the list row a person clicks, and the rail's tally for the workspace behind it.
      assert.equal((await listedRow(stack, f)).pendingApprovals, 1,
        'the session list does not say a question is waiting on the parked conversation');
      assert.equal((await workspaceTally(stack, f))?.needsYou ?? 0, 1,
        'the workspace rail does not light for a conversation a job is asking on');

      // The job goes. Nothing writes to the row: this listing answers what is still being ASKED,
      // and the reap that collects an unanswerable one is the other module's
      // (`abandoned-approvals.ts`), on the same fact and at the boundary that commits it.
      await theJobGoes(stack.db, f);

      assert.deepEqual(
        await cardsOffered(stack, f), [],
        'a card whose job has gone is still offered as the live question',
      );
      assert.equal((await listedRow(stack, f)).pendingApprovals, 0,
        'the session list still counts a card whose job has gone');
      assert.equal((await workspaceTally(stack, f))?.needsYou ?? 0, 0,
        'the workspace rail still lights for a card whose job has gone');
      assert.equal(
        (await stack.db.approval.findUniqueOrThrow({ where: { id: jobCard } })).status, 'PENDING',
        'the listing collected the row, which is not its job',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the approvals-still-being-asked PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});

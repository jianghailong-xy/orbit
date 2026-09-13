/**
 * A BLOCKING REQUEST GETS AN ANSWER BACK.
 *
 * A session whose edit would loosen a project's acceptance criteria is told the edit was held for
 * the account owner, and until this file nothing told it anything after that: the decision door
 * nudged the owner's clients and re-projected the project, while the session that asked — whose id
 * is the intent row's own `principal_id` — was left to poll or to be told by somebody who noticed.
 * On 2026-09-13 one such session waited seven hours. This file witnesses the reply the platform
 * sends it once the owner has decided.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/blocking-request-replies.pg.spec.ts
 *
 * THE CASES
 * =========
 *   (a) APPROVE: the proposing session, parked, gets exactly one turn that says the proposal was
 *       approved, which criteria moved to which revision, and to read them back with project_get;
 *   (b) REJECT: the same turn says nothing was applied, which revisions still stand, and carries
 *       the owner's note;
 *   (c) the reply is processed again — once more in sequence and twice at once — and nothing is
 *       sent a second time, because the intent id is the reply's key; a second decision is refused
 *       and sends nothing either;
 *   (d) the proposing session ended before the owner decided: no turn is written to it and it is
 *       not revived, the reply is one comment on the task it ran, and repeating it writes no second;
 *   (e) a proposal the owner filed without a session has nobody to reply to, and the door says so.
 *
 * Every case builds its own project, task and session. A delivered reply moves its session from
 * AWAITING_INPUT to PENDING and a project holds one pending proposal at a time, so a shared fixture
 * would let one case's reply decide the precondition of the next.
 *
 * WHY THE REPLY AND THE REPEAT ARE READ THROUGH OPTIONAL VIEWS
 * ============================================================
 * `reply` on the door's response and `replyToCriteriaProposer` on the service are what the change
 * under test adds. Typed through the real declarations, this file would not compile on the tree
 * before the change — and a compile error is not the red this file owes. Every case has to fail on
 * an assertion about a turn or a comment that is not there.
 *
 * WHY THE ENDED SESSION IS ONE THAT `resume` COULD REVIVE
 * =======================================================
 * `sessions.resume` writes to a live session and REVIVES a terminal one. A reply that went through
 * it would bring back a conversation that ended in order to tell it something, which is the wrong
 * answer (d) exists to refuse. That refusal only means something against a session resume would
 * actually revive — started, holding a runtime session id, on a runner that heartbeats — so that
 * is the session (d) ends, and (d) asserts its status did not move.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own fixture.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';
import { HttpException } from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** How every criterion says it is judged. Restated byte for byte by each edit below. */
const METHOD = 'A person reads the criterion and says whether it holds';
const FIRST = 'the session that proposed a change is told how the owner decided it';
const SECOND = 'the reply names the criteria that moved and the revision each one is at';
/** SECOND reworded: a rewording cannot be read as a tightening, so the edit is held. */
const SECOND_REWORDED = 'the reply names every criterion that moved, and the revision it is at now';
/** Dropped by the proposal, which is the loosening the classifier reads without ambiguity. */
const THIRD = 'a criterion this proposal drops';

/** What the door hands back, with the one field this change adds kept optional. */
interface ReplyView {
  channel: string;
  sessionId?: string;
  turnId?: string;
  taskId?: string;
  commentId?: string;
}

interface DecisionView {
  intentId: string;
  decision: string;
  applied: boolean;
  reply?: ReplyView | null;
}

/** The repeat entry, optional for the same reason. */
interface ReplierView {
  replyToCriteriaProposer?: (
    ownerId: string,
    projectId: string,
    intentId: string,
  ) => Promise<ReplyView | null>;
}

interface Stack {
  db: PrismaClient;
  sql: Client;
  projects: ProjectsService;
}

interface Owner {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

/** One project with three criteria, one task under it, and the session running that task. */
interface Fixture extends Owner {
  projectId: string;
  taskId: string;
  sessionId: string;
  criteria: { first: string; second: string; third: string };
}

/** A proposal as the write path filed it, and the key only the owner's side ever holds. */
interface Held {
  intentId: string;
  baselineSeal: string;
  commitToken: string;
}

/**
 * `ProjectsService` as Nest builds it: every constructor parameter resolved by its declared type.
 *
 * A hand-written argument list would decide for the code under test whether it has a session
 * service to reply through. Resolved by type, a constructor that needs a collaborator this file
 * does not provide is a failure here rather than an argument silently left out.
 */
function builtByDeclaredTypes(provided: ReadonlyMap<unknown, unknown>): ProjectsService {
  const declared = Reflect.getMetadata('design:paramtypes', ProjectsService) as unknown[] | undefined;
  assert.ok(declared, 'ProjectsService carries no constructor metadata to be resolved by');
  const args = declared.map((type) => {
    assert.ok(
      provided.has(type),
      `ProjectsService asks for ${(type as { name?: string } | undefined)?.name ?? String(type)}, `
      + 'which this spec does not provide',
    );
    return provided.get(type);
  });
  return new ProjectsService(...(args as ConstructorParameters<typeof ProjectsService>));
}

/** An HTTP refusal, unwrapped into the two things a caller acts on. */
function refusal(error: unknown): { status: number; body: Record<string, unknown> } {
  assert.ok(error instanceof HttpException, `expected an HttpException, got ${String(error)}`);
  return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
}

test('a decided criteria proposal is answered back to the session that proposed it', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // The production wiring over one client. Only the two notification transports are stand-ins:
  // what this file counts is rows, and a runner being told to look is not one.
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const stack: Stack = {
    db,
    sql,
    projects: builtByDeclaredTypes(new Map<unknown, unknown>([
      [PrismaService, prisma],
      [ProjectAcceptanceService, new ProjectAcceptanceService(prisma)],
      [SessionsService, sessions],
      [RealtimeService, realtime],
    ])),
  };

  const owner = await accountOwner(stack);

  await t.test('(a) APPROVE: the proposing session gets one turn naming the new revisions', async () => {
    const f = await fixture(stack, owner, 'approve');
    const held = await proposeAsSession(stack, f);
    assert.equal(await statusOf(stack, f.sessionId), RunStatus.AWAITING_INPUT,
      'the proposing session is parked, which is the state a reply appends a turn to');

    const decided = await decide(stack, f, held, 'APPROVE');
    assert.equal(decided.applied, true, 'the owner approved it, so the edit is in force');
    assert.equal(await revisionOf(stack, f.criteria.second), 2,
      'the reworded criterion is at its second revision now');

    const replies = await repliesOn(stack, f.sessionId);
    assert.equal(replies.length, 1, 'exactly one turn answers the proposal');
    const [reply] = replies;
    assert.match(reply.content, /\bapproved\b/i, 'it says which way the owner decided');
    assert.ok(reply.content.includes(uuidToBase62(held.intentId)),
      'it names the proposal it answers, by the id the proposer was given');
    assert.match(reply.content, /criterion 2 [^;.\n]*revision 2\b/,
      'it names the reworded criterion and the revision it is at now');
    assert.match(reply.content, /\b1 criterion was dropped\b/, 'and counts the criterion that went');
    assert.match(reply.content, /project_get/, 'and says how to read the criteria back');
    assert.ok(reply.content.includes(uuidToBase62(f.projectId)), 'naming the project to read');
    assert.equal(await statusOf(stack, f.sessionId), RunStatus.PENDING,
      'the reply is queued for the runner like any message, so the session wakes to read it');
    assert.deepEqual(await commentsOn(stack, f.taskId), [],
      'a session that can be told gets the turn, and its task is not written to as well');

    assert.equal(decided.reply?.channel, 'SESSION', 'the door says where the reply went');
    assert.equal(decided.reply?.sessionId, f.sessionId);
    assert.equal(decided.reply?.turnId, reply.id, 'and names the turn it wrote');
  });

  await t.test('(b) REJECT: the turn says nothing was applied and carries the owner’s note', async () => {
    const f = await fixture(stack, owner, 'reject');
    const held = await proposeAsSession(stack, f);
    const note = 'criterion 3 is the one this project exists for';

    const decided = await decide(stack, f, held, 'REJECT', note);
    assert.equal(decided.applied, false);
    assert.equal(await revisionOf(stack, f.criteria.second), 1, 'a refusal moves no criterion');

    const replies = await repliesOn(stack, f.sessionId);
    assert.equal(replies.length, 1, 'exactly one turn answers the proposal');
    const [reply] = replies;
    assert.match(reply.content, /\brefused\b/i, 'it says which way the owner decided');
    assert.ok(reply.content.includes(uuidToBase62(held.intentId)), 'it names the proposal');
    assert.match(reply.content, /nothing was applied/i);
    assert.match(reply.content, /criterion 2 [^;.\n]*revision 1\b/,
      'it names the criteria the proposal was about, at the revisions still in force');
    assert.match(reply.content, /criterion 3 [^;.\n]*revision 1\b/);
    assert.ok(reply.content.includes(note), 'the owner’s reason reaches the session that asked');
    assert.match(reply.content, /project_get/);
    assert.equal(decided.reply?.channel, 'SESSION');
    assert.equal(decided.reply?.turnId, reply.id);
  });

  await t.test('(c) processing the reply again sends nothing a second time', async () => {
    const f = await fixture(stack, owner, 'repeat');
    const held = await proposeAsSession(stack, f);
    await decide(stack, f, held, 'APPROVE');
    const [first, ...others] = await repliesOn(stack, f.sessionId);
    assert.ok(first, 'the decision itself sent the reply this case repeats');
    assert.deepEqual(others, []);

    const replier = (stack.projects as unknown as ReplierView).replyToCriteriaProposer;
    assert.equal(typeof replier, 'function',
      'the reply is a step that can be processed again on its own, keyed by the proposal');
    const again = (): Promise<ReplyView | null> =>
      replier!.call(stack.projects, f.ownerId, f.projectId, held.intentId);

    const sequential = await again();
    const concurrent = await Promise.all([again(), again()]);
    for (const receipt of [sequential, ...concurrent]) {
      assert.equal(receipt?.channel, 'SESSION');
      assert.equal(receipt?.turnId, first.id, 'every repeat reports the one turn already sent');
    }
    assert.deepEqual((await repliesOn(stack, f.sessionId)).map((turn) => turn.id), [first.id],
      'and no repeat wrote a second one');

    // Deciding again is the other way to "process it again", and it is refused before it could
    // send anything.
    const second = refusal(await decide(stack, f, held, 'REJECT').then(() => null, (e) => e));
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'PROJECT_CRITERIA_DECISION_ALREADY_SETTLED');
    assert.deepEqual((await repliesOn(stack, f.sessionId)).map((turn) => turn.id), [first.id]);
    assert.deepEqual(await commentsOn(stack, f.taskId), []);
  });

  await t.test('(d) a proposing session that has ended is not revived: its task gets the reply', async () => {
    const f = await fixture(stack, owner, 'ended');
    const held = await proposeAsSession(stack, f);
    await sql.query(
      `UPDATE "session" SET "status" = 'SUCCEEDED', "completed_at" = now() WHERE "id" = $1::uuid`,
      [f.sessionId],
    );

    const decided = await decide(stack, f, held, 'APPROVE');
    assert.equal(decided.applied, true);
    assert.deepEqual(await repliesOn(stack, f.sessionId), [],
      'no turn is written to a conversation that has ended');
    assert.equal(await statusOf(stack, f.sessionId), RunStatus.SUCCEEDED,
      'and it is not brought back to be told');

    const comments = await commentsOn(stack, f.taskId);
    assert.equal(comments.length, 1, 'the reply is one comment on the task that session ran');
    const [comment] = comments;
    assert.match(comment.body, /\bapproved\b/i);
    assert.ok(comment.body.includes(uuidToBase62(held.intentId)), 'naming the proposal');
    assert.match(comment.body, /criterion 2 [^;.\n]*revision 2\b/);
    assert.match(comment.body, /project_get/);
    assert.equal(decided.reply?.channel, 'TASK_COMMENT', 'the door says where the reply went');
    assert.equal(decided.reply?.taskId, f.taskId);
    assert.equal(decided.reply?.commentId, comment.id);

    const replier = (stack.projects as unknown as ReplierView).replyToCriteriaProposer;
    assert.equal(typeof replier, 'function');
    const again = (): Promise<ReplyView | null> =>
      replier!.call(stack.projects, f.ownerId, f.projectId, held.intentId);
    const receipts = [await again(), ...(await Promise.all([again(), again()]))];
    for (const receipt of receipts) {
      assert.equal(receipt?.channel, 'TASK_COMMENT');
      assert.equal(receipt?.commentId, comment.id, 'every repeat reports the one comment written');
    }
    assert.deepEqual((await commentsOn(stack, f.taskId)).map((row) => row.id), [comment.id],
      'and no repeat wrote a second one');
    assert.deepEqual(await repliesOn(stack, f.sessionId), []);
    assert.equal(await statusOf(stack, f.sessionId), RunStatus.SUCCEEDED);
  });

  await t.test('(e) a proposal the owner filed without a session has nobody to reply to', async () => {
    const f = await fixture(stack, owner, 'owner-filed');
    const held = await propose(stack, f, undefined);
    const decided = await decide(stack, f, held, 'APPROVE');
    assert.equal(decided.applied, true);
    assert.equal(decided.reply, null, 'the door says there was no proposing session to tell');
    assert.deepEqual(await repliesOn(stack, f.sessionId), []);
    assert.deepEqual(await commentsOn(stack, f.taskId), []);
  });
});

/** One account owner with a workspace on a runner that is heartbeating. */
async function accountOwner({ db }: Stack): Promise<Owner> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `replies-${ownerId}@blocking-requests.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'replies-runner',
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'replies-workspace', enabled: true },
  });
  return { ownerId, runnerId, workspaceId };
}

/**
 * A project stating three criteria through the owner's path, a task under it, and the session
 * running that task: parked at AWAITING_INPUT with its opening prompt answered, started, holding
 * a runtime session id — a conversation a message is really appended to, and one `resume` could
 * revive once it has ended.
 */
async function fixture(stack: Stack, owner: Owner, label: string): Promise<Fixture> {
  const { db } = stack;
  const projectId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  await db.project.create({
    data: { id: projectId, ownerId: owner.ownerId, title: `blocking request replies: ${label}` },
  });
  await stack.projects.update(owner.ownerId, projectId, {
    acceptanceCriteriaItems: [FIRST, SECOND, THIRD]
      .map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  const stated = await db.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId },
    orderBy: { ordinal: 'asc' },
    select: { id: true, text: true },
  });
  assert.deepEqual(stated.map((row) => row.text), [FIRST, SECOND, THIRD],
    'the owner’s first statement of the criteria is additive and lands as written');

  await db.task.create({
    data: {
      id: taskId,
      ownerId: owner.ownerId,
      projectId,
      title: `the work that proposes a criteria change (${label})`,
      creatorType: CreatorType.USER,
      creatorId: owner.ownerId,
      assigneeId: owner.workspaceId,
      status: TaskStatus.OPEN,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    },
  });
  const title = `执行任务：the work that proposes a criteria change (${label})`;
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: owner.ownerId,
      creatorId: owner.ownerId,
      taskId,
      workspaceId: owner.workspaceId,
      assignedRunnerId: owner.runnerId,
      title,
      prompt: title,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(sessionId),
      kind: 'message',
      content: title,
      status: 'ANSWERED',
    },
  });
  return {
    ...owner,
    projectId,
    taskId,
    sessionId,
    criteria: { first: stated[0]!.id, second: stated[1]!.id, third: stated[2]!.id },
  };
}

/** File the loosening edit — reword the second criterion, drop the third — as `actingSessionId`. */
async function propose(
  stack: Stack,
  f: Fixture,
  actingSessionId: string | undefined,
): Promise<Held> {
  const result = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: [
      { id: f.criteria.first, text: FIRST, verificationMethod: METHOD },
      { id: f.criteria.second, text: SECOND_REWORDED, verificationMethod: METHOD },
    ],
  } as never, actingSessionId) as { acceptanceCriteriaHold?: { intentId: string; baselineSeal: string } };
  const hold = result.acceptanceCriteriaHold;
  assert.ok(hold, 'a rewording that also drops a criterion is held, not applied');
  const { rows } = await stack.sql.query<{ commit_token: string; principal_type: string }>(
    `SELECT "commit_token", "principal_type" FROM "project_ratified_action_intent"
      WHERE "id" = $1::uuid`,
    [hold.intentId],
  );
  assert.equal(rows.length, 1, 'the hold filed a proposal row');
  assert.equal(rows[0]!.principal_type, actingSessionId ? 'AGENT' : 'OWNER',
    'and it records who asked');
  return { intentId: hold.intentId, baselineSeal: hold.baselineSeal, commitToken: rows[0]!.commit_token };
}

function proposeAsSession(stack: Stack, f: Fixture): Promise<Held> {
  return propose(stack, f, f.sessionId);
}

/** Answer as the account owner does: no acting session, the proposal's own key, its own seal. */
async function decide(
  stack: Stack,
  f: Fixture,
  held: Held,
  decision: 'APPROVE' | 'REJECT',
  note?: string,
): Promise<DecisionView> {
  return stack.projects.decideCriteriaChange(f.ownerId, f.projectId, held.intentId, {
    commitToken: held.commitToken,
    decision,
    baseSeal: held.baselineSeal,
    ...(note ? { note } : {}),
  } as never);
}

/** Every turn on the session after its opening prompt: what a reply would have added. */
async function repliesOn(
  { sql }: Stack,
  sessionId: string,
): Promise<Array<{ id: string; clientTurnId: string; content: string }>> {
  const { rows } = await sql.query<{ id: string; client_turn_id: string; content: string | null }>(
    `SELECT "id", "client_turn_id", "content" FROM "conversation_turn"
      WHERE "session_id" = $1::uuid AND "seq" > 1 ORDER BY "seq"`,
    [sessionId],
  );
  return rows.map((row) => ({ id: row.id, clientTurnId: row.client_turn_id, content: row.content ?? '' }));
}

async function commentsOn({ sql }: Stack, taskId: string): Promise<Array<{ id: string; body: string }>> {
  const { rows } = await sql.query<{ id: string; body: string }>(
    `SELECT "id", "body" FROM "task_comment" WHERE "task_id" = $1::uuid ORDER BY "created_at", "id"`,
    [taskId],
  );
  return rows;
}

async function statusOf({ db }: Stack, sessionId: string): Promise<RunStatus> {
  return (await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true } }))
    .status;
}

async function revisionOf({ db }: Stack, definitionId: string): Promise<number> {
  return (await db.projectAcceptanceCriterionDefinition.findUniqueOrThrow({
    where: { id: definitionId },
    select: { revision: true },
  })).revision;
}

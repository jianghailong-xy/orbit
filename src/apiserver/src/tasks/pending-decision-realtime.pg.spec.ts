/**
 * THE FOUR WRITES THAT MOVE A PENDING DECISION, AND THE NUDGE EACH ONE SENDS.
 *
 * A decision card is drawn from one of two reads — `GET /tasks/evidence-decisions/pending` for
 * evidence, `GET /projects/:id/acceptance/criteria-decisions/pending` for a held criteria proposal —
 * and an open page re-reads them when the control-plane stream (`GET /api/events`) tells it to, or
 * on a 20-second poll when nothing does. So how long a submission takes to become a card is decided
 * by whether the four writes that move those reads say so once they have committed:
 *
 *   evidence submitted       task.changed                         TaskCompletionEvidenceService.submit
 *   evidence decided         task.changed                         TaskCompletionEvidenceService.decide
 *   loosening edit held      project.criteria_decisions.changed   ProjectsService.update
 *   held proposal decided    project.criteria_decisions.changed   ProjectsService.decideCriteriaChange
 *
 * WHAT IS OBSERVED, AND WHY IT IS THE STREAM RATHER THAN THE CALL
 * --------------------------------------------------------------
 * The services are handed a real RealtimeService, and this file subscribes to `streamForUser(owner)`
 * — the Observable `EventsController` serves — instead of recording `publishForUser` calls. A call
 * is half of it: an event type the control-plane mapping does not forward, or one the owner-key
 * filter refuses, is published and then dropped, and a recorder would report it sent. A second
 * owner's stream is subscribed beside it and has to stay empty.
 *
 * "NOTHING WAS SENT" IS ALWAYS PAIRED
 * ----------------------------------
 * A write refused at its door (a SEND_BACK with no note, a criteria decision with the wrong key) is
 * followed in the same case by the accepted form of the same call, and the case asserts that exactly
 * ONE event arrived across the two. A refusal that published fails on the count; an accepted write
 * that did not fails on the wait. Neither can pass on a stream that was never connected.
 *
 * WHAT AN EVENT MAY NOT CARRY
 * ---------------------------
 * The event is a hint to re-read, and the owner's criteria read is the one place a proposal's
 * `commitToken` may appear. Every event is walked for a field NAMED like it, the criteria events are
 * also searched for the token itself, and a criteria event's `data` is asserted whole — the project
 * id and nothing else — so no proposal content rides along either.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/pending-decision-realtime.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  CreatorType,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
  type PrismaClient,
} from '@prisma/client';
import { Client } from 'pg';
import { type ControlEvent, uuidToBase62 } from '@orbit/shared';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { OwnerPendingCriteriaDecision } from '../projects/criteria-pending-decisions';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectsService } from '../projects/projects.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const CRITERION_TEXT = 'a pending decision reaches an open page as a control-plane nudge';
const METHOD = 'A person reads the criterion and says whether it holds';
const KEPT = 'the nudge names the project whose pending decisions moved';
const FIRST_DROPPED = 'the criterion the first loosening edit drops';
const SECOND_DROPPED = 'the criterion the second loosening edit drops';

/**
 * One task whose evidence is decided, and the independent run that decides it — the shape
 * `task-evidence-decision.pg.spec.ts` builds, cut down to what these writes read.
 */
async function evidenceFixture(db: PrismaClient, ownerId: string) {
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const criterionId = randomUUID();
  const taskId = randomUUID();
  const sessionId = randomUUID();
  const reviewTaskId = randomUUID();
  const reviewSessionId = randomUUID();

  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'realtime-runner', tokenHash: randomUUID(), status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'realtime-workspace', enabled: true },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: 'evidence that nudges' } });
  await db.projectAcceptanceCriterionDefinition.create({
    data: {
      id: criterionId,
      projectId,
      ordinal: 1,
      text: CRITERION_TEXT,
      verificationMethod: METHOD,
      // Written by the definition's own BEFORE trigger; the placeholder only has to satisfy the
      // column's 64-hex CHECK on the way in.
      contentHash: '0'.repeat(64),
    },
  });
  for (const [id, title] of [
    [taskId, 'the work whose evidence is decided'],
    [reviewTaskId, 'the run deciding it'],
  ] as const) {
    await db.task.create({
      data: {
        id,
        ownerId,
        projectId,
        title,
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        assigneeId: workspaceId,
        status: TaskStatus.OPEN,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        acceptanceCriteria: 'an independent session decides the current evidence revision',
      },
    });
  }
  for (const [id, taskFor, title] of [
    [sessionId, taskId, 'the run that did the work'],
    [reviewSessionId, reviewTaskId, 'the independent run'],
  ] as const) {
    await db.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId: taskFor,
        workspaceId,
        assignedRunnerId: runnerId,
        title,
        prompt: 'run the task',
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });
  }
  await db.toolCall.createMany({
    data: [
      { sessionId, name: 'Bash', toolUseId: 'toolu_realtime_first', input: { command: 'npm test' }, isError: false },
      { sessionId, name: 'Bash', toolUseId: 'toolu_realtime_second', input: { command: 'npm test' }, isError: false },
    ],
  });
  return { workspaceId, criterionId, taskId, sessionId, reviewSessionId };
}

/** Every control event one owner's stream delivers, in arrival order. */
function listen(realtime: RealtimeService, ownerId: string) {
  const events: ControlEvent[] = [];
  const subscription = realtime.streamForUser(ownerId).subscribe((event) => events.push(event));
  return { events, stop: () => subscription.unsubscribe() };
}

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The events that arrived after `mark`, once at least `count` have — and then a moment longer, so
 *  a second event that would break an exact count has had every chance to arrive too. */
async function arrivedSince(events: ControlEvent[], mark: number, count: number): Promise<ControlEvent[]> {
  const deadline = Date.now() + 5_000;
  while (events.length - mark < count && Date.now() < deadline) await settle(10);
  await settle(150);
  return events.slice(mark);
}

/** Every property name anywhere in a value, however deeply it is nested. */
function fieldNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(fieldNames);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([name, inner]) => [name, ...fieldNames(inner)]);
}

/** No field named like a proposal's key, anywhere in the frame; and, when the key is known, not
 *  the key itself either. */
function assertCarriesNoKey(event: ControlEvent, commitToken?: string): void {
  const named = fieldNames(event).filter((name) => /commit_?token/i.test(name));
  assert.deepEqual(named, [], `a ${event.type} frame carries no field named like the proposal's key`);
  if (commitToken !== undefined) {
    assert.equal(JSON.stringify(event).includes(commitToken), false, `nor the key itself (${event.type})`);
  }
}

/** A refusal, unwrapped into what a caller acts on. */
function refusal(error: unknown): { status: number; code: unknown } {
  assert.ok(error instanceof HttpException, `expected a refusal, got ${String(error)}`);
  return { status: error.getStatus(), code: (error.getResponse() as { code?: unknown }).code };
}

test('the four writes that move a pending decision each nudge the owner’s control-plane stream', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);

  // The real hub: publish, the control-plane type mapping, the owner-key filter, and the frame
  // EventsController hands to a browser. Its NOTIFY half runs against this database with nobody
  // LISTENing. Its push half belongs to badge and settlement events, which none of these writes is.
  const push = {
    scheduleBadgeSync: () => {
      throw new Error('these writes publish no badge event');
    },
    notifySessionSettled: () => {
      throw new Error('these writes settle no session');
    },
  } as unknown as PushService;
  const realtime = new RealtimeService(prisma as unknown as PrismaService, push);
  const acceptance = new ProjectAcceptanceService(prisma as unknown as PrismaService);
  const projects = new ProjectsService(
    prisma as unknown as PrismaService, acceptance, undefined, undefined, realtime,
  );
  const evidence = new TaskCompletionEvidenceService(
    prisma as unknown as PrismaService, undefined, undefined, realtime,
  );

  const ownerId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `realtime-${ownerId}@pending-decisions.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  const mine = listen(realtime, ownerId);
  const theirs = listen(realtime, randomUUID());
  t.after(async () => {
    mine.stop();
    theirs.stop();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // The predicate the cases below lean on, shown to bite before it is trusted: a key nested
  // anywhere in a frame, or the key's value under any other name, fails it.
  const probe = (data: Record<string, unknown>) =>
    ({ type: 'probe', sessionId: '', agentId: null, ts: '', data }) as unknown as ControlEvent;
  assert.throws(() => assertCarriesNoKey(probe({ row: { commitToken: 'k' } })));
  assert.throws(() => assertCarriesNoKey(probe({ note: 'the key 5f0c' }), '5f0c'));

  // ═══ EVIDENCE ═════════════════════════════════════════════════════════════════════════════════

  const f = await evidenceFixture(prisma, ownerId);
  const actor = { type: CreatorType.AGENT, id: f.workspaceId };
  const submit = (ref: string, claim: string) => evidence.submit(ownerId, f.taskId, actor, {
    sourceSessionId: f.sessionId,
    evidence: {
      claim,
      criterion: { key: uuidToBase62(f.criterionId), text: CRITERION_TEXT },
      checks: [{ kind: 'TOOL_CALL', ref }],
      gaps: [],
    },
  });
  const decide = (evidenceRevision: string, decision: 'CONFIRM' | 'SEND_BACK', note?: string) =>
    evidence.decide(ownerId, f.taskId, actor, {
      decidingSessionId: f.reviewSessionId,
      evidenceRevision,
      decision,
      note,
    });
  const decisionRows = async (): Promise<number> => Number((await sql.query<{ n: string }>(
    'SELECT count(*) AS n FROM "task_evidence_decision" WHERE "task_id" = $1', [f.taskId],
  )).rows[0].n);
  const taskChanged = { taskId: f.taskId, taskIds: [f.taskId], resync: false };

  await t.test('(1) evidence submitted: one task.changed naming the task', async () => {
    const mark = mine.events.length;
    await submit('toolu_realtime_first', 'the first revision');

    const arrived = await arrivedSince(mine.events, mark, 1);
    assert.deepEqual(arrived.map((event) => event.type), ['task.changed']);
    assert.deepEqual(arrived[0].data, taskChanged);
    assert.equal(arrived[0].sessionId, '', 'owner-scoped: it hangs off no session');
    assertCarriesNoKey(arrived[0]);
  });

  await t.test('(2) evidence decided: one task.changed naming the task', async () => {
    const mark = mine.events.length;
    const decided = await decide('1', 'SEND_BACK', 'the first revision cites one pass; cite the second');
    assert.equal(decided.decision, 'SEND_BACK');

    const arrived = await arrivedSince(mine.events, mark, 1);
    assert.deepEqual(arrived.map((event) => event.type), ['task.changed']);
    assert.deepEqual(arrived[0].data, taskChanged);
    assertCarriesNoKey(arrived[0]);
  });

  await t.test('(3) a decision refused at the door sends nothing; the accepted one after it sends one', async () => {
    const beforeSubmit = mine.events.length;
    await submit('toolu_realtime_second', 'the second revision');
    assert.equal((await arrivedSince(mine.events, beforeSubmit, 1)).length, 1,
      'the second revision nudged once, before the mark below is taken');
    const rowsBefore = await decisionRows();
    const mark = mine.events.length;

    const refused = refusal(await decide('2', 'SEND_BACK').then(() => null, (error: unknown) => error));
    assert.equal(refused.status, 400, 'a SEND_BACK with no note is refused');
    assert.equal(await decisionRows(), rowsBefore, 'and the refusal wrote nothing');

    const accepted = await decide('2', 'CONFIRM');
    assert.equal(accepted.decision, 'CONFIRM');

    const arrived = await arrivedSince(mine.events, mark, 1);
    assert.deepEqual(arrived.map((event) => event.type), ['task.changed'],
      'exactly one nudge across the two calls: the accepted decision’s, and none from the refusal');
    assert.deepEqual(arrived[0].data, taskChanged);
  });

  // ═══ CRITERIA ═════════════════════════════════════════════════════════════════════════════════

  const projectId = randomUUID();
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'the project whose ruler only the owner may loosen' },
  });
  /** State the whole collection through the owner's path, which holds a loosening edit. */
  const state = (items: Array<{ id?: string; text: string }>) => projects.update(ownerId, projectId, {
    acceptanceCriteriaItems: items.map((item) => ({
      ...(item.id ? { id: item.id } : {}),
      text: item.text,
      verificationMethod: METHOD,
    })),
  } as never) as Promise<Record<string, unknown>>;
  const idOf = async (text: string): Promise<string> => {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT "id" FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid AND "text" = $2`, [projectId, text],
    );
    assert.equal(rows.length, 1, `the project still states: ${text}`);
    return rows[0].id;
  };
  /** The owner's own read: the one place the key is handed out, so where a card gets it from. */
  const waiting = async (): Promise<OwnerPendingCriteriaDecision> => {
    const queue = await projects.pendingCriteriaDecisions(ownerId, projectId);
    assert.equal(queue.pending.length, 1, 'exactly one proposal is waiting for the owner');
    return queue.pending[0];
  };
  const answer = (row: OwnerPendingCriteriaDecision, commitToken: string, decision: 'APPROVE' | 'REJECT') =>
    projects.decideCriteriaChange(ownerId, projectId, row.intentId, {
      commitToken,
      decision,
      baseSeal: row.currentSeal,
    } as never);
  const criteriaChanged = { id: projectId };

  // Three criteria stated outright. An additive edit is applied rather than held, and no case below
  // counts from before it.
  await state([{ text: KEPT }, { text: FIRST_DROPPED }, { text: SECOND_DROPPED }]);
  await settle(150);

  await t.test('(4) a loosening edit held for the owner: one project.criteria_decisions.changed', async () => {
    const mark = mine.events.length;
    const response = await state([
      { id: await idOf(KEPT), text: KEPT },
      { id: await idOf(SECOND_DROPPED), text: SECOND_DROPPED },
    ]);
    assert.ok(response.acceptanceCriteriaHold, 'dropping a criterion is held for the owner to decide');

    const arrived = await arrivedSince(mine.events, mark, 1);
    assert.deepEqual(arrived.map((event) => event.type), ['project.criteria_decisions.changed']);
    assert.deepEqual(arrived[0].data, criteriaChanged, 'the project, and nothing of the proposal');
    assert.equal(arrived[0].sessionId, '', 'owner-scoped: it hangs off no session');
    assertCarriesNoKey(arrived[0], (await waiting()).commitToken);
  });

  await t.test('(5) the owner deciding it: one project.criteria_decisions.changed', async () => {
    const row = await waiting();
    const mark = mine.events.length;
    const decided = await answer(row, row.commitToken, 'REJECT');
    assert.equal(decided.decision, 'REJECT');

    const arrived = await arrivedSince(mine.events, mark, 1);
    assert.deepEqual(arrived.map((event) => event.type), ['project.criteria_decisions.changed']);
    assert.deepEqual(arrived[0].data, criteriaChanged);
    assertCarriesNoKey(arrived[0], row.commitToken);
  });

  await t.test('(6) a decision refused for its key sends nothing; the accepted one after it sends one', async () => {
    const beforeHold = mine.events.length;
    await state([
      { id: await idOf(KEPT), text: KEPT },
      { id: await idOf(FIRST_DROPPED), text: FIRST_DROPPED },
    ]);
    assert.equal((await arrivedSince(mine.events, beforeHold, 1)).length, 1,
      'the second proposal nudged once, before the mark below is taken');
    const row = await waiting();
    const mark = mine.events.length;

    const refused = refusal(await answer(row, randomUUID(), 'APPROVE').then(() => null, (error: unknown) => error));
    assert.equal(refused.status, 403);
    assert.equal(refused.code, 'PROJECT_CRITERIA_DECISION_TOKEN_INVALID');

    const accepted = await answer(row, row.commitToken, 'APPROVE');
    assert.equal(accepted.decision, 'APPROVE');

    const arrived = await arrivedSince(mine.events, mark, 1);
    assert.deepEqual(arrived.map((event) => event.type), ['project.criteria_decisions.changed'],
      'exactly one nudge across the two calls: the accepted decision’s, and none from the refusal');
    assert.deepEqual(arrived[0].data, criteriaChanged);
    assertCarriesNoKey(arrived[0], row.commitToken);
  });

  await t.test('(7) every nudge above reached the owner, once each, and no other owner', () => {
    assert.deepEqual(mine.events.map((event) => event.type), [
      'task.changed', // (1) submitted
      'task.changed', // (2) decided
      'task.changed', // (3) the second revision
      'task.changed', // (3) the accepted decision
      'project.criteria_decisions.changed', // (4) held
      'project.criteria_decisions.changed', // (5) decided
      'project.criteria_decisions.changed', // (6) the second proposal
      'project.criteria_decisions.changed', // (6) the accepted decision
    ]);
    for (const event of mine.events) assertCarriesNoKey(event);
    assert.deepEqual(theirs.events, [], 'another owner’s stream carried none of it');
  });
});

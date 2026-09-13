/**
 * "NEEDS YOU" HAS TO COUNT A DECISION NOBODY WROTE AN APPROVAL ROW FOR — AND MAY NOT HAND OUT A KEY.
 *
 * The session list's badge was `approval.count({ status: 'PENDING' })` and nothing else. The
 * decision door deliberately writes no `Approval` row (this project's instructions §3: that table
 * has no project, action or digest column and its `input` is copied from the agent's own call, so
 * it can witness a click on a tool call and never an approval of an action), which left the account
 * owner with a real criteria decision waiting and a left-hand list that knew nothing about it.
 *
 * WHAT THIS FILE WITNESSES, AND WHY EACH PART IS HERE
 * ---------------------------------------------------
 *   (1) A project with a held proposal and NO approval row anywhere lights both counting reads —
 *       the per-session `pendingApprovals` and the per-workspace `needsYou` — and each says where
 *       to go: the row that carries the count is the project's coordinator conversation, and it
 *       names the project. The conversation is PARKED, not generating, which is the state the badge
 *       used to be dark in and is the whole reason it was dark.
 *
 *       Its paired negative is in the same fixture and comes FIRST: the same two reads answer zero
 *       over the same project before the proposal exists. Without that, "greater than zero" would
 *       also be true of a read that counted every session.
 *
 *   (2) Deciding it puts both counts back to zero — through a committed row, with the session and
 *       the approval table untouched between the two reads, so what fell is the decision and not
 *       the fixture.
 *
 *   (3) The counting path carries no `commitToken`. Scanned BY FIELD NAME over the whole returned
 *       graph rather than read by eye, and paired with a positive control: the same scanner over
 *       the owner's own read (`pendingCriteriaDecisions`, the one read that is allowed to hand out
 *       keys) must FIND one. A scanner that finds nothing anywhere proves nothing.
 *
 *   (4) The count is not authority. The decision door refuses a caller holding the count and no
 *       key exactly as it refused before — the count changed what the badge says and no gate.
 *
 *   (5) A badge is a "go here now", so it stops pointing at a conversation the owner filed away —
 *       and the question is not lost with it, which the project's own read is asserted to still
 *       answer in the same breath.
 *
 *   (6) Its own fixture: evidence waiting on a CONFIRM or SEND_BACK is the second kind of owner
 *       decision, and it lights the coordinator row for exactly the rows that conversation's
 *       evidence card draws. A revision the door would refuse from anyone comes FIRST and lights
 *       nothing; the answerable one lights the coordinator and not the run that submitted it; a
 *       CONFIRM puts it back. Each write also asks for the coordinator's row to be re-drawn,
 *       because `task.changed` refreshes no session row.
 *
 *       That re-draw is the one signal the evidence service addresses to a session, and its census
 *       (`task-completion-evidence.spec.ts`) lets it out on what (6d) and (6e) pin: it names the
 *       coordinator whichever run submitted or answered, it is asked for once a write has
 *       committed and never for a refused one, and a send that throws takes nothing back.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/needs-you-owner-decision.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to this owner.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

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
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from './sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { readOwnerDecisionSignals } from '../projects/owner-decision-signal';
import { criterionKeyOf } from '../projects/project-acceptance';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectsService } from '../projects/projects.service';
import { readPendingEvidenceJudgments } from '../tasks/pending-evidence-judgments';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const METHOD = 'A person reads the criterion and says whether it holds';
const FIRST = 'the badge is lit by a question, not by a row in the approval table';
const SECOND = 'the criterion this fixture drops, to make an edit a loosening';

/** The write path's answer when it held an edit instead of applying it. */
interface Held {
  applied: false;
  intentId: string;
  actionDigest: string;
  baselineSeal: string;
  supersededIntentId: string | null;
  notice: string;
}

interface Stack {
  db: PrismaClient;
  sessions: SessionsService;
  projects: ProjectsService;
}

/** The production wiring, over one client and with no seam. */
function connect(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const acceptance = new ProjectAcceptanceService(prisma);
  return { db, sessions, projects: new ProjectsService(prisma, acceptance, sessions) };
}

interface Fixture {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
}

/**
 * One owner, one workspace, one project, and the PARKED conversation it is coordinated from.
 *
 * Parked (AWAITING_INPUT, no live turn) on purpose: `pendingApprovals` skips the approval query
 * entirely for a conversation that is not generating, so a fixture that was RUNNING would let a
 * count that still only knew about approvals look as though it had learned something.
 */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@needs-you.invalid`,
      name: 'The account owner',
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
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `协调：${label}`,
      prompt: `协调：${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: `协调：${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 的尺子`,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, workspaceId, projectId, coordinatorSessionId };
}

/**
 * Every path through a returned value at which a field carries the given NAME.
 *
 * By name and not by value, because the thing being kept out is the concept: a token that came back
 * under `commitToken` is the door's second key whatever its bytes are. Walks arrays and plain
 * objects and stops at cycles, so a payload that grows a nested shape later is still covered by the
 * check that was written before it.
 */
function pathsToField(value: unknown, field: string, at = '$', seen = new Set<unknown>()): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => pathsToField(item, field, `${at}[${index}]`, seen));
  }
  const found: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === field) found.push(`${at}.${key}`);
    found.push(...pathsToField(nested, field, `${at}.${key}`, seen));
  }
  return found;
}

test('the badge counts an owner decision, points at it, and hands out no key', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = stack.db;
  const f = await fixture(db, 'badge');

  /** State the whole collection through the owner's path — the only writer of a definition. */
  async function state(items: Array<{ id?: string; text: string }>): Promise<Held | null> {
    const response = await stack.projects.update(f.ownerId, f.projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: METHOD,
      })),
    } as never) as unknown as { acceptanceCriteriaHold?: Held };
    return response.acceptanceCriteriaHold ?? null;
  }

  /** The coordinator conversation's row as the session list serves it. */
  async function listedCoordinator() {
    const rows = await stack.sessions.list(f.ownerId, {});
    const row = rows.find((s: { id: string }) => s.id === f.coordinatorSessionId);
    assert.ok(row, 'the coordinator conversation is in this owner’s Open list');
    return row as { id: string; pendingApprovals: number; projectId: string | null; status: string };
  }

  /** The per-workspace tally for the workspace this project is coordinated in. */
  async function workspaceTally() {
    const rows = await stack.sessions.workspaceSessionCounts(f.ownerId);
    return rows.find((r) => r.workspaceId === f.workspaceId) ?? null;
  }

  /** How many `Approval` rows exist for this owner — the table this path must never write. */
  function approvalRows() {
    return db.approval.count({ where: { session: { ownerId: f.ownerId } } });
  }

  assert.equal(await state([{ text: FIRST }, { text: SECOND }]), null,
    'stating a project’s first criteria is ADDITIVE and is never held');
  const before = await db.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId: f.projectId }, orderBy: { ordinal: 'asc' }, select: { id: true },
  });

  // ── the paired negative, first: the same reads over the same project, with nothing waiting ────
  const darkRow = await listedCoordinator();
  assert.equal(darkRow.pendingApprovals, 0,
    'nothing is waiting yet, so the row is dark — the count is not simply always positive');
  assert.equal(darkRow.status, RunStatus.AWAITING_INPUT,
    'and it is PARKED: this is the state the old count could not see anything in');
  assert.equal((await workspaceTally())?.needsYou ?? 0, 0,
    'and the workspace tally agrees there is nothing to answer');

  let intentId = '';
  await t.test('(1) a held proposal lights both reads, and each names where to go', async () => {
    const held = await state([{ id: before[0]!.id, text: FIRST }]);
    assert.ok(held, 'dropping a criterion is a loosening, so it is held rather than applied');
    intentId = held.intentId;
    assert.equal(await approvalRows(), 0,
      'and it wrote NO approval row — that table is not how this is recorded, by design');

    const row = await listedCoordinator();
    assert.ok(row.pendingApprovals > 0,
      'the session list now says somebody is waiting on this conversation');
    assert.equal(row.pendingApprovals, 1, 'exactly the one question that is waiting');
    assert.equal(row.id, f.coordinatorSessionId,
      'the row carrying the count IS the destination: the conversation the card is asked on');
    assert.equal(row.projectId, f.projectId,
      'and it names the project whose ruler is being decided, so the reader knows what about');

    const tally = await workspaceTally();
    assert.ok((tally?.needsYou ?? 0) > 0, 'the per-workspace tally lights too');
    assert.equal(tally!.needsYou, 1, 'one conversation needs you, in this workspace');

    // The signal read itself, which is what both of the above are folded from.
    const signals = await readOwnerDecisionSignals(db as never, f.ownerId);
    assert.deepEqual(signals,
      [{ sessionId: f.coordinatorSessionId, projectId: f.projectId, count: 1 }],
      'a count and an address, and nothing else in the row');
  });

  await t.test('(2) deciding it puts both counts back, and only the decision changed', async () => {
    const approvalsBefore = await approvalRows();
    const intent = await db.projectRatifiedActionIntent.findUniqueOrThrow({
      where: { id: intentId },
      select: { projectId: true, ownerId: true, contractDigest: true },
    });
    await db.projectRatifiedActionCommit.create({
      data: {
        intentId,
        projectId: intent.projectId,
        ownerId: intent.ownerId,
        contractDigest: intent.contractDigest,
        budgetCharge: 0,
      },
    });

    assert.equal(await approvalRows(), approvalsBefore,
      'nothing touched the approval table between the two reads');
    assert.equal((await listedCoordinator()).pendingApprovals, 0,
      'an answered question stops being a question for the badge too');
    assert.equal((await workspaceTally())?.needsYou ?? 0, 0,
      'and the workspace tally falls with it');
  });

  await t.test('(3) the counting path carries no commitToken — scanned by field name', async () => {
    // Put a question back so there is something for a key to have ridden out on. A DIFFERENT
    // loosening from (1)'s: that one is answered, and re-sending it byte for byte asks nothing new.
    const held = await state([{ id: before[1]!.id, text: SECOND }]);
    assert.ok(held, 'the fixture is holding a proposal again');

    const counting = {
      signals: await readOwnerDecisionSignals(db as never, f.ownerId),
      sessionRow: await listedCoordinator(),
      workspaceTally: await workspaceTally(),
    };
    assert.ok(counting.signals.length > 0 && counting.sessionRow.pendingApprovals > 0,
      'the scan below is over a payload that IS reporting the question, not over an empty one');
    assert.deepEqual(pathsToField(counting, 'commitToken'), [],
      'the count says how many and where — never the key that answers them');

    // The positive control, over the same scanner: the owner's own read is the one place the key
    // leaves the database, and it must be found there. Without this, an empty result above would
    // be consistent with a scanner that cannot see anything at all.
    const ownerRead = await stack.projects.pendingCriteriaDecisions(f.ownerId, f.projectId);
    assert.deepEqual(pathsToField(ownerRead, 'commitToken'), ['$.pending[0].commitToken'],
      'the owner’s read DOES carry the key — so the empty result above is about the payload');
  });

  await t.test('(4) counting granted nothing: the door refuses the same way it did before',
    async () => {
      const queue = await stack.projects.pendingCriteriaDecisions(f.ownerId, f.projectId);
      const waiting = queue.pending[0]!;
      // Everything a reader of the badge could possibly have — the address it pointed at — and no
      // key. The door's own spec owns all five of its typed refusals; this asserts only that the
      // count did not become one of the ways through it.
      await assert.rejects(
        () => stack.projects.decideCriteriaChange(
          f.ownerId, f.projectId, waiting.intentId, { decision: 'APPROVE' } as never,
        ),
        (error: unknown) => {
          const body = (error as { response?: { code?: string } })?.response;
          assert.equal(body?.code, 'PROJECT_CRITERIA_DECISION_KEY_MISSING',
            'the door still names the missing key, in its own vocabulary');
          return true;
        },
        'holding the count and no commitToken is refused, exactly as it was before the count existed',
      );
      const definitions = await db.projectAcceptanceCriterionDefinition.count({
        where: { projectId: f.projectId },
      });
      assert.equal(definitions, 2, 'and no criterion moved: a refused decision writes nothing');
    });

  await t.test('(5) a badge points somewhere: a filed-away conversation stops carrying the count',
    async () => {
      assert.equal((await readOwnerDecisionSignals(db as never, f.ownerId)).length, 1,
        'the question from (3) is still waiting — the fixture for this case');
      await db.session.update({
        where: { id: f.coordinatorSessionId },
        data: { completedAt: new Date() },
      });
      assert.deepEqual(await readOwnerDecisionSignals(db as never, f.ownerId), [],
        'a conversation the owner filed away is not a place to be sent, so it carries no count');
      // And the question is not lost with it — which is the whole reason the badge is allowed to
      // be this conservative. The ledger read is the floor and answers regardless.
      const queue = await stack.projects.pendingCriteriaDecisions(f.ownerId, f.projectId);
      assert.equal(queue.count, 1,
        'the proposal is still waiting on the project’s own read; only the badge stopped pointing');
      await db.session.update({
        where: { id: f.coordinatorSessionId }, data: { completedAt: null },
      });
      assert.equal((await readOwnerDecisionSignals(db as never, f.ownerId)).length, 1,
        'and reopening the conversation makes it a destination again');
    });
});

/** The criterion the evidence case's revisions are measured against. */
const JUDGED = 'the submitted evidence names the artifact its command produced';

test('the badge counts evidence waiting on the coordinator’s card, and only what that card draws', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = connect(url);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = stack.db;
  const f = await fixture(db, 'evidence');

  // Which session rows the evidence door asked clients to re-draw. Everything else here reads the
  // counts directly, so without this a count that is right but never pushed would pass.
  const nudged: string[] = [];
  const realtime = new Proxy({}, {
    get: (_target, name) => (name === 'publishSessionUpdated'
      ? (sessionId: string) => { nudged.push(sessionId); }
      : () => undefined),
  }) as unknown as RealtimeService;
  const evidence = new TaskCompletionEvidenceService(
    db as unknown as PrismaService, undefined, undefined, realtime,
  );

  const stated = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: [{ text: JUDGED, verificationMethod: METHOD }],
  } as never) as unknown as { acceptanceCriteriaHold?: unknown };
  assert.equal(stated.acceptanceCriteriaHold, undefined,
    'stating a project’s first criteria is ADDITIVE and is never held');
  const judged = await db.projectAcceptanceCriterionDefinition.findFirstOrThrow({
    where: { projectId: f.projectId },
    select: { id: true, revision: true },
  });
  const { runnerId } = await db.workspace.findUniqueOrThrow({
    where: { id: f.workspaceId },
    select: { runnerId: true },
  });

  /** An EVIDENCE_JUDGMENT task in this project, the run that works it, and a check it can cite. */
  async function judgedTask(label: string) {
    const taskId = randomUUID();
    const sourceSessionId = randomUUID();
    const cited = `toolu_needs_you_${label}`;
    await db.task.create({
      data: {
        id: taskId,
        ownerId: f.ownerId,
        projectId: f.projectId,
        title: `${label} 要交证据的活`,
        creatorType: CreatorType.USER,
        creatorId: f.ownerId,
        assigneeId: f.workspaceId,
        status: TaskStatus.IN_PROGRESS,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        acceptanceCriteria: JUDGED,
        criterionDefinitionId: judged.id,
        criterionRevision: judged.revision,
      },
    });
    await db.session.create({
      data: {
        id: sourceSessionId,
        ownerId: f.ownerId,
        creatorId: f.ownerId,
        taskId,
        workspaceId: f.workspaceId,
        assignedRunnerId: runnerId,
        title: `${label} 执行会话`,
        prompt: `${label} 执行会话`,
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
      },
    });
    await db.toolCall.create({
      data: {
        sessionId: sourceSessionId,
        name: 'Bash',
        toolUseId: cited,
        input: { command: 'npm test', description: 'the command this evidence is about' },
        isError: false,
      },
    });
    return { taskId, sourceSessionId, cited };
  }

  /** Submit revision 1 for a task, quoting the criterion's text as `quote`, through `service`. */
  function submit(
    task: { taskId: string; sourceSessionId: string; cited: string },
    quote: string,
    service = evidence,
  ) {
    return service.submit(f.ownerId, task.taskId, { type: CreatorType.AGENT, id: f.workspaceId }, {
      sourceSessionId: task.sourceSessionId,
      idempotencyKey: `needs-you-${task.taskId}`,
      evidence: {
        claim: 'the declared command ran and its output names dist/server.js',
        criterion: { key: criterionKeyOf(judged.id), text: quote },
        checks: [{ kind: 'TOOL_CALL', ref: task.cited, command: 'npm test', succeeded: true }],
        gaps: [],
      },
    });
  }

  /** A row's count as the session list serves it. */
  async function countOn(sessionId: string): Promise<number> {
    const rows = await stack.sessions.list(f.ownerId, {}) as unknown as Array<{
      id: string;
      pendingApprovals: number;
    }>;
    const row = rows.find((s) => s.id === sessionId);
    assert.ok(row, 'the conversation is in this owner’s Open list');
    return row.pendingApprovals;
  }

  /** The per-workspace tally for the workspace this project is coordinated in. */
  async function needsYou(): Promise<number> {
    const rows = await stack.sessions.workspaceSessionCounts(f.ownerId);
    return rows.find((r) => r.workspaceId === f.workspaceId)?.needsYou ?? 0;
  }

  /** The tasks the coordinator's evidence card is drawn for: its own pending read, this project. */
  async function cardRows(): Promise<string[]> {
    const queue = await readPendingEvidenceJudgments(db as never, f.ownerId, {
      id: f.coordinatorSessionId,
      taskId: null,
    });
    return queue.pending.filter((row) => row.projectId === f.projectId).map((row) => row.taskId);
  }

  const moved = await judgedTask('moved');
  const answerable = await judgedTask('answerable');

  // ── the paired negative, first: both tasks exist and neither has submitted anything ────────────
  assert.equal(await countOn(f.coordinatorSessionId), 0, 'nothing is waiting, so the row is dark');
  assert.equal(await needsYou(), 0, 'and so is the workspace tally');

  await t.test('(6a) a revision the door would refuse from anyone lights nothing', async () => {
    nudged.length = 0;
    await submit(moved, `${JUDGED}, as it read before somebody reworded it`);
    assert.deepEqual(await cardRows(), [],
      'the quote is not the live criterion, so the coordinator is drawn no card for it');
    assert.equal(await countOn(f.coordinatorSessionId), 0,
      'and the badge agrees with the card: a lit row that opens onto nothing is worse than a dark one');
    assert.deepEqual(await readOwnerDecisionSignals(db as never, f.ownerId), []);
    assert.deepEqual(nudged, [f.coordinatorSessionId],
      'the row is still re-drawn: whether it lights is the count’s call, not the nudge’s');
  });

  await t.test('(6b) an answerable revision lights the coordinator, and only the coordinator',
    async () => {
      nudged.length = 0;
      await submit(answerable, JUDGED);
      assert.deepEqual(await cardRows(), [answerable.taskId], 'the card has one question to draw');
      assert.equal(await countOn(f.coordinatorSessionId), 1,
        'the PARKED coordinator row says somebody is waiting on it — the state the badge was dark in');
      assert.equal(await countOn(answerable.sourceSessionId), 0,
        'the run that submitted is not where the question is asked, so its row stays dark');
      assert.equal(await needsYou(), 1, 'one conversation needs you, in this workspace');
      assert.deepEqual(await readOwnerDecisionSignals(db as never, f.ownerId),
        [{ sessionId: f.coordinatorSessionId, projectId: f.projectId, count: 1 }]);
      assert.deepEqual(nudged, [f.coordinatorSessionId],
        'and the submission asked for that row to be re-drawn, so it lights without a reload');
    });

  await t.test('(6c) confirming it puts the count back, and re-draws the row again', async () => {
    nudged.length = 0;
    await evidence.decide(f.ownerId, answerable.taskId, { type: CreatorType.USER, id: f.ownerId }, {
      decidingSessionId: f.coordinatorSessionId,
      evidenceRevision: '1',
      decision: 'CONFIRM',
    });
    assert.deepEqual(await cardRows(), [], 'an answered revision leaves the card’s read');
    assert.equal(await countOn(f.coordinatorSessionId), 0, 'and the badge falls with it');
    assert.equal(await needsYou(), 0, 'and so does the workspace tally');
    assert.deepEqual(nudged, [f.coordinatorSessionId], 'the decision re-drew the row it darkened');
  });

  // ── the re-draw itself: whom it names, when it is asked for, and what a failed send costs ──────
  // `nudged` says a row was asked for. It cannot say that the ask came after the write it describes
  // had COMMITTED — before that, the re-read it prompts draws the old count and nothing draws the
  // row again — nor that an ask which throws takes nothing back. So a second service over the same
  // database, whose client logs each commit as it lands and whose re-draw throws on demand, writes
  // both into one ordered log.
  const log: string[] = [];
  let sendThrows = false;
  const committing = new Proxy(db, {
    get: (target, name) => {
      if (name === '$transaction') {
        const run = target.$transaction.bind(target) as unknown as
          (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const result = await run(...args);
          log.push('commit');
          return result;
        };
      }
      const value = Reflect.get(target, name, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const observed = new TaskCompletionEvidenceService(
    committing as unknown as PrismaService,
    undefined,
    undefined,
    new Proxy({}, {
      get: (_target, name) => (name === 'publishSessionUpdated'
        ? (sessionId: string) => {
          log.push(`re-draw ${sessionId}`);
          if (sendThrows) throw new Error('the realtime hub refused the frame');
        }
        : () => undefined),
    }) as unknown as RealtimeService,
  );
  const redrawn = ['commit', `re-draw ${f.coordinatorSessionId}`];

  await t.test('(6d) the re-draw names the coordinator, once a write has committed, never for a refused one',
    async () => {
      const later = await judgedTask('later');
      log.length = 0;
      await submit(later, JUDGED, observed);
      assert.deepEqual(log, redrawn,
        'the submission asked for the coordinator’s row after its revision committed');

      log.length = 0;
      await assert.rejects(
        () => observed.decide(f.ownerId, later.taskId, { type: CreatorType.USER, id: f.ownerId }, {
          decidingSessionId: later.sourceSessionId,
          evidenceRevision: '1',
          decision: 'CONFIRM',
        }),
        (error: unknown) => {
          const body = (error as { response?: { code?: string } })?.response;
          assert.equal(body?.code, 'EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION',
            'the run that did the work may not answer for it');
          return true;
        },
      );
      assert.deepEqual(log, [],
        'refused inside its transaction: nothing committed, and no row was asked to re-draw');

      // Answered from a third run, neither the coordinator nor the one that submitted: the row asked
      // for is still the coordinator's, because that is the row counting the question.
      await observed.decide(f.ownerId, later.taskId, { type: CreatorType.USER, id: f.ownerId }, {
        decidingSessionId: moved.sourceSessionId,
        evidenceRevision: '1',
        decision: 'SEND_BACK',
        note: 'cite the run that produced dist/server.js',
      });
      assert.deepEqual(log, redrawn,
        'the accepted answer asks once, after it committed, for the coordinator and not the run that gave it');
    });

  await t.test('(6e) a re-draw that fails to send takes nothing back from the write it follows', async () => {
    const unsent = await judgedTask('unsent');
    sendThrows = true;
    try {
      log.length = 0;
      const receipt = await submit(unsent, JUDGED, observed);
      assert.equal(receipt.revision, '1', 'the submission still answers with the revision it recorded');
      assert.deepEqual(log, redrawn, 'and the send that threw really was attempted, after the commit');
      assert.deepEqual(await cardRows(), [unsent.taskId], 'the revision is a question on the card');
      assert.equal(await countOn(f.coordinatorSessionId), 1, 'and the row a reload draws counts it');

      log.length = 0;
      const decided = await observed.decide(
        f.ownerId, unsent.taskId, { type: CreatorType.USER, id: f.ownerId }, {
          decidingSessionId: f.coordinatorSessionId,
          evidenceRevision: '1',
          decision: 'CONFIRM',
        },
      );
      assert.equal(decided.decision, 'CONFIRM', 'the decision still answers with the row it recorded');
      assert.deepEqual(log, redrawn, 'after its own commit, and through its own failed send');
      const settled = await db.task.findUniqueOrThrow({
        where: { id: unsent.taskId },
        select: { status: true },
      });
      assert.equal(settled.status, TaskStatus.DONE, 'the CONFIRM it recorded still settled the task');
      assert.equal(await countOn(f.coordinatorSessionId), 0, 'and the row a reload draws is dark again');
    } finally {
      sendThrows = false;
    }
  });
});

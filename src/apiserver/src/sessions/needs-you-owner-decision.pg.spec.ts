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
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/needs-you-owner-decision.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to this owner.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from './sessions.service';
import { CoordinatorDeliveryService } from '../projects/coordinator-delivery.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { readOwnerDecisionSignals } from '../projects/owner-decision-signal';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectsService } from '../projects/projects.service';

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
  const deliveries = new CoordinatorDeliveryService(
    prisma,
    new CoordinatorWakeService(prisma),
    sessions,
  );
  return { db, sessions, projects: new ProjectsService(prisma, acceptance, sessions, deliveries) };
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

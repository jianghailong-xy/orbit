/**
 * THE FLOOR UNDER THE DECISION CARD, AND ONE DELIVERY OF THE CARD ITSELF.
 *
 * `criteria-weakening-intent.pg.spec.ts` witnesses that a loosening edit is HELD rather than
 * applied. What it leaves open is the half a person has to be able to act on: how anybody finds a
 * held proposal afterwards, and how anybody is told there is one.
 *
 * WHAT EACH HALF HAS TO WITNESS
 * -----------------------------
 * The read is derived, so every claim about it is a claim about rows somebody else wrote:
 *
 *   (1) a filed proposal reads out, decidable, with the digest and baseline the write path
 *       reported — and the same reader answered ZERO before the proposal existed, so "it reads out"
 *       is a statement about this proposal rather than about a reader that returns everything;
 *   (2) once it is settled, the same reader over the same rows returns nothing. The only thing that
 *       changed between (1) and (2) is one commit row, which is what makes this a test of the
 *       settled clause rather than of the fixture;
 *   (3) a proposal whose baseline seal has since moved does NOT vanish — it comes back undecidable,
 *       carrying the refusal and the action that clears it. Same intent id either side of the edit
 *       that moved the seal, so the row is witnessed CHANGING state rather than two rows being
 *       compared.
 *
 * (2) settles a proposal the one way 0195's own tables can express an answer, which is a commit
 * row. The other way one lands — the decision row the door writes for a REJECT as much as for an
 * APPROVE — is (9) and (10) at the foot of this file, with what turning a proposal down leaves
 * askable afterwards.
 *
 * And the delivery is measured through the write path that produces it, not by composing a fact by
 * hand: the edit that gets held is the thing that puts the card on the conversation, so (4) sends
 * one and reads the conversation. The message lists what MOVED, which is an arm per kind of move,
 * so one case per arm sends the edit that takes it: (4) drops a criterion, (4b) rewords one — the
 * arm the only proposal ever held goes down — and (4c) rewrites only how one is judged, where the
 * two sides of the row read alike and the lines about the procedure are the whole of the question.
 * Its negative — (5) — is in the same file and over the same code because "no message was written"
 * is vacuously true of a delivery nobody attempted: (5) ends a project's coordinator conversation,
 * holds an edit, and asserts three things together — no message, a REFUSED wake naming why, and the
 * proposal STILL PENDING in the read. That last one is the whole point of the pair. The card is not
 * the queue; this read is.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-pending-decisions.pg.spec.ts
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  CoordinatorDeliveryService,
  DELIVERY_COORDINATOR_SESSION_UNAVAILABLE,
  coordinatorDeliveryTurnId,
} from './coordinator-delivery.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { buildCoordinatorDeliveryMessage, describeWakeFact } from './coordinator-judgment-opening';
import { criteriaDecisionPendingFact, wakeIdempotencyKey } from './coordinator-wake';
import { CoordinatorWakeService } from './coordinator-wake.service';
import {
  CRITERIA_DECISION_BASE_SEAL_MOVED,
  CRITERIA_DECISION_REFILE_ACTION,
  readPendingCriteriaDecisions,
} from './criteria-pending-decisions';
import { CRITERIA_WEAKENING_EFFECT_CLASS } from './criteria-weakening-intent';
import { readOwnerDecisionSignals } from './owner-decision-signal';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { HELD_CRITERIA_WAKE_COORDINATOR_DISABLED, ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** How the criteria say they are to be judged. Restated byte for byte by every edit below. */
const METHOD = 'A person reads the criterion and says whether it holds';

const FIRST = 'the derived read finds a held proposal without a queue to hold it';
const SECOND = 'a settled proposal stops being a question for every reader at once';
const THIRD = 'the criterion this fixture drops, to make an edit a loosening';
const TIGHTENING = 'and a tightening edit moves the seal, which strands a proposal under it';

/** What the write path returns when it held an edit — the shape `HeldCriteriaEdit` is on the wire. */
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
  acceptance: ProjectAcceptanceService;
  /** Wired WITH the delivery service: a held edit is what puts the card on the conversation. */
  projects: ProjectsService;
  deliveries: CoordinatorDeliveryService;
}

/** The production wiring, over one client and with no seam. */
function connect(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const deliveries = new CoordinatorDeliveryService(
    prisma,
    new CoordinatorWakeService(prisma),
    sessions,
  );
  const acceptance = new ProjectAcceptanceService(prisma);
  return {
    db,
    acceptance,
    deliveries,
    projects: new ProjectsService(prisma, acceptance, sessions, deliveries),
  };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The standing conversation this project is coordinated from, parked between turns. */
  coordinatorSessionId: string;
}

/**
 * One owner, one runnable workspace, one project, and the conversation it is coordinated from.
 *
 * The conversation is parked at AWAITING_INPUT with its own opening prompt already on it, so a
 * delivery below appends to a conversation somebody has been talking to rather than seeding one.
 */
async function fixture(
  db: PrismaClient,
  label: string,
  {
    coordinatorStatus = RunStatus.AWAITING_INPUT,
    coordinatorEnabled = true,
  }: { coordinatorStatus?: RunStatus; coordinatorEnabled?: boolean } = {},
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@pending-decisions.invalid`,
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
      // Heartbeating now, so `deriveSessionCapabilities` does not answer RUNNER_OFFLINE. It is set
      // for the ENDED fixture's sake: that conversation has to be one `resume` WOULD revive, or
      // "delivery does not revive it" would be true of a conversation nothing could revive.
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
      status: coordinatorStatus,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      // A conversation that has RUN: started once, with a runtime session to resume into. Both are
      // here for the ENDED fixture below and are inert for the parked one — `canResume` is what
      // decides whether an ended conversation could be revived at all, and a fixture that answers
      // NOT_STARTED would make "delivery did not revive it" a statement about the fixture.
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
      coordinatorEnabled,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

/**
 * Every message this project's standing conversation has been SENT, oldest first.
 *
 * The seeded opening turn is excluded, exactly as `SessionsService`'s own queued-turn reader
 * excludes it: it is the conversation's own prompt rather than something anybody told it.
 */
function coordinatorMessages(db: PrismaClient, f: Fixture) {
  return db.conversationTurn.findMany({
    where: {
      sessionId: f.coordinatorSessionId,
      kind: 'message',
      clientTurnId: { not: SessionsService.initialTurnClientId(f.coordinatorSessionId) },
    },
    select: { clientTurnId: true, content: true },
    orderBy: { seq: 'asc' },
  });
}

/**
 * Every session this delivery path does NOT open, as the census spells that claim.
 *
 * A judgment session is the OTHER terminal a wake can reach, so "nothing was opened" has to be a
 * claim about the branch this fact never takes rather than about an empty table in general.
 */
function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

/** Every wake this project has, whatever the fact was — the reader that does not name an event. */
function projectWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId },
    select: {
      event: true, status: true, sessionId: true, refusalCode: true, idempotencyKey: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

test('a held criteria proposal is a derived read, and the stale ways out of it', {
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
  const f = await fixture(db, 'floor');

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

  /** The definition rows as the database holds them, in the order the write path restates them. */
  async function definitions(): Promise<Array<{ id: string; text: string }>> {
    const rows = await db.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: f.projectId },
      orderBy: { ordinal: 'asc' },
      select: { id: true, text: true },
    });
    return rows;
  }

  /** The seal that stands, through the same read path the product's confirmation page uses. */
  async function seal(): Promise<string> {
    return (await stack.acceptance.standardSetConfirmation(f.ownerId, f.projectId))
      .currentVersion.digest;
  }

  /** The read under test, always for this owner and this project. */
  function pending() {
    return readPendingCriteriaDecisions(db as never, f.ownerId, f.projectId);
  }

  // ── the fixture: three criteria, stated through the ordinary path ─────────────────────────────
  assert.equal(await state([{ text: FIRST }, { text: SECOND }, { text: THIRD }]), null,
    'stating a project’s first criteria is ADDITIVE and is never held');
  const before = await definitions();
  assert.equal(before.length, 3, 'the fixture starts with three criteria');

  // The baseline that makes every "it reads out" below mean something: this reader answers zero
  // over a project whose criteria were written and nothing was proposed.
  const empty = await pending();
  assert.deepEqual(
    [empty.count, empty.decidableCount, empty.oldestAgeSeconds, empty.pending],
    [0, 0, null, []],
    'a project with no held proposal has nothing pending — the read is not returning every intent',
  );
  assert.equal(empty.projectId, f.projectId);

  // ═══ (1) a filed proposal reads out, decidable ════════════════════════════════════════════════
  let firstIntentId = '';
  await t.test('(1) a held proposal reads out with the digest and baseline the write reported',
    async () => {
      const sealBefore = await seal();
      const held = await state([
        { id: before[0]!.id, text: FIRST },
        { id: before[1]!.id, text: SECOND },
      ]);
      assert.ok(held, 'dropping a criterion is a loosening and has to be held');
      firstIntentId = held.intentId;

      const queue = await pending();
      assert.equal(queue.count, 1, 'one edit was held, so one question is waiting');
      assert.equal(queue.decidableCount, 1);
      const [row] = queue.pending;
      assert.equal(row!.intentId, held.intentId, 'the read finds the proposal the write reported');
      assert.equal(row!.actionDigest, held.actionDigest);
      assert.equal(row!.baselineSeal, held.baselineSeal);
      assert.equal(row!.baselineSeal, sealBefore,
        'the baseline is the ruler that stood when the edit was composed');
      assert.equal(row!.currentSeal, sealBefore,
        'and nothing moved it — a held edit writes no definition');
      assert.equal(row!.supersededIntentId, null, 'this proposal displaced nothing');
      assert.deepEqual(row!.decidability, { decidable: true, refusal: null, requiredAction: null });
      assert.deepEqual(
        row!.proposed.map((criterion) => criterion.text), [FIRST, SECOND],
        'the diff a decider judges is in the row, because it is nowhere else — it was never written',
      );
      assert.equal(typeof row!.ageSeconds, 'number');
      assert.equal(queue.oldestAgeSeconds, row!.ageSeconds);
      assert.equal((await definitions()).length, 3, 'and the criteria on record did not move');
    });

  // ═══ (2) a settled proposal stops being a question ════════════════════════════════════════════
  await t.test('(2) once an answer is recorded, the same reader over the same rows returns nothing',
    async () => {
      // The one landing 0195 gives an answer today, written the way the two-phase machine writes
      // one: the intent's own id as the primary key, and no budget charged, because a proposal is
      // not an action that happened.
      const intent = await db.projectRatifiedActionIntent.findUniqueOrThrow({
        where: { id: firstIntentId },
        select: { projectId: true, ownerId: true, contractDigest: true },
      });
      await db.projectRatifiedActionCommit.create({
        data: {
          intentId: firstIntentId,
          projectId: intent.projectId,
          ownerId: intent.ownerId,
          contractDigest: intent.contractDigest,
          budgetCharge: 0,
        },
      });

      const queue = await pending();
      assert.deepEqual([queue.count, queue.pending], [0, []],
        'an answered question is not a question, and it leaves every reader’s next read at once');
      // The row itself is still there: settled is derived from a second row, never by editing this
      // one — 0195’s trigger refuses every write to a filed proposal.
      assert.ok(await db.projectRatifiedActionIntent.findUnique({ where: { id: firstIntentId } }),
        'the proposal is still on record; what changed is that it now has an answer');
    });

  // ═══ (3) the base seal moves under a pending proposal ═════════════════════════════════════════
  await t.test('(3) a proposal whose baseline moved reads out undecidable, not gone', async () => {
    const live = await definitions();
    // A DIFFERENT loosening from (1)'s: that one is on record and answered, and re-sending it
    // byte for byte is the same ask against the same ruler, which files nothing. Dropping the
    // other criterion is a different question and gets its own proposal.
    const second = await state([{ id: live[0]!.id, text: FIRST }, { id: live[2]!.id, text: THIRD }]);
    assert.ok(second, 'a second loosening is held like the first');
    assert.notEqual(second.intentId, firstIntentId, 'and it is a proposal of its own');

    const beforeEdit = await pending();
    assert.equal(beforeEdit.count, 1);
    assert.equal(beforeEdit.pending[0]!.intentId, second.intentId);
    assert.equal(beforeEdit.pending[0]!.decidability.decidable, true,
      'decidable BEFORE the seal moves — otherwise (3) would prove nothing about the seal');

    // A tightening edit: the same three criteria plus a fourth. It lands where it is made, and the
    // definition trigger moves `revision` and `content_hash`, so the seal is a different one.
    const sealBefore = await seal();
    assert.equal(
      await state([
        { id: live[0]!.id, text: FIRST },
        { id: live[1]!.id, text: SECOND },
        { id: live[2]!.id, text: THIRD },
        { text: TIGHTENING },
      ]),
      null,
      'adding a criterion is the ruler walking toward strictness, so it is applied and not held',
    );
    const sealAfter = await seal();
    assert.notEqual(sealAfter, sealBefore, 'the tightening edit moved the seal');

    const stranded = await pending();
    assert.equal(stranded.count, 1, 'the stranded proposal is still returned — it is not gone');
    assert.equal(stranded.decidableCount, 0, 'and it is not decidable either');
    const [row] = stranded.pending;
    assert.equal(row!.intentId, second.intentId, 'the same row, in a different state');
    assert.equal(row!.baselineSeal, sealBefore);
    assert.equal(row!.currentSeal, sealAfter);
    assert.deepEqual(row!.decidability, {
      decidable: false,
      refusal: CRITERIA_DECISION_BASE_SEAL_MOVED,
      requiredAction: CRITERIA_DECISION_REFILE_ACTION,
    }, 'a reader told only "no" cannot act; the row carries the refusal and what clears it');

    // And the fact derived from a stranded row does not exist at all: a card whose only button is
    // refused whichever way it is pressed is the thing this predicate is here to stop.
    assert.equal(
      criteriaDecisionPendingFact(f.projectId, row!), null,
      'an undecidable proposal produces no wake fact, so no key is spent asking an unanswerable '
      + 'question',
    );
  });
});

test('holding a loosening edit puts one message on the coordinator conversation', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const stack = connect(url);
  t.after(async () => { await stack.db.$disconnect().catch(() => undefined); });
  const db = stack.db;

  /** State a whole collection for one project, through the owner's path. */
  async function state(
    f: Fixture,
    items: Array<{ id?: string; text: string; verificationMethod?: string }>,
  ): Promise<Held | null> {
    const response = await stack.projects.update(f.ownerId, f.projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: item.verificationMethod ?? METHOD,
      })),
    } as never) as unknown as { acceptanceCriteriaHold?: Held };
    return response.acceptanceCriteriaHold ?? null;
  }

  async function definitionIds(f: Fixture): Promise<string[]> {
    const rows = await db.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: f.projectId },
      orderBy: { ordinal: 'asc' },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  // ═══ (4) the positive: a held edit becomes one turn on the standing conversation ══════════════
  await t.test('(4) the write that holds the edit is the write that delivers the card', async () => {
    const f = await fixture(db, 'card');
    assert.equal(await state(f, [{ text: FIRST }, { text: SECOND }, { text: THIRD }]), null);
    const ids = await definitionIds(f);
    assert.deepEqual(await coordinatorMessages(db, f), [],
      'three ADDITIVE statements delivered nothing — an applied edit asks nobody anything');
    assert.deepEqual(await projectWakes(db, f.projectId), []);

    const held = await state(f, [{ id: ids[0]!, text: FIRST }, { id: ids[1]!, text: SECOND }]);
    assert.ok(held, 'the edit under test has to be one that gets held');

    // ── the fact ended on the conversation the project already has ──────────────────────────────
    const wakes = await projectWakes(db, f.projectId);
    assert.equal(wakes.length, 1, 'one held proposal, one wake');
    assert.equal(wakes[0]!.event, 'CRITERIA_DECISION_PENDING');
    assert.equal(wakes[0]!.status, 'DELIVERED');
    assert.equal(wakes[0]!.sessionId, f.coordinatorSessionId,
      'delivered TO the standing conversation — this path creates no session of its own');

    const fact = criteriaDecisionPendingFact(f.projectId, {
      intentId: held.intentId,
      actionDigest: held.actionDigest,
      baselineSeal: held.baselineSeal,
      decidability: { decidable: true },
    })!;
    assert.equal(wakes[0]!.idempotencyKey, wakeIdempotencyKey(fact),
      'and under the key the fact itself derives, so a re-derivation collapses onto this one');

    const messages = await coordinatorMessages(db, f);
    assert.equal(messages.length, 1, 'exactly one message, and it is this fact’s');
    assert.equal(messages[0]!.clientTurnId, coordinatorDeliveryTurnId(wakeIdempotencyKey(fact)),
      'under the turn key derived from the fact, so a second delivery replays rather than repeats');

    // ── and what it says is the question, not an instruction to answer it ────────────────────────
    const body = messages[0]!.content ?? '';
    assert.ok(body.includes(describeWakeFact(fact)),
      'one event, one description — the card renders the fact through the shared renderer');
    assert.ok(body.includes(held.intentId), 'the card names the proposal it is about');
    assert.ok(body.includes(`${THIRD}（被这份提案删掉）`),
      'and carries the diff, which is nowhere else: the words this proposal DROPS are stated by '
      + 'nothing in it, so a message built out of the proposal alone could not name them — and it '
      + 'says of them that they are what goes, which is the whole of what is being asked');
    assert.ok(!body.includes(FIRST) && !body.includes(SECOND),
      'while the two it restates word for word are not laid out again — a restatement carries the '
      + 'whole collection, and printing it back is how the one row that moved got lost in it');
    assert.ok(body.includes('未改动 2 条'),
      'and it says how much of the ruler is left alone, because one dropped criterion out of '
      + 'three and one out of eight are not the same decision to hand on');
    assert.ok(body.includes('账号所有者'),
      'the action is to hand it to the person who may answer, because this reader may not');
    assert.ok(body.includes('这是一条通知，不是打断'),
      'a message is a notification and never an interrupt, and the message says so');
    assert.doesNotMatch(body, /发生了 CRITERIA_DECISION_PENDING/,
      'the renderer’s default arm is silent about a missing case; this asserts it was not taken');

    // The read is still the read: a delivered card changes nothing about the ledger it was
    // derived from, so the floor under it holds exactly what it held.
    const queue = await readPendingCriteriaDecisions(db as never, f.ownerId, f.projectId);
    assert.deepEqual(
      [queue.count, queue.pending[0]?.intentId, queue.pending[0]?.decidability.decidable],
      [1, held.intentId, true],
      'the card is the delivery; this read is the floor, and delivering did not spend it',
    );
  });

  // ═══ (4b) the arm the only proposal ever held actually takes ══════════════════════════════════
  await t.test('(4b) a reworded criterion is delivered with the words it replaces', async () => {
    // 1GB4IZ4B — replayed in (6) below — reworded three of its eight criteria and dropped none, so
    // every row it moved renders through this arm and not one through (4)'s. Both sides of a
    // rewrite have to be carried: "changed to X" is unreadable without the words X replaces, and
    // that side is on record rather than in the proposal, so the message is the only place a
    // reader holding the proposal can find them.
    const f = await fixture(db, 'reworded');
    assert.equal(await state(f, [{ text: FIRST }, { text: SECOND }, { text: THIRD }]), null);
    const ids = await definitionIds(f);
    const reworded = 'the criterion this fixture rewrites, whose earlier words are only on record';

    const held = await state(f, [
      { id: ids[0]!, text: FIRST }, { id: ids[1]!, text: SECOND }, { id: ids[2]!, text: reworded },
    ]);
    assert.ok(held, 'rewording a criterion cannot be read as a tightening, so it is held');

    const messages = await coordinatorMessages(db, f);
    assert.equal(messages.length, 1, 'one held proposal, one message');
    const body = messages[0]!.content ?? '';
    assert.ok(body.includes(`${reworded}（被这份提案改写）`),
      'the words the proposal asks for are in the message, named as the rewrite they are');
    assert.ok(body.includes(`现在在册的是：${THIRD}`),
      'and so are the words they would replace, which the proposal states nowhere: an edit '
      + 'restates the collection it WANTS, so the wording being retired survives only on the '
      + 'record this message was built against');
    assert.ok(!body.includes(FIRST) && !body.includes(SECOND),
      'while the two that came back word for word stay out, as in (4): one rewritten criterion '
      + 'out of three is not three criteria to read');
    assert.ok(body.includes('未改动 2 条'),
      'and how much of the ruler was left alone is stated rather than counted off the fold');
    assert.ok(!body.includes('判定方法'),
      'the half that did not move says nothing: these procedures came back identical');
  });

  // ═══ (4c) the row whose two sides read the same, because the words are not what moved ═════════
  await t.test('(4c) a criterion whose procedure alone moved says which half moved', async () => {
    // The assertion is untouched and the way it is judged is not, so the row's two sides are the
    // same sentence. Everything that distinguishes this proposal from a no-op is in the two lines
    // about the procedure; without them the message names a rewrite and states nothing rewritten.
    const f = await fixture(db, 'procedure-card');
    assert.equal(await state(f, [{ text: FIRST }, { text: SECOND }]), null);
    const ids = await definitionIds(f);
    const loosened = 'somebody says it looks fine';

    const held = await state(f, [
      { id: ids[0]!, text: FIRST, verificationMethod: loosened }, { id: ids[1]!, text: SECOND },
    ]);
    assert.ok(held, 'rewriting how a criterion is judged cannot be read as a tightening either');

    const messages = await coordinatorMessages(db, f);
    assert.equal(messages.length, 1, 'one held proposal, one message');
    const body = messages[0]!.content ?? '';
    assert.ok(body.includes(`判定方法改成：${loosened}`),
      'the procedure the proposal asks for is in the message');
    assert.ok(body.includes(`现在在册的判定方法：${METHOD}`),
      'and the one it would replace — the pair is the whole of what this proposal does, and a '
      + 'card that carried neither would be a rewrite nobody can see');
    assert.ok(body.includes(`${FIRST}（被这份提案改写）`),
      'the criterion is named by its own words, identical on both sides as they are');
    assert.ok(!body.includes('现在在册的是：'),
      'and no wording is quoted back as replaced, because none was: the two sides of `text` agree');
    assert.ok(!body.includes(SECOND), 'the one left alone stays out of it');
    assert.ok(body.includes('未改动 1 条'), 'and it is counted, as everywhere else');
  });

  // ═══ (5) the negative, paired with (4) over the same code ═════════════════════════════════════
  await t.test('(5) a conversation that ended is not revived, and the key goes back', async () => {
    const f = await fixture(db, 'ended', { coordinatorStatus: RunStatus.SUCCEEDED });
    assert.equal(await state(f, [{ text: FIRST }, { text: SECOND }, { text: THIRD }]), null);
    const ids = await definitionIds(f);

    const held = await state(f, [{ id: ids[0]!, text: FIRST }, { id: ids[1]!, text: SECOND }]);
    assert.ok(held, 'the edit is held whether or not anybody can be told about it');

    assert.deepEqual(await coordinatorMessages(db, f), [],
      'a conversation the person ended is not resurrected to be told about a proposal');
    const wakes = await projectWakes(db, f.projectId);
    assert.equal(wakes.length, 1, 'the fact was claimed — this is a refusal, not an absence');
    assert.equal(wakes[0]!.status, 'REFUSED');
    assert.equal(wakes[0]!.refusalCode, DELIVERY_COORDINATOR_SESSION_UNAVAILABLE);
    assert.equal(wakes[0]!.sessionId, null);
    const ended = await db.session.findUniqueOrThrow({
      where: { id: f.coordinatorSessionId },
      select: { status: true },
    });
    assert.equal(ended.status, RunStatus.SUCCEEDED, 'and the conversation is still ended');

    // The half that makes the refusal survivable: the question did not go with the card.
    const queue = await readPendingCriteriaDecisions(db as never, f.ownerId, f.projectId);
    assert.deepEqual(
      [queue.count, queue.pending[0]?.intentId, queue.pending[0]?.decidability.decidable],
      [1, held.intentId, true],
      'undelivered is not unasked: the proposal is a shape the rows have, so it is still here',
    );
    // And the effect class is what makes "the weakening proposals of this project" a set rather
    // than a convention, so the read that found it above is finding the right rows.
    const intents = await db.projectRatifiedActionIntent.findMany({
      where: { projectId: f.projectId },
      select: { effectClass: true },
    });
    assert.deepEqual(intents.map((intent) => intent.effectClass), [CRITERIA_WEAKENING_EFFECT_CLASS]);
  });

  // ═══ (6) the copy the two cards above share, over a snapshot that has moved on ════════════════
  await t.test('(6) a card whose proposal is already gone says so instead of rendering a diff',
    async () => {
      const fact = criteriaDecisionPendingFact('00000000-0000-7000-8000-00000000c0de', {
        intentId: '00000000-0000-7000-8000-00000000beef',
        actionDigest: 'd'.repeat(64),
        baselineSeal: 'e'.repeat(64),
        decidability: { decidable: true },
      })!;
      const gone = buildCoordinatorDeliveryMessage(fact, '空账本', null, {
        readAt: new Date('2026-09-09T00:00:00.000Z'),
        projectId: fact.projectId,
        count: 0,
        oldestAgeSeconds: null,
        decidableCount: 0,
        pending: [],
      });
      assert.ok(gone.includes('已经不是这个项目的待决提案了'),
        'the read happens at delivery, so a proposal answered in between is reported as answered');
      assert.ok(gone.includes('这是一条通知，不是打断'),
        'and the carrier’s own sentence is on every branch of this card, not just the happy one');
      assert.doesNotMatch(gone, /发生了 CRITERIA_DECISION_PENDING/);
    });
});

/**
 * The switched-off control for `CRITERIA_DECISION_PENDING`, registered in
 * `coordinator-disabled-negatives.spec.ts`.
 *
 * A top-level case rather than a subtest of the two above, because that census attributes an
 * assertion to the `test('...')` it was written in and a subtest is invisible to it — and because
 * what it states is a different claim from either: not "the card went out" and not "the card could
 * not go out", but "the owner turned this project's coordinator off, and the producer honoured it
 * BEFORE anything was written to any conversation".
 *
 * Its paired positive is `(4)` above, over the same producer and the same write: the only
 * difference between the two fixtures is one boolean column. Without that pair, every assertion
 * here would be equally true of a producer nobody calls.
 */
test('a switched-off coordinator is refused once, told nothing, and opens nothing', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const stack = connect(url);
  t.after(async () => { await stack.db.$disconnect().catch(() => undefined); });
  const db = stack.db;
  const f = await fixture(db, 'switched-off', { coordinatorEnabled: false });

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

  assert.equal(await state([{ text: FIRST }, { text: SECOND }, { text: THIRD }]), null);
  const ids = (await db.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId: f.projectId },
    orderBy: { ordinal: 'asc' },
    select: { id: true },
  })).map((row) => row.id);

  const held = await state([{ id: ids[0]!, text: FIRST }, { id: ids[1]!, text: SECOND }]);
  assert.ok(held, 'the edit is held whatever the switch says — holding it is not a notification');

  // Refused ONCE, on the switch, and not silently: the wake row is claimed before it is
  // authorized, so a fact that travelled the whole way and lost carries the reason it lost.
  const wakes = await projectWakes(db, f.projectId);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.event, 'CRITERIA_DECISION_PENDING');
  assert.equal(wakes[0]!.status, 'REFUSED');
  assert.equal(wakes[0]!.refusalCode, HELD_CRITERIA_WAKE_COORDINATOR_DISABLED);
  assert.equal(wakes[0]!.sessionId, null);
  assert.deepEqual(await judgmentSessions(db, f.ownerId), [],
    'and no conversation was opened either — this producer opens none in any case');
  assert.deepEqual(await coordinatorMessages(db, f), [],
    'the standing conversation was told nothing');

  // The question survives the switch, which is the difference between "nobody was told" and
  // "nobody was asked": the read is derived from the proposal, not from the delivery.
  const queue = await readPendingCriteriaDecisions(db as never, f.ownerId, f.projectId);
  assert.deepEqual(
    [queue.count, queue.pending[0]?.intentId, queue.pending[0]?.decidability.decidable],
    [1, held.intentId, true],
  );
});

/**
 * THE REAL PROPOSAL, REPLAYED — AND WHAT THE READ CONCLUDES ABOUT IT
 * ==================================================================
 *
 * `project_update(acceptanceCriteriaItems)` is a whole-collection replacement, so an edit that
 * rewords three criteria out of eight arrives stating all eight. `proposed` is that restatement
 * verbatim, because it is the material `actionDigest` is taken over — which means it cannot say
 * WHICH of the eight moved, and a card drawn from it can only lay out all eight. That is what the
 * first weakening proposal Orbit ever held (intent 1GB4IZ4B) did to its reader: the three that
 * moved were buried inside the other five, and the account owner's words afterwards were "it
 * should only show what changed".
 *
 * So the read carries a diff, and this is where the diff is measured — on that proposal, not on a
 * made-up one. It was approved on 2026-09-09 and so cannot be read back out of the pending queue
 * any more; `criteria-weakening-1GB4IZ4B.fixture.json` is the record of it, and the web card's own
 * spec renders from the same file, so "the same input" is one fact on disk rather than two
 * examples free to drift apart.
 *
 * WHAT MAKES THIS A TEST OF THE READ AND NOT OF THE FIXTURE. The two sets go in through the
 * PRODUCTION write path — the eight are stated, then restated with three rewritten — so what comes
 * back is a proposal the ordinary machinery filed, and the diff is taken by the read against the
 * definition rows that write left behind. Nothing here hands the read an answer: the fixture
 * records what the comparison IS to conclude, and the assertion is that it did.
 */
const RECORDED_PROPOSAL = path.resolve(
  __dirname, '../../src/projects/criteria-weakening-1GB4IZ4B.fixture.json',
);

interface RecordedProposal {
  intentPublicId: string;
  onRecord: Array<{ ordinal: number; text: string; verificationMethod: string }>;
  proposed: Array<{
    ordinal: number; retains: number | null; text: string; verificationMethod: string;
  }>;
  expected: {
    sameCount: number; changedCount: number; newCount: number; removedCount: number;
    entries: Array<{
      ordinal: number; change: string; changed: string[];
      /** On the CHANGED ones: the clause that moved, which is what the cut must land on — and a
       *  stretch of the same sentence that did not, which is what it must leave alone. */
      movedClause?: { removed: string; added: string };
      stoodFast?: string;
    }>;
  };
}

test('the read says which of a restated collection actually moved', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const stack = connect(url);
  t.after(async () => { await stack.db.$disconnect().catch(() => undefined); });
  const db = stack.db;
  const recorded = JSON.parse(readFileSync(RECORDED_PROPOSAL, 'utf8')) as RecordedProposal;

  /** State a whole collection, each criterion with its own words AND its own procedure. */
  async function state(
    f: Fixture,
    items: Array<{ id?: string; text: string; verificationMethod: string }>,
  ): Promise<Held | null> {
    const response = await stack.projects.update(f.ownerId, f.projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: item.verificationMethod,
      })),
    } as never) as unknown as { acceptanceCriteriaHold?: Held };
    return response.acceptanceCriteriaHold ?? null;
  }

  async function definitionIds(f: Fixture): Promise<string[]> {
    return (await db.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: f.projectId },
      orderBy: { ordinal: 'asc' },
      select: { id: true },
    })).map((row) => row.id);
  }

  await t.test('(6) eight criteria restated to reword three read out as three changes', async () => {
    const f = await fixture(db, 'replay');
    assert.equal(
      await state(f, recorded.onRecord.map((each) => ({
        text: each.text, verificationMethod: each.verificationMethod,
      }))),
      null,
      'stating a project’s first criteria is ADDITIVE and lands where it is made',
    );
    const ids = await definitionIds(f);
    assert.equal(ids.length, recorded.onRecord.length, 'the set on record is the recorded one');

    const held = await state(f, recorded.proposed.map((each) => ({
      ...(each.retains === null ? {} : { id: ids[each.retains - 1]! }),
      text: each.text,
      verificationMethod: each.verificationMethod,
    })));
    assert.ok(held, 'a rewording cannot be read as a tightening, so it is held');

    const queue = await readPendingCriteriaDecisions(db as never, f.ownerId, f.projectId);
    assert.equal(queue.count, 1);
    const [row] = queue.pending;
    assert.equal(row!.intentId, held.intentId);

    // The positive control under every count below: the WHOLE collection was restated, so a card
    // built from `proposed` alone would have eight rows to lay out and no way to pick three.
    assert.equal(row!.proposed.length, recorded.proposed.length,
      'the request restated the whole collection — that is what makes the diff necessary');

    assert.deepEqual(
      [row!.diff.changedCount, row!.diff.sameCount, row!.diff.newCount, row!.diff.removedCount],
      [recorded.expected.changedCount, recorded.expected.sameCount,
        recorded.expected.newCount, recorded.expected.removedCount],
      'three of the eight moved and five did not, which is what the owner was never shown',
    );
    assert.deepEqual(
      row!.diff.entries.map((entry) => ({
        ordinal: entry.ordinal, change: entry.change, changed: entry.changed,
      })),
      recorded.expected.entries.map((each) => ({
        ordinal: each.ordinal, change: each.change, changed: each.changed,
      })),
      'and WHICH three: the read names them, in the ordinals a reader sees on the card',
    );

    // Each rewrite carries BOTH sides, which is the thing `proposed` could never carry: the
    // baseline's words are not stored on the proposal at all (`action.baseline.material` is
    // `(definitionId, revision, contentHash)`), so "what it replaces" can only come from the
    // definitions in force.
    for (const entry of row!.diff.entries) {
      const stated = recorded.proposed.find((each) => each.ordinal === entry.ordinal)!;
      const before = recorded.onRecord.find((each) => each.ordinal === entry.ordinal)!;
      assert.equal(entry.proposed?.text, stated.text, `the proposed words of ${entry.ordinal}`);
      assert.equal(entry.onRecord?.text, before.text, `what ${entry.ordinal} would replace`);
      assert.equal(entry.definitionId, ids[entry.ordinal - 1],
        'matched by the definition the request named, never by position');
    }

    // WHERE INSIDE THE SENTENCE, not only which sentence. Each rewrite comes back cut into the
    // runs it keeps, drops and adds, so a card can print one merged line instead of the two whole
    // paragraphs that overflowed the 360px box this is read in. The cut is pinned in full by
    // `criteria-inline-diff.spec.ts`, which needs no database; what is asserted HERE is that it
    // survives the production write path and the derived read — the clause the fixture records as
    // the thing that moved is what came back marked as moved, off rows Postgres handed over.
    for (const entry of row!.diff.entries) {
      const clause = recorded.expected.entries
        .find((each) => each.ordinal === entry.ordinal)?.movedClause;
      if (entry.change !== 'CHANGED') {
        assert.deepEqual(entry.rewrites, [],
          `criterion ${entry.ordinal} did not move, so there are not two versions of it to cut`);
        continue;
      }
      assert.ok(clause, `the fixture records no moved clause for criterion ${entry.ordinal}`);
      const cut = entry.rewrites.find((each) => each.field === 'text');
      assert.ok(cut, `criterion ${entry.ordinal} moved its text and carries no cut of it`);
      const side = (want: string): string => cut.segments
        .filter((piece) => piece.side === want).map((piece) => piece.text).join('');
      assert.ok(side('REMOVED').includes(clause.removed),
        `criterion ${entry.ordinal}: the dropped clause is not in what the cut marks removed`);
      assert.ok(side('ADDED').includes(clause.added),
        `criterion ${entry.ordinal}: the new clause is not in what the cut marks added`);
      assert.ok(!side('KEPT').includes(clause.removed),
        `criterion ${entry.ordinal}: the dropped clause is inside the runs marked unchanged`);
      // And the sentence around it is still reported as standing, which is the whole saving: a
      // cut that gave up and marked both versions whole would leave this at zero.
      const stood = recorded.expected.entries
        .find((each) => each.ordinal === entry.ordinal)?.stoodFast;
      assert.ok(stood, `the fixture records nothing that stood for criterion ${entry.ordinal}`);
      assert.ok(side('KEPT').includes(stood),
        `criterion ${entry.ordinal}: "${stood}" is in both versions and is not marked unchanged`);
      assert.ok(side('KEPT').length >= Math.min(
        entry.onRecord!.text.length, entry.proposed!.text.length,
      ) * (2 / 3), `criterion ${entry.ordinal}: too little of the sentence is marked unchanged`);
    }

    // And nothing moved: a held edit writes no definition, so the words this diff compares against
    // are still the words in force.
    const after = await db.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: f.projectId }, orderBy: { ordinal: 'asc' }, select: { text: true },
    });
    assert.deepEqual(after.map((each) => each.text), recorded.onRecord.map((each) => each.text),
      'the criteria on record are the ones that were on record');
  });

  await t.test('(7) a criterion whose PROCEDURE alone was rewritten is a change too', async () => {
    // `text` byte for byte, `verificationMethod` rewritten. An edit that leaves the assertion
    // alone and rewrites how a reader decides it holds has still changed what the project has to
    // prove, and a comparison that read `text` only would call this proposal a no-op.
    const f = await fixture(db, 'procedure');
    assert.equal(
      await state(f, [
        { text: FIRST, verificationMethod: METHOD },
        { text: SECOND, verificationMethod: METHOD },
      ]),
      null,
    );
    const ids = await definitionIds(f);
    const loosened = 'somebody says it looks fine';
    const held = await state(f, [
      { id: ids[0]!, text: FIRST, verificationMethod: loosened },
      { id: ids[1]!, text: SECOND, verificationMethod: METHOD },
    ]);
    assert.ok(held, 'rewriting a procedure cannot be read as a tightening either');

    const queue = await readPendingCriteriaDecisions(db as never, f.ownerId, f.projectId);
    const [row] = queue.pending;
    assert.deepEqual(
      [row!.diff.changedCount, row!.diff.sameCount], [1, 1],
      'one criterion moved and one did not, though every `text` came back identical',
    );
    const [first, second] = row!.diff.entries;
    assert.deepEqual([first!.change, first!.changed], ['CHANGED', ['verificationMethod']],
      'the field that moved is named, so a card can show that half and not the other');
    assert.equal(first!.proposed?.verificationMethod, loosened);
    assert.equal(first!.onRecord?.verificationMethod, METHOD, 'and the procedure it replaces');
    assert.equal(first!.proposed?.text, first!.onRecord?.text,
      'the assertion is untouched — this is the case a text-only comparison would miss');
    assert.equal(second!.change, 'SAME');
  });

  await t.test('(8) what is dropped and what is added are expressible at all', async () => {
    // The shape the old row could not state: a proposal that DROPS a criterion carries one row
    // fewer, and there is nothing in a restatement to hang "and this one is going" on.
    const f = await fixture(db, 'dropped');
    assert.equal(
      await state(f, [
        { text: FIRST, verificationMethod: METHOD },
        { text: SECOND, verificationMethod: METHOD },
        { text: THIRD, verificationMethod: METHOD },
      ]),
      null,
    );
    const ids = await definitionIds(f);
    const held = await state(f, [
      { id: ids[0]!, text: FIRST, verificationMethod: METHOD },
      { text: TIGHTENING, verificationMethod: METHOD },
    ]);
    assert.ok(held, 'dropping two criteria to add one is held');

    const queue = await readPendingCriteriaDecisions(db as never, f.ownerId, f.projectId);
    const [row] = queue.pending;
    assert.deepEqual(
      [row!.diff.sameCount, row!.diff.changedCount, row!.diff.newCount, row!.diff.removedCount],
      [1, 0, 1, 2],
      'one kept, one added, two dropped — a count `proposed` cannot produce, since the two that '
      + 'went are not in it',
    );
    assert.deepEqual(
      row!.diff.entries.map((entry) => [entry.change, entry.ordinal]),
      [['SAME', 1], ['NEW', 2], ['REMOVED', 2], ['REMOVED', 3]],
      'the proposal’s own order first, then the criteria it does not restate, at their places',
    );
    const dropped = row!.diff.entries.filter((entry) => entry.change === 'REMOVED');
    assert.deepEqual(dropped.map((entry) => entry.onRecord?.text), [SECOND, THIRD],
      'and in the words that would go, which is the only place they are still written down');
    assert.deepEqual(dropped.map((entry) => entry.proposed), [null, null],
      'a dropped criterion has no proposed side: the proposal states none');
    const added = row!.diff.entries.find((entry) => entry.change === 'NEW');
    assert.deepEqual([added!.onRecord, added!.definitionId], [null, null],
      'and an added one replaces nothing, so it names no definition and has no other side');
  });
});

/**
 * THE OTHER WAY A PROPOSAL IS ANSWERED, AND WHAT ANSWERING IT LEAVES BEHIND.
 *
 * (2) above settles a proposal the only way 0195's own tables can express: a commit row, which
 * says the proposal was APPLIED. A REJECT has no such row and never will — the door records both
 * outcomes in `project_criteria_decision`, keyed by the intent and never reading `decision` back
 * out, because a proposal that was turned down is as answered as one that was applied.
 *
 * WHY THE TWO CASES HERE ARE ONE ARGUMENT AND NOT TWO
 * --------------------------------------------------
 * "Answered" is asked from two sides, and the sides have to agree. This read asks it to decide
 * what is still a question; `ProjectsService.pendingWeakeningProposal` asks it to decide whether an
 * arriving edit is the proposal already on record. Disagreeing is not a cosmetic drift: a rejected
 * proposal that stays pending on the WRITE side makes the very edit the owner turned down
 * unaskable — re-making it takes the identical-ask branch, so nothing new is filed and the caller
 * is handed back an id whose one-time `commitToken` is spent, which the door answers with
 * ALREADY_SETTLED and nothing else. "No" to this ask has to leave it re-proposable.
 *
 *   (9) a REJECT settles the proposal: it leaves this read, the criteria do not move, and the
 *       intent row is still on record — because settled is DERIVED from a second row and never by
 *       editing the proposal, which 0195's trigger refuses.
 *   (10) and the same edit, re-sent byte for byte, files a NEW proposal that supersedes nothing.
 *
 * (9) CARRIES ITS OWN POSITIVE CONTROL, and it is the whole reason (10) means anything: before the
 * rejection, the identical re-send is made ONCE and the SAME id comes back with no row filed. That
 * branch is a real rule this change must not have deleted, so (10)'s "a new proposal was filed" is
 * a statement about the decision row rather than about a write path that files one every time. The
 * only thing that differs between the two re-sends is that one `project_criteria_decision` row.
 *
 * The write path's own half of this is `criteria-pending-excludes-settled.pg.spec.ts`, over the
 * censuses that say no criterion moved on the way past. This file's subject is the derived read.
 */
test('a rejected proposal is answered too, and the ask it turned down can be made again', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const stack = connect(url);
  t.after(async () => { await stack.db.$disconnect().catch(() => undefined); });
  const db = stack.db;
  const f = await fixture(db, 'rejected');

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

  /** The definition rows as the database holds them, in the order the write path restates them. */
  async function definitions(): Promise<Array<{ id: string; text: string }>> {
    return db.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: f.projectId },
      orderBy: { ordinal: 'asc' },
      select: { id: true, text: true },
    });
  }

  /** Every proposal this project has filed, oldest first — what "a NEW one" is counted against. */
  async function proposals(): Promise<string[]> {
    const rows = await db.projectRatifiedActionIntent.findMany({
      where: { projectId: f.projectId, effectClass: CRITERIA_WEAKENING_EFFECT_CLASS },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** The read under test, always for this owner and this project. */
  function pending() {
    return readPendingCriteriaDecisions(db as never, f.ownerId, f.projectId);
  }

  /**
   * The two other readers that ask "answered" through `stillUnanswered`: the owner's own rail,
   * which carries the key, and the badge, which only counts. The coordinator's card is composed
   * from `pending()` itself, so it needs no line of its own here.
   */
  async function otherReaders() {
    return {
      ownerRail: (await stack.projects.pendingCriteriaDecisions(f.ownerId, f.projectId))
        .pending.map((row) => row.intentId),
      badge: (await readOwnerDecisionSignals(db as never, f.ownerId)).map((signal) => signal.count),
    };
  }

  // ── the fixture: three criteria, then the loosening edit this case turns down ─────────────────
  assert.equal(await state([{ text: FIRST }, { text: SECOND }, { text: THIRD }]), null,
    'stating a project’s first criteria is ADDITIVE and is never held');
  const before = await definitions();
  assert.equal(before.length, 3, 'the fixture starts with three criteria');
  /** The edit under test, restated byte for byte on both sides of the rejection. */
  const drops = [{ id: before[0]!.id, text: FIRST }, { id: before[1]!.id, text: SECOND }];

  const held = await state(drops);
  assert.ok(held, 'dropping a criterion is a loosening and has to be held');
  const opening = await pending();
  assert.deepEqual(
    [opening.count, opening.pending[0]?.intentId, opening.pending[0]?.decidability.decidable],
    [1, held.intentId, true],
    'the proposal is a question before anybody answers it — otherwise (9) proves nothing',
  );
  assert.deepEqual(await otherReaders(), { ownerRail: [held.intentId], badge: [1] },
    'and the owner’s rail and the badge are asking it too, so their empty answers in (9) are about '
    + 'the rejection and not about a fixture neither of them can see');

  // ═══ (9) a REJECT settles it ══════════════════════════════════════════════════════════════════
  await t.test('(9) a rejected proposal leaves this read, and takes no criterion with it',
    async () => {
      // THE POSITIVE CONTROL, made while the proposal is still unanswered: the same ask against
      // the same ruler is the proposal already on record, and re-sending it files nothing. Without
      // this, (10) below would be equally true of a write path with no identical-ask branch at all.
      const again = await state(drops);
      assert.equal(again?.intentId, held.intentId,
        'an unanswered proposal is handed back, because re-filing it would displace it with a copy');
      assert.deepEqual(await proposals(), [held.intentId], 'and no second row was filed');

      // The owner answers it. The token is read out of the table because the response deliberately
      // does not carry it — the proposer holds an address and nothing that could act on one — and
      // a test standing in for the account owner is exactly the party that does hold the key.
      const proposal = await db.projectRatifiedActionIntent.findUniqueOrThrow({
        where: { id: held.intentId },
        select: { commitToken: true },
      });
      const sealBefore = (await stack.acceptance.standardSetConfirmation(f.ownerId, f.projectId))
        .currentVersion.digest;
      const decided = await stack.projects.decideCriteriaChange(
        f.ownerId, f.projectId, held.intentId,
        { commitToken: proposal.commitToken, decision: 'REJECT', baseSeal: sealBefore } as never,
      );
      assert.equal(decided.decision, 'REJECT');
      assert.equal(decided.applied, false, 'a REJECT moves no criterion; it answers the question');

      const queue = await pending();
      assert.deepEqual([queue.count, queue.decidableCount, queue.pending], [0, 0, []],
        'a proposal the owner turned down is answered, and an answered question is not a question');
      assert.deepEqual(await otherReaders(), { ownerRail: [], badge: [] },
        'and it leaves the owner’s rail and the badge at the same moment: all three compose the '
        + 'one predicate, so none of them can go on asking what the other two call answered');

      // What a REJECT is NOT: an edit of the proposal, and not an edit of the criteria either.
      assert.ok(await db.projectRatifiedActionIntent.findUnique({ where: { id: held.intentId } }),
        'the proposal is still on record — settled is a second row, never a write to this one');
      assert.deepEqual(await definitions(), before,
        'and the ruler did not move: the criteria are the three the fixture stated');
      // The half 0195 can express is absent, which is what makes this a test of the decision row:
      // a REJECT writes no commit, so the commit clause alone would still call this pending.
      assert.equal(
        await db.projectRatifiedActionCommit.findUnique({ where: { intentId: held.intentId } }),
        null,
        'nothing was committed, so "settled" here is the decision row and nothing else',
      );
    });

  // ═══ (10) and the ask can be made again ═══════════════════════════════════════════════════════
  await t.test('(10) the same edit, re-sent byte for byte, becomes a proposal of its own',
    async () => {
      const refiled = await state(drops);
      assert.ok(refiled, 'the same edit is still a loosening, so it is still held');
      assert.notEqual(refiled.intentId, held.intentId,
        'a NEW proposal: the rejected one’s commit token is spent, so handing its id back would '
        + 'point the caller at a proposal the door refuses ALREADY_SETTLED and nothing else',
      );
      assert.equal(refiled.supersededIntentId, null,
        'and it displaced nothing — a settled proposal is not a pending one to be superseded');
      assert.deepEqual(await proposals(), [held.intentId, refiled.intentId],
        'two rows, because a rejected ask being made again is a new question and not an edit');

      const queue = await pending();
      assert.deepEqual(
        [queue.count, queue.pending[0]?.intentId, queue.pending[0]?.decidability.decidable],
        [1, refiled.intentId, true],
        'exactly the new one is waiting: the rejected proposal did not come back with it',
      );
      assert.deepEqual(await definitions(), before,
        'and asking again applied nothing either — this edit is still held, not landed');
    });
});

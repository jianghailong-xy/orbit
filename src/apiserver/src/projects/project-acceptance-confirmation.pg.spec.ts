/**
 * `CONFIRM_ACCEPTANCE_CRITERIA` has a door, and the door records a VERSION.
 *
 * WHAT WAS MISSING
 * ----------------
 * The action has been graded HUMAN_ONLY since unit T6 and has carried a refusal message of its own
 * (`coordinator-authority.ts`) — and no writer anywhere in the repository. So the one act the
 * authority table reserves for the account owner was an act the account owner had no way to
 * perform: the name appeared in the table, in the refusal text and in two specs, and nowhere else.
 * Migration 0245 gives it a place to land and `ProjectAcceptanceService.confirmStandardSet` is the
 * one writer.
 *
 * WHICH DOOR, AND WHY THIS ONE
 * ----------------------------
 * (B), decided in `docs/human-only-authority.md` §"A2 follow-up (2026-09-08)": the confirmation is
 * written through the owner-authenticated channel, and a card a person answers inside a
 * coordinator conversation prompts and links rather than pressing the button for them. The design
 * review's own finding is why: an `Approval` row has no project, action or digest column, so the
 * only field that could say WHICH write it authorises is `input`, which is stored verbatim from
 * the agent's own tool call. A permission carried there would be a permission whose subject is
 * agent-authored text, and the deliverable this tier actually has — an action-specific, durable
 * record of what was confirmed — is exactly what that discards.
 *
 * So the rule under test is a session rule and not a role rule: ANY acting session is refused,
 * whatever its dispatch origin. `refuseHumanOnlyAction` refuses only the one-shot judgment origin,
 * because widening it would change what doors that already worked accept; this door had no caller
 * to preserve, so it is the shape the tier describes from its first day.
 *
 * WHY A VERSION AND NOT A FLAG
 * ----------------------------
 * Both HUMAN_ONLY rows are about the RULER — editing defines the exam, confirming says the
 * complete exam expresses the goal — and they exist because whoever moves the ruler can make any
 * conclusion come out right. A confirmation that named no version would move with the ruler and
 * protect nothing. The version is `criteriaSemanticRevision`, which the repository already had:
 * each criterion's `definitionId:revision:contentHash`, sorted and hashed. `(3)` below is the
 * whole point — an edit lands and the confirmation stops counting, with no flag anybody had to
 * remember to clear.
 *
 * WHAT ELSE THE CONFIRMATION DOES
 * -------------------------------
 * It starts the project. `ProjectsService.create` no longer writes `coordinator_enabled`, so a new
 * project lands on the column's false and the coordinator may do nothing until a person has said
 * what would settle it — which makes this door the one authorization to work on a project, and its
 * HUMAN_ONLY refusal the thing that stops an agent from authorising its own. `(5)` asserts both
 * halves on the row itself, and `(6)` the other door into that column: `ProjectsService.update`
 * takes the switch on its own, with no second field to name — which it did not until 0292, when
 * `assertLevelNamedWhenTurningOn` still answered a one-field request with a 400. `(7)` is who
 * hears of the start: the conversation the project is coordinated from is told, once, which of its
 * tasks nothing will start but that conversation.
 *
 * WHY THIS IS A `.pg.spec`
 * ------------------------
 * Every fact here is produced the way the product produces it. Criteria are stated and edited
 * through `ProjectsService.update`, which is the only thing that advances a definition's
 * `revision` — the advance happens in `project_acceptance_definition_normalize`, a trigger, so a
 * double handing the service canned rows would be testing this file's arithmetic instead of the
 * database's. The sessions in `(2)` are real `session` rows with real dispatch origins, and the
 * row `(1)` asserts is read back with SQL rather than through the projection that wrote it.
 *
 *   bash scripts/run-pg-spec.sh \
 *     src/apiserver/src/projects/project-acceptance-confirmation.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  CreatorType,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { projectStartedTurnId } from './project-started';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/**
 * The verification method the criteria declare. Never the thing under test — except in `(4)`.
 *
 * A rung of the HUMAN → VERIFICATION → EXECUTABLE ladder rather than prose, because `(4)` needs an
 * edit that TAKES EFFECT: since the weakening door was wired, a criteria edit lands only when it
 * walks the ruler toward strictness, and rewriting either the words or a prose method is a
 * direction nothing can read, so it is held as a proposal instead
 * (`criteria-weakening-intent.pg.spec.ts`). That is also why `(3)` below ADDS a criterion rather
 * than rewording one: the two shapes of edit that still land are an addition and a promotion, and
 * this file uses one of each.
 */
const METHOD = 'VERIFICATION';

const FIRST = 'the confirmation door exists and records what was confirmed';
const SECOND = 'no acting session can walk through it';
const ADDED = 'the confirmation names the exact version it confirmed';

/** One stored confirmation, read back from the table rather than from the service that wrote it. */
interface StoredConfirmation {
  project_id: string;
  owner_id: string;
  confirmed_by_id: string;
  criteria_digest: string;
  criteria_material: Array<{ definitionId: string; revision: number; contentHash: string }>;
}

/** A refusal body, as `AuthorityRefusal` reaches a caller through Nest's exception response. */
interface RefusalBody {
  code?: string;
  action?: string;
  tier?: string;
  requiredAction?: string;
  message?: string;
}

function refusalOf(error: unknown): RefusalBody {
  const response = (error as { response?: unknown } | undefined)?.response;
  assert.ok(response && typeof response === 'object',
    `expected a refusal body, got ${String(error)}`);
  return response as RefusalBody;
}

async function refused(action: () => Promise<unknown>): Promise<{ status: number; body: RefusalBody }> {
  try {
    await action();
  } catch (error) {
    return {
      status: (error as { status?: number }).status ?? 0,
      body: refusalOf(error),
    };
  }
  return assert.fail('the call was expected to be refused and was not');
}

test('the owner confirms one version of a project’s acceptance standard set, and only the owner', {
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

  const acceptance = new ProjectAcceptanceService(prisma as unknown as PrismaService);
  const projects = new ProjectsService(prisma as unknown as PrismaService, acceptance);

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `confirmation-${ownerId}@standard-set.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose ruler is confirmed' },
  });

  /** State the whole collection through the owner's path — the only writer of a definition. */
  async function state(items: Array<{ id?: string; text: string; verificationMethod?: string }>) {
    await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: item.verificationMethod ?? METHOD,
      })),
    } as never);
  }

  /** The definitions as the database holds them, in the shape a confirmation names them by. */
  async function definitions(): Promise<Array<{
    definitionId: string; revision: number; contentHash: string; text: string;
  }>> {
    const { rows } = await sql.query<{
      id: string; revision: number; content_hash: string; text: string;
    }>(
      `SELECT "id", "revision", "content_hash", "text"
         FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "id"`,
      [projectId],
    );
    return rows.map((row) => ({
      definitionId: row.id,
      revision: row.revision,
      contentHash: row.content_hash,
      text: row.text,
    }));
  }

  async function stored(): Promise<StoredConfirmation[]> {
    const { rows } = await sql.query<StoredConfirmation>(
      `SELECT "project_id", "owner_id", "confirmed_by_id", "criteria_digest", "criteria_material"
         FROM "project_standard_set_confirmation"
        WHERE "project_id" = $1::uuid ORDER BY "confirmed_at", "id"`,
      [projectId],
    );
    return rows;
  }

  /** The two columns that say whether a project is started, off the ROW rather than off a
   * projection that could agree with itself — as the rest of this file reads everything. */
  async function authorization(id: string): Promise<{ enabled: boolean; revision: string }> {
    const { rows } = await sql.query<{ coordinator_enabled: boolean; config_revision: string }>(
      `SELECT "coordinator_enabled", "config_revision"::text AS "config_revision"
         FROM "project" WHERE "id" = $1::uuid`,
      [id],
    );
    assert.equal(rows.length, 1, 'the project this assertion is about is not there');
    return { enabled: rows[0].coordinator_enabled, revision: rows[0].config_revision };
  }

  /** An acting session of a given dispatch origin, as `sessions.create` would have written it. */
  async function actingSession(origin: SessionDispatchOrigin, title: string): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        title,
        prompt: 'act on this project',
        provider: 'claude',
        status: RunStatus.RUNNING,
        dispatchOrigin: origin,
        startsTaskWork: false,
      },
    });
    return id;
  }

  await state([{ text: FIRST }, { text: SECOND }]);
  const atFirst = await definitions();
  assert.deepEqual(atFirst.map((row) => row.revision), [1, 1],
    'the fixture starts with two criteria nobody has edited');

  // ═══ (1) the positive: exercising the chosen path records the confirmation, bound to a version ══

  await t.test('(1) the owner channel records a confirmation, and the row says which version', async () => {
    const before = await acceptance.standardSetConfirmation(ownerId, projectId);
    assert.equal(before.state, 'UNCONFIRMED');
    assert.equal(before.confirmed, false);
    assert.equal(before.confirmation, null, 'nothing has been confirmed yet');
    assert.deepEqual(await stored(), [], 'and nothing is stored yet');

    // The door: no acting session. This is (B) — the owner-authenticated channel, which
    // `ProjectsController` reaches with no session context of any kind.
    const after = await acceptance.confirmStandardSet(
      ownerId, projectId, { criteriaDigest: before.currentVersion.digest },
    );
    assert.equal(after.state, 'CONFIRMED');
    assert.equal(after.confirmed, true);

    // Read off the ROW, not off the answer that wrote it: a projection can agree with itself.
    const rows = await stored();
    assert.equal(rows.length, 1, 'exactly one confirmation was recorded');
    const [row] = rows;
    assert.equal(row.project_id, projectId);
    assert.equal(row.owner_id, ownerId);
    assert.equal(row.confirmed_by_id, ownerId, 'the credentialed actor is on the row');
    assert.equal(row.criteria_digest, before.currentVersion.digest);
    assert.match(row.criteria_digest, /^[0-9a-f]{64}$/);

    // WHICH version, in full. Every criterion the project stated at that moment, by its own id,
    // the revision its wording was on, and the hash of what it said.
    assert.deepEqual(row.criteria_material, atFirst.map((criterion) => ({
      definitionId: criterion.definitionId,
      revision: criterion.revision,
      contentHash: criterion.contentHash,
    })));
    assert.equal(row.criteria_material.length, 2);
  });

  // ═══ (2) the negative: an agent holding an acting session is refused, and writes nothing ═══════

  await t.test('(2) a call carrying an acting session is refused, whatever its dispatch origin', async () => {
    const current = await acceptance.standardSetConfirmation(ownerId, projectId);
    const before = (await stored()).length;
    assert.equal(before, 1, 'the paired positive above wrote a row through the same method');

    for (const origin of [
      SessionDispatchOrigin.USER,           // an ordinary agent run, and the standing coordinator
      SessionDispatchOrigin.PROJECT_COORDINATOR, // the one-shot judgment session
    ]) {
      const sessionId = await actingSession(origin, `an agent acting as ${origin}`);
      const { status, body } = await refused(() => acceptance.confirmStandardSet(
        ownerId, projectId, { criteriaDigest: current.currentVersion.digest }, sessionId,
      ));
      assert.equal(status, 403, `${origin} should be refused with a 403`);
      assert.equal(body.code, 'PROJECT_CRITERIA_CONFIRMATION_OWNER_CHANNEL_ONLY',
        `${origin} met the wrong boundary`);
      assert.equal(body.action, 'CONFIRM_ACCEPTANCE_CRITERIA');
      assert.equal(body.tier, 'HUMAN_ONLY');
      assert.equal(body.requiredAction, 'ASK_A_PERSON');
    }

    // Refused means nothing was written — measured against a fixture that HAS a row, so "no rows"
    // cannot be true of a table nobody can write either.
    assert.equal((await stored()).length, before, 'a refused call recorded a confirmation');
    const after = await acceptance.standardSetConfirmation(ownerId, projectId);
    assert.equal(after.state, 'CONFIRMED', 'and it did not disturb the confirmation that stands');
  });

  // ═══ (3) an edit lands, and the confirmation stops counting ════════════════════════════════════

  await t.test('(3) adding a criterion returns the project to unconfirmed', async () => {
    const confirmed = await acceptance.standardSetConfirmation(ownerId, projectId);
    assert.equal(confirmed.state, 'CONFIRMED', 'the fixture is confirmed before the edit');
    const digestBefore = confirmed.currentVersion.digest;

    // A third criterion, with both existing ones restated byte for byte: the set the owner
    // confirmed is not the set that stands, and no row of it was rewritten to make that true.
    const [first, second] = atFirst;
    const confirmedAt = first.text === FIRST ? first : second;
    const untouched = confirmedAt === first ? second : first;
    await state([
      { id: confirmedAt.definitionId, text: confirmedAt.text },
      { id: untouched.definitionId, text: untouched.text },
      { text: ADDED },
    ]);

    const moved = await definitions();
    assert.equal(moved.length, 3, 'the set grew by exactly one criterion');
    assert.deepEqual(
      moved.map((row) => row.revision),
      [1, 1, 1],
      'and it grew without moving either of the criteria that were already there',
    );

    const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
    // The whole claim of the version binding: the confirmation does not count any more.
    assert.equal(standing.confirmed, false);
    assert.equal(standing.state, 'STALE');
    assert.notEqual(standing.currentVersion.digest, digestBefore, 'the ruler moved');

    // It is still on record, and it still says which version it was about — that is what makes
    // "no longer current" readable rather than inferred.
    assert.ok(standing.confirmation, 'the confirmation is not deleted, it is superseded');
    assert.equal(standing.confirmation.criteriaDigest, digestBefore);
    assert.equal(standing.confirmation.criteriaMaterial.length, 2,
      'the stored material names the set that was confirmed, which had two criteria in it');
    assert.deepEqual(
      standing.confirmation.criteriaMaterial.find(
        (item) => item.definitionId === confirmedAt.definitionId,
      ),
      { definitionId: confirmedAt.definitionId, revision: 1, contentHash: confirmedAt.contentHash },
      'and the version of each, as it stood then rather than as it stands now',
    );

    // And confirming the version that is gone is refused rather than recorded against the new one:
    // an edit between reading the set and confirming it must not become a signature on wording
    // nobody read.
    const { status, body } = await refused(() => acceptance.confirmStandardSet(
      ownerId, projectId, { criteriaDigest: digestBefore },
    ));
    assert.equal(status, 409);
    assert.equal(body.code, 'PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED');
    assert.equal((await stored()).length, 1, 'the refused re-confirmation wrote nothing');

    // Confirming the set that stands now is a SECOND row, not a rewrite of the first.
    const again = await acceptance.confirmStandardSet(
      ownerId, projectId, { criteriaDigest: standing.currentVersion.digest },
    );
    assert.equal(again.state, 'CONFIRMED');
    const rows = await stored();
    assert.equal(rows.length, 2, 'a confirmation is appended; the earlier one is still on record');
    assert.equal(rows[0].criteria_digest, digestBefore);
    assert.equal(rows[1].criteria_digest, standing.currentVersion.digest);
  });

  // ═══ (4) the other half of an edit: how a criterion is to be JUDGED is part of the exam ════════

  await t.test('(4) changing only a verification method also retires the confirmation', async () => {
    const confirmed = await acceptance.standardSetConfirmation(ownerId, projectId);
    assert.equal(confirmed.state, 'CONFIRMED', 'the fixture is confirmed before this edit too');

    // Every word restated byte for byte; only the first criterion's exam moves, and it moves UP
    // the ladder — which is what makes this an edit that lands rather than one that is held.
    const current = await definitions();
    await state(current.map((criterion, index) => ({
      id: criterion.definitionId,
      text: criterion.text,
      verificationMethod: index === 0 ? 'EXECUTABLE' : METHOD,
    })));

    const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
    assert.equal(standing.confirmed, false,
      'a set whose evidence procedure changed is not the set that was confirmed');
    assert.equal(standing.state, 'STALE');
  });

  // ═══ (5) the confirmation is also the authorization to START the project ═══════════════════════

  await t.test('(5) a project is created un-started, and confirming the standard set starts it', async () => {
    // Created through the product's own door rather than `prisma.project.create`: the claim is
    // about what `ProjectsService.create` writes, and a fixture that wrote the row itself would be
    // asserting its own arithmetic.
    const created = await projects.create(ownerId, {
      title: 'The project whose start is authorised',
      acceptanceCriteriaItems: [{ text: FIRST, verificationMethod: METHOD }],
    } as never) as { id: string };

    // A project nobody has answered "what would settle this" for coordinates nothing: `create`
    // writes the column no more, so it lands on the database's own false.
    assert.deepEqual(await authorization(created.id), { enabled: false, revision: '0' },
      'a new project must not dispatch agents before a person has said what done means');

    // The gate is exactly as strong as it was. An acting session cannot confirm — and since
    // confirming is now also STARTING, that one refusal is what keeps an agent from authorising
    // its own project. Asserted on the column, so "refused" means the start did not happen either.
    const standing = await acceptance.standardSetConfirmation(ownerId, created.id);
    const sessionId = await actingSession(
      SessionDispatchOrigin.USER, 'an agent trying to start its own project',
    );
    const { status, body } = await refused(() => acceptance.confirmStandardSet(
      ownerId, created.id, { criteriaDigest: standing.currentVersion.digest }, sessionId,
    ));
    assert.equal(status, 403);
    assert.equal(body.code, 'PROJECT_CRITERIA_CONFIRMATION_OWNER_CHANNEL_ONLY');
    assert.equal(body.tier, 'HUMAN_ONLY');
    assert.deepEqual(await authorization(created.id), { enabled: false, revision: '0' },
      'a refused confirmation started the project anyway');

    // The owner's confirmation, through the same method: it records the version AND starts the
    // project. `coordinatorEnabled` is one of the authorization fields, so the change is also
    // readable as a revision move rather than only as a new value.
    const after = await acceptance.confirmStandardSet(
      ownerId, created.id, { criteriaDigest: standing.currentVersion.digest },
    );
    assert.equal(after.state, 'CONFIRMED');
    assert.deepEqual(await authorization(created.id), { enabled: true, revision: '1' },
      'confirming the standard set is what authorises work on the project');

    // And it is idempotent. Re-issuing the confirmation appends a second row naming the same
    // version — that much is (3)'s behaviour — but writes nothing to the project: `true` over
    // `true` is not a change, and recording it as one would move a revision other readers compare
    // against. (Until 0290 it would also have re-fired `project_dispatch_authority_fanout` over
    // every task of the project — the CAS is what kept that off the re-confirmation path, and is
    // still the right shape now that the fanout is gone.)
    await acceptance.confirmStandardSet(
      ownerId, created.id, { criteriaDigest: standing.currentVersion.digest },
    );
    assert.deepEqual(await authorization(created.id), { enabled: true, revision: '1' },
      'a second confirmation of the same version moved the authorization set');
  });

  // ═══ (6) the OTHER door into that column, and the request shape 0292 reopened ══════════════════

  await t.test('(6) an update naming nothing but the switch turns the coordinator on', async () => {
    // The column has two writers and they are two different acts: (5)'s confirmation writes it as
    // the side effect of answering what would settle the project, and `ProjectsService.update`
    // writes it because somebody moved the switch. Until 0292 the second door was the narrower one,
    // and on purpose — `assertLevelNamedWhenTurningOn` stood in `update` twice, once before the
    // transaction and once under the project lock, and answered a request like the one below with a
    // 400: an off project plus `{ coordinatorEnabled: true }` and nothing else, on the grounds that
    // saying nothing about the automation level picked one on the owner's behalf. The rule went
    // with the column it named, so one field is now the whole write, and this is what says so.
    //
    // The two conditions the deleted guard tested are stated here rather than assumed: the request
    // carries EXACTLY one key, and the project is off going in. A guard of that shape restored
    // later — whatever the second field ends up being called — fails on the line below instead of
    // shipping.
    //
    // Created through the product's own door, as in (5), so the off state this starts from is the
    // one `ProjectsService.create` actually produces.
    const switched = await projects.create(ownerId, {
      title: 'The project whose switch a person moves by hand',
      acceptanceCriteriaItems: [{ text: SECOND, verificationMethod: METHOD }],
    } as never) as { id: string };
    assert.deepEqual(await authorization(switched.id), { enabled: false, revision: '0' },
      'this project starts off, which is the state the deleted guard refused to turn on');

    const onlyTheSwitch = { coordinatorEnabled: true };
    assert.deepEqual(Object.keys(onlyTheSwitch), ['coordinatorEnabled'],
      'this assertion is about the field the request does NOT carry');

    const written = await projects.update(ownerId, switched.id, onlyTheSwitch as never) as {
      coordinatorEnabled?: boolean;
    };
    assert.equal(written.coordinatorEnabled, true, 'the update door answered with the switch on');
    // Off the row again: the answer that wrote it and the column are two claims, and this file
    // reads the second one everywhere.
    assert.deepEqual(await authorization(switched.id), { enabled: true, revision: '1' },
      'a request naming nothing but the switch turned the coordinator on');
  });

  // ═══ (7) starting the project tells the conversation holding its work ══════════════════════════

  await t.test('(7) starting the project tells its coordinator which tasks wait on it, once', async () => {
    // The press lets Orbit start the tasks opted into auto-run. The ones a coordinator filed to
    // start by hand wait on that coordinator, so the start is said to its conversation — the one
    // collaborator every other case here goes without, which is why they tell nobody.
    const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
    const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
    const telling = new ProjectAcceptanceService(
      prisma as unknown as PrismaService,
      new SessionsService(prisma as unknown as PrismaService, queue, realtime),
    );
    const HELD = 'the task its coordinator starts by hand';
    const AUTOMATIC = 'the task Orbit starts by itself';

    /** A project not yet started, coordinated from a conversation parked where a turn appends —
     *  on a workspace whose runner is heartbeating — with one task of each kind filed under it. */
    async function coordinated(label: string, completedAt: Date | null) {
      const runnerId = randomUUID();
      const workspaceId = randomUUID();
      const sessionId = randomUUID();
      const id = randomUUID();
      await prisma.runner.create({
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
      await prisma.workspace.create({
        data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
      });
      await prisma.session.create({
        data: {
          id: sessionId,
          ownerId,
          creatorId: ownerId,
          workspaceId,
          assignedRunnerId: runnerId,
          title: `协调：${label}`,
          prompt: `协调：${label}`,
          provider: 'claude',
          status: RunStatus.AWAITING_INPUT,
          dispatchOrigin: SessionDispatchOrigin.USER,
          startedAt: new Date(),
          runtimeSessionId: randomUUID(),
          completedAt,
        },
      });
      await prisma.conversationTurn.create({
        data: {
          sessionId,
          seq: 1,
          clientTurnId: SessionsService.initialTurnClientId(sessionId),
          kind: 'message',
          content: `协调：${label}`,
          status: 'ANSWERED',
        },
      });
      await prisma.project.create({
        data: {
          id,
          ownerId,
          title: `${label} 的项目`,
          coordinatorWorkspaceId: workspaceId,
          coordinatorSessionId: sessionId,
        },
      });
      await prisma.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
      await projects.update(ownerId, id, {
        acceptanceCriteriaItems: [{ text: FIRST, verificationMethod: METHOD }],
      } as never);
      const heldId = randomUUID();
      for (const [taskId, title, autoRunWhenReady] of [
        [heldId, HELD, false],
        [randomUUID(), AUTOMATIC, true],
      ] as const) {
        await prisma.task.create({
          data: {
            id: taskId,
            ownerId,
            projectId: id,
            title,
            creatorType: CreatorType.USER,
            creatorId: ownerId,
            assigneeId: workspaceId,
            status: TaskStatus.OPEN,
            completionCriterion: 'EXECUTABLE',
            acceptanceCommand: 'true',
            acceptanceExpectedExitCode: 0,
            autoRunWhenReady,
          },
        });
      }
      assert.deepEqual(await authorization(id), { enabled: false, revision: '0' },
        'the fixture project is not started yet');
      return { id, sessionId, heldId };
    }

    async function turns(sessionId: string): Promise<Array<{ client_turn_id: string; content: string }>> {
      const { rows } = await sql.query<{ client_turn_id: string; content: string }>(
        `SELECT "client_turn_id", "content" FROM "conversation_turn"
          WHERE "session_id" = $1::uuid ORDER BY "seq"`,
        [sessionId],
      );
      return rows;
    }

    async function start(id: string): Promise<void> {
      const standing = await telling.standardSetConfirmation(ownerId, id);
      await telling.confirmStandardSet(ownerId, id, { criteriaDigest: standing.currentVersion.digest });
    }

    // First, a conversation somebody closed: filed as Completed, which `createTurn` itself would
    // still queue onto. The project starts; the conversation is not revived to be told.
    const closed = await coordinated('closed', new Date());
    await start(closed.id);
    assert.deepEqual(await authorization(closed.id), { enabled: true, revision: '1' });
    assert.equal((await turns(closed.sessionId)).length, 1,
      'a conversation that was closed was written to, which revives it');

    // Then the one that is waiting: told exactly once, with the task it holds by name.
    const waiting = await coordinated('waiting', null);
    await start(waiting.id);
    assert.deepEqual(await authorization(waiting.id), { enabled: true, revision: '1' });
    const { rows: [confirmation] } = await sql.query<{ id: string }>(
      `SELECT "id" FROM "project_standard_set_confirmation" WHERE "project_id" = $1::uuid`,
      [waiting.id],
    );
    const told = await turns(waiting.sessionId);
    assert.equal(told.length, 2, 'starting the project put exactly one message on its conversation');
    const [, message] = told;
    assert.equal(message.client_turn_id, projectStartedTurnId(confirmation.id));
    assert.match(message.content, /^From Orbit · project started/);
    assert.ok(message.content.includes(`- ${HELD} (${uuidToBase62(waiting.heldId)})`),
      'the task nothing starts but the coordinator is named');
    assert.ok(!message.content.includes(AUTOMATIC), 'a task Orbit starts by itself is not');

    // A re-confirmation writes a second confirmation row and starts nothing — so it says nothing.
    await start(waiting.id);
    assert.equal((await turns(waiting.sessionId)).length, 2,
      'a confirmation that started nothing told the coordinator again');
  });
});

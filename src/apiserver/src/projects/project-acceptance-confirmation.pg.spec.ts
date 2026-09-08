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
import { RunStatus, SessionDispatchOrigin } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method the criteria declare. Never the thing under test — except in `(4)`. */
const METHOD = 'A person reads the criterion and says whether it holds';

const FIRST = 'the confirmation door exists and records what was confirmed';
const SECOND = 'no acting session can walk through it';
const REWORDED = 'the confirmation door exists, and records the exact version it confirmed';

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
        WHERE "project_id" = $1::uuid ORDER BY "confirmed_at"`,
      [projectId],
    );
    return rows;
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

  await t.test('(3) rewording one criterion returns the project to unconfirmed', async () => {
    const confirmed = await acceptance.standardSetConfirmation(ownerId, projectId);
    assert.equal(confirmed.state, 'CONFIRMED', 'the fixture is confirmed before the edit');
    const digestBefore = confirmed.currentVersion.digest;

    // One criterion, reworded. The other is restated byte for byte, so what moves is one row.
    const [first, second] = atFirst;
    const reworded = first.text === FIRST ? first : second;
    const untouched = reworded === first ? second : first;
    await state([
      { id: reworded.definitionId, text: REWORDED },
      { id: untouched.definitionId, text: untouched.text },
    ]);

    const moved = await definitions();
    assert.deepEqual(
      moved.map((row) => [row.definitionId, row.revision]).sort(),
      [[reworded.definitionId, 2], [untouched.definitionId, 1]].sort(),
      'exactly one criterion moved, and the database is what moved it',
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
    assert.deepEqual(
      standing.confirmation.criteriaMaterial.find(
        (item) => item.definitionId === reworded.definitionId,
      ),
      { definitionId: reworded.definitionId, revision: 1, contentHash: reworded.contentHash },
      'the stored material names the revision that was confirmed, not the one standing now',
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

    const current = await definitions();
    await state(current.map((criterion, index) => ({
      id: criterion.definitionId,
      text: criterion.text,
      verificationMethod: index === 0
        ? 'Run the suite the criterion names and read its exit code'
        : METHOD,
    })));

    const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
    assert.equal(standing.confirmed, false,
      'a set whose evidence procedure changed is not the set that was confirmed');
    assert.equal(standing.state, 'STALE');
  });
});

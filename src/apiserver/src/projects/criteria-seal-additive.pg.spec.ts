/**
 * A TIGHTENING EDIT TAKES EFFECT WHERE IT IS MADE — AND THAT COSTS THE OWNER'S CONFIRMATION.
 *
 * The invariant this file guards is one half of "the ruler may only walk toward strictness on its
 * own": an edit `classifyCriteriaEdit` calls `ADDITIVE` lands immediately, through the ordinary
 * write path, with nothing held back and nothing to approve. The other half — a loosening edit is
 * held for the account owner to decide — is a different write path and a different spec; what
 * makes THAT one meaningful is this one, because "the loosening did not land" says nothing until
 * something is known to land.
 *
 * THE SEAL IS READ, NOT STORED, SO IT IS PROVED BY TWO READS
 * ---------------------------------------------------------
 * A project's standard set has an identity — `criteriaSemanticRevision`, the sorted multiset of
 * `definitionId:revision:contentHash` (`project-acceptance.ts`). It is a FUNCTION OF THE LIVE
 * ROWS, computed every time somebody reads it. There is no seal column, no seal table, and no
 * re-seal write: the definition trigger moves `revision` and `content_hash`, and the next read is
 * already the new value. So "the seal moved" cannot be asserted as a column that changed. It is
 * asserted here the only way it can be honestly asserted — TWO READS, one on either side of the
 * edit, of the same read path the product uses.
 *
 * WHY THE OLD CONFIRMATION GOES STALE, AND WHY THAT IS THE ANSWER AND NOT A BUG
 * ----------------------------------------------------------------------------
 * `CONFIRM_ACCEPTANCE_CRITERIA` records WHICH VERSION the owner confirmed, and a confirmation
 * counts while, and only while, it names the version that stands. A tightening edit moves the
 * version, so the confirmation stops counting and the owner is asked again. Carrying it forward
 * was considered and refused: the only thing it could buy is one click, and what it would cost is
 * a standard set the owner never read being on record as one the owner approved. Confirmation is
 * lazy — nothing checks it until a project is about to settle — so a STALE standing interrupts
 * no one; it is a question waiting where the answer is needed.
 *
 * WHAT (4) IS AND WHY IT NEEDS THE THREE ABOVE IT
 * ----------------------------------------------
 * (4) asserts that no row was held for a decision: `project_ratified_action_intent` has none for
 * this project. On its own that assertion is vacuously true of a table nothing can write, of a
 * fixture that made no edit, and of a run that never reached the write at all. It is worth
 * something here only because (1), (2) and (3) witness — in this same fixture, about this same
 * edit — that the write went all the way through: the rows changed, the seal moved, and the
 * confirmation that named the old one is gone stale. "Nothing was held back" is a statement about
 * an edit that demonstrably landed.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-seal-additive.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { classifyCriteriaEdit } from './criteria-edit-classification';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** How the criteria say they are to be judged. Restated byte for byte across the edit. */
const METHOD = 'A person reads the criterion and says whether it holds';

const FIRST = 'the seal is the identity of the standard set that stands';
const SECOND = 'a confirmation names the version it confirmed';
/** The criterion the edit ADDS. Adding one is a tightening: the conjunction gets harder to meet. */
const ADDED = 'a tightening edit lands where it is made, without anybody approving it';

test('a tightening edit lands at once, moves the seal, and retires the confirmation it outran', {
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
      email: `seal-additive-${ownerId}@standard-set.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose ruler only tightens' },
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

  /** The definitions as the database holds them: the rows the seal is computed from. */
  async function definitions(): Promise<Array<{
    id: string; revision: number; contentHash: string; text: string; verificationMethod: string;
  }>> {
    const { rows } = await sql.query<{
      id: string; revision: number; content_hash: string; text: string; verification_method: string;
    }>(
      `SELECT "id", "revision", "content_hash", "text", "verification_method"
         FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "text"`,
      [projectId],
    );
    return rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      contentHash: row.content_hash,
      text: row.text,
      verificationMethod: row.verification_method,
    }));
  }

  /** Every confirmation on record, oldest first, read off the table rather than off a projection. */
  async function confirmations(): Promise<Array<{ digest: string }>> {
    const { rows } = await sql.query<{ criteria_digest: string }>(
      `SELECT "criteria_digest" FROM "project_standard_set_confirmation"
        WHERE "project_id" = $1::uuid ORDER BY "confirmed_at", "id"`,
      [projectId],
    );
    return rows.map((row) => ({ digest: row.criteria_digest }));
  }

  // ── the fixture: two criteria, confirmed by the owner at the seal that stood then ─────────────
  await state([{ text: FIRST }, { text: SECOND }]);
  const before = await definitions();
  assert.equal(before.length, 2, 'the fixture starts with two criteria');
  assert.deepEqual(before.map((row) => row.revision), [1, 1], 'and nobody has edited them');

  const standingBefore = await acceptance.standardSetConfirmation(ownerId, projectId);
  const sealBefore = standingBefore.currentVersion.digest;
  const confirmed = await acceptance.confirmStandardSet(
    ownerId, projectId, { criteriaDigest: sealBefore },
  );
  assert.equal(confirmed.state, 'CONFIRMED', 'the fixture is confirmed before the edit');
  assert.deepEqual(await confirmations(), [{ digest: sealBefore }]);

  /** The edit under test: both criteria restated exactly, one criterion added. */
  const edit = [
    ...before.map((row) => ({ id: row.id, text: row.text, verificationMethod: row.verificationMethod })),
    { text: ADDED, verificationMethod: METHOD },
  ];

  // ═══ (1) the edit is a tightening, and it landed — through the ordinary write path ════════════

  await t.test('(1) an ADDITIVE edit is applied by the same call that any edit goes through', async () => {
    // The direction, off the two lists the write path itself classifies: the rows on record and
    // the rows asked for. Nothing here is a loosening — every retained criterion is restated byte
    // for byte, and an addition cannot make the conjunction easier.
    assert.equal(
      classifyCriteriaEdit(
        before.map((row) => ({ id: row.id, text: row.text, verificationMethod: row.verificationMethod })),
        edit,
      ),
      'ADDITIVE',
      'the edit under test has to be the tightening kind, or this file is testing something else',
    );

    await state(edit);

    const after = await definitions();
    assert.equal(after.length, 3, 'the added criterion is on record');
    const added = after.find((row) => row.text === ADDED);
    assert.ok(added, 'the criterion the edit added is stored under its own row');
    assert.equal(added.revision, 1, 'a new definition starts at revision 1');
    assert.match(added.contentHash, /^[0-9a-f]{64}$/,
      'and the trigger gave it a content hash, which is half of what the seal is taken over');

    // The two it retained are untouched: same identity, same revision, same hash. That is what
    // makes the seal move below attributable to the addition and to nothing else.
    assert.deepEqual(
      after.filter((row) => row.text !== ADDED),
      before,
      'restating a criterion byte for byte does not move it',
    );
  });

  // ═══ (2) the seal moved — proved by two reads, because there is no column to read it off ══════

  await t.test('(2) the seal that stands now is not the seal that stood before the edit', async () => {
    const sealAfter = (await acceptance.standardSetConfirmation(ownerId, projectId))
      .currentVersion.digest;
    assert.match(sealAfter, /^[0-9a-f]{64}$/);
    assert.notEqual(sealAfter, sealBefore,
      'the standard set has a new identity, because it is a new standard set');

    // Read-time, not stored: the same read repeated with nothing written in between answers the
    // same thing, and the only write this fixture made was the definition row in (1). Nothing
    // re-sealed anything — there is no such write to make.
    const readAgain = (await acceptance.standardSetConfirmation(ownerId, projectId))
      .currentVersion.digest;
    assert.equal(readAgain, sealAfter, 'the seal is a function of the rows, so it is stable');

    // And the new seal is nowhere on record. The only place any seal is stored is a confirmation,
    // and the one confirmation stored still names the version the owner actually read.
    assert.deepEqual(await confirmations(), [{ digest: sealBefore }],
      'the edit stored no seal of its own');
  });

  // ═══ (3) the owner's confirmation is STALE, and re-confirming is the remedy ═══════════════════

  await t.test('(3) the confirmation that named the old seal no longer counts', async () => {
    const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
    assert.equal(standing.state, 'STALE');
    assert.equal(standing.confirmed, false,
      'a set with a criterion the owner never read is not a set the owner confirmed');

    // Superseded, not deleted, and still saying which version it was about — that is what makes
    // "no longer current" a fact a reader can check rather than one they have to infer.
    assert.ok(standing.confirmation, 'the confirmation is still on record');
    assert.equal(standing.confirmation.criteriaDigest, sealBefore);
    assert.deepEqual(
      standing.confirmation.criteriaMaterial.map((item) => item.definitionId).sort(),
      before.map((row) => row.id).sort(),
      'it names the two criteria that stood when it was given, and not the one added since',
    );

    // The remedy is one call, and it appends: the earlier confirmation stays on record as the
    // answer to the question that was actually asked then.
    const again = await acceptance.confirmStandardSet(
      ownerId, projectId, { criteriaDigest: standing.currentVersion.digest },
    );
    assert.equal(again.state, 'CONFIRMED');
    assert.deepEqual(
      await confirmations(),
      [{ digest: sealBefore }, { digest: standing.currentVersion.digest }],
      'confirming again is a second row, not a rewrite of the first',
    );
  });

  // ═══ (4) nothing was held for a decision ══════════════════════════════════════════════════════

  await t.test('(4) a tightening edit files no proposal for anybody to approve', async () => {
    // Vacuous on its own — see the header. It is (1), (2) and (3) above, about this same edit in
    // this same fixture, that make "no row" mean "the edit needed no permission" rather than
    // "nothing happened".
    const { rows } = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS "count" FROM "project_ratified_action_intent"
        WHERE "project_id" = $1::uuid`,
      [projectId],
    );
    assert.equal(rows[0].count, '0',
      'a tightening edit takes effect on its own; there is nothing for an owner to decide');
  });
});

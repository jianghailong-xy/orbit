/**
 * WHAT CHANGED SINCE THE OWNER LAST CONFIRMED THE CRITERIA — the read the "Confirm the new
 * criteria?" card is drawn from.
 *
 * A started project goes on running when its criteria move; only DONE waits for the owner to
 * confirm the new set. Asking them to confirm a whole list again, with nothing to say which line
 * moved, is what made the old card read as "start the project again". So
 * `GET /projects/:id/acceptance/confirmation` carries `changesSinceConfirmed`: the criteria ADDED
 * since the newest confirmation, the ones whose check is STRICTER than the one confirmed (and that
 * check), and the ordinals of the rest.
 *
 * THE COMPARISON IS THE DATABASE'S
 * --------------------------------
 * A confirmation stores each criterion's `definitionId:revision:contentHash`, and the content hash
 * is `project_acceptance_definition_content_hash` over the words AND the method — a PostgreSQL
 * function nothing in TypeScript reproduces. So "unchanged" is the stored hash equal to the stored
 * hash, and the method a stricter criterion was confirmed with is found by PostgreSQL: the rung of
 * the ladder that, beside the words on the row, hashes to what was confirmed. (4) and (5) only go
 * green if that query answers, and (5) only if it answers against the CONFIRMATION rather than the
 * revision before the last one.
 *
 * WHY EVERY EDIT GOES THROUGH THE OWNER'S DOOR
 * --------------------------------------------
 * Criteria move the way the product moves them: `ProjectsService.update`, whose trigger advances
 * `revision` and rewrites `content_hash`, and whose classifier decides whether the edit lands at
 * all. Each tightening below is asserted to be `ADDITIVE` before it is made — held instead, it
 * would move nothing and the case would be asserting a diff of zero edits. The confirmations are
 * `confirmStandardSet`'s, the first of which starts the project, as it does in the product.
 *
 * ONE TIMELINE, ONE VARIABLE PER STEP
 * -----------------------------------
 *   (1) never confirmed: no diff at all, and an edit does not make one
 *   (2) one criterion added
 *   (3) confirming clears it — in the door's own answer and in the read after it
 *   (4) one check made stricter
 *   (5) both at once, the check made stricter twice since the confirmation
 *   (6) confirming clears that too
 *   (7) a loosening is held and so is no change; approved while the confirmation is behind, it
 *       lands without carrying the confirmation — and is listed, not counted as unchanged
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-change-since-confirmed.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { type CriteriaChangesSinceConfirmed, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { classifyCriteriaEdit } from './criteria-edit-classification';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { type HeldCriteriaEdit, ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/**
 * The bottom rung of the HUMAN → VERIFICATION → EXECUTABLE ladder, which every criterion is stated
 * with. A rung rather than prose because a check can only be made stricter on its own by climbing
 * the ladder: rewriting prose is a direction nothing can read, and is held for the owner instead.
 */
const METHOD = 'HUMAN';

const FIRST = 'the owner reads what was added since they last confirmed the criteria';
const SECOND = 'the owner reads whose check got stricter, and the check they had confirmed';
const THIRD = 'every criterion that reads as it was confirmed is only numbered';
const FOURTH = 'a criterion stated after the confirmation is new';
const FIFTH = 'a criterion added beside a stricter check is new all the same';
const SIXTH = 'a change the owner approved while their confirmation was behind is still a change';
const THIRD_REWORDED = `${THIRD}, whatever the list around it does`;

/** Nothing changed: what every list but `unchanged` holds after a confirmation. */
function onlyUnchanged(...ordinals: number[]): CriteriaChangesSinceConfirmed {
  return { added: [], stricter: [], revised: [], removed: [], unchanged: ordinals };
}

test('the confirmation read says what changed since the owner last confirmed, and nothing else', {
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
      email: `changes-since-confirmed-${ownerId}@standard-set.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose criteria move after it starts' },
  });

  // ── the fixture's own vocabulary ───────────────────────────────────────────────────────────────

  interface Stated { id: string; text: string; verificationMethod: string }

  /** The definitions as the database holds them, in list order. */
  async function definitions(): Promise<Stated[]> {
    const { rows } = await sql.query<{ id: string; text: string; verification_method: string }>(
      `SELECT "id", "text", "verification_method" FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
      [projectId],
    );
    return rows.map((row) => ({
      id: row.id, text: row.text, verificationMethod: row.verification_method,
    }));
  }

  /** The key a criterion is named by on the wire, for the criterion stated with these words. */
  async function keyOf(text: string): Promise<string> {
    const row = (await definitions()).find((criterion) => criterion.text === text);
    assert.ok(row, `no criterion states "${text}"`);
    return uuidToBase62(row.id);
  }

  /** Restate the whole collection through the owner's door. */
  async function state(items: Array<{ id?: string; text: string; verificationMethod?: string }>) {
    return await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: item.verificationMethod ?? METHOD,
      })),
    } as never) as { acceptanceCriteriaHold?: HeldCriteriaEdit };
  }

  /**
   * An edit that lands where it is made — asserted to be the tightening kind before it is made, off
   * the rows it is made against, and seen landing rather than held.
   */
  async function tighten(edit: (current: Stated[]) => Array<Partial<Stated> & { text: string }>) {
    const current = await definitions();
    const next = edit(current);
    assert.equal(classifyCriteriaEdit(current, next.map((item) => ({
      ...item, verificationMethod: item.verificationMethod ?? METHOD,
    }))), 'ADDITIVE', 'the edit under test has to be one that needs nobody');
    const answer = await state(next);
    assert.equal(answer.acceptanceCriteriaHold, undefined, 'the tightening was held, not applied');
  }

  const read = () => acceptance.standardSetConfirmation(ownerId, projectId);

  /** The owner confirms the version that stands, as the card's button does; the door's answer. */
  async function confirm() {
    const { currentVersion } = await read();
    return acceptance.confirmStandardSet(ownerId, projectId, {
      criteriaDigest: currentVersion.digest,
    });
  }

  async function confirmationCount(): Promise<number> {
    const { rows } = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS "count" FROM "project_standard_set_confirmation"
        WHERE "project_id" = $1::uuid`,
      [projectId],
    );
    return Number(rows[0].count);
  }

  await state([{ text: FIRST }, { text: SECOND }]);

  // ═══ (1) never confirmed ═════════════════════════════════════════════════════════════════════

  await t.test('(1) a project nobody has confirmed has no diff, and says why', async () => {
    const never = await read();
    assert.equal(never.state, 'UNCONFIRMED');
    assert.equal(never.changesSinceConfirmed, null,
      'there is no confirmation to compare with, so there is no diff — not an empty one');
    assert.equal(never.changesSinceConfirmedAbsentReason, 'NEVER_CONFIRMED');

    // An edit does not make one: a criterion added to a set nobody confirmed is not "new" against
    // anything, and a diff against the set as first stated would be a confirmation nobody gave.
    await tighten((current) => [...current, { text: THIRD }]);
    const edited = await read();
    assert.equal(edited.state, 'UNCONFIRMED');
    assert.equal(edited.changesSinceConfirmed, null);
    assert.equal(edited.changesSinceConfirmedAbsentReason, 'NEVER_CONFIRMED');

    // The positive control for everything below: the first confirmation — which starts the
    // project — leaves a diff that exists and is empty, with no reason beside it.
    await confirm();
    const { rows: [project] } = await sql.query<{ started_at: Date | null }>(
      `SELECT "started_at" FROM "project" WHERE "id" = $1::uuid`, [projectId],
    );
    assert.ok(project.started_at, 'the first confirmation starts the project');
    const confirmed = await read();
    assert.equal(confirmed.state, 'CONFIRMED');
    assert.deepEqual(confirmed.changesSinceConfirmed, onlyUnchanged(1, 2, 3));
    assert.equal(confirmed.changesSinceConfirmedAbsentReason, null);
  });

  // ═══ (2) one criterion added ═════════════════════════════════════════════════════════════════

  await t.test('(2) a criterion added after the confirmation is new, and the rest are numbered', async () => {
    await tighten((current) => [...current, { text: FOURTH }]);

    const standing = await read();
    assert.equal(standing.state, 'STALE', 'the set the owner confirmed is not the set that stands');
    assert.deepEqual(standing.changesSinceConfirmed, {
      added: [{ key: await keyOf(FOURTH), ordinal: 4, text: FOURTH }],
      stricter: [],
      revised: [],
      removed: [],
      unchanged: [1, 2, 3],
    });
    assert.equal(standing.changesSinceConfirmedAbsentReason, null);
  });

  // ═══ (3) confirming clears it ════════════════════════════════════════════════════════════════

  await t.test('(3) confirming the new set clears the diff, in the door’s answer and after it', async () => {
    // The answer first: the web writes it straight into the read's cache, so an answer without
    // the diff would be a card with its changes missing until the next poll.
    const answer = await confirm();
    assert.equal(answer.state, 'CONFIRMED');
    assert.deepEqual(answer.changesSinceConfirmed, onlyUnchanged(1, 2, 3, 4));
    assert.equal(answer.changesSinceConfirmedAbsentReason, null);

    const after = await read();
    assert.equal(after.state, 'CONFIRMED');
    assert.deepEqual(after.changesSinceConfirmed, onlyUnchanged(1, 2, 3, 4));
  });

  // ═══ (4) one check made stricter ═════════════════════════════════════════════════════════════

  await t.test('(4) a check moved up the ladder is stricter, and names the check that was confirmed', async () => {
    await tighten((current) => current.map((criterion) => (
      criterion.text === SECOND ? { ...criterion, verificationMethod: 'EXECUTABLE' } : criterion
    )));

    const standing = await read();
    assert.equal(standing.state, 'STALE');
    assert.deepEqual(standing.changesSinceConfirmed, {
      added: [],
      stricter: [{
        key: await keyOf(SECOND),
        ordinal: 2,
        verificationMethod: 'EXECUTABLE',
        confirmedVerificationMethod: METHOD,
      }],
      revised: [],
      removed: [],
      unchanged: [1, 3, 4],
    });

    await confirm();
    assert.deepEqual((await read()).changesSinceConfirmed, onlyUnchanged(1, 2, 3, 4),
      'and confirming it clears it');
  });

  // ═══ (5) both kinds together ═════════════════════════════════════════════════════════════════

  await t.test('(5) an addition beside a stricter check: both are named, each by what it is', async () => {
    // One edit carrying both: a criterion added at the top of the list — which moves every other
    // one down a place — and FIRST's check one rung up.
    await tighten((current) => [
      { text: FIFTH },
      ...current.map((criterion) => (
        criterion.text === FIRST ? { ...criterion, verificationMethod: 'VERIFICATION' } : criterion
      )),
    ]);
    // And FIRST up another rung in a second edit, so the check it was CONFIRMED with and the one
    // it had just before are different: the diff is against the confirmation, not the last edit.
    await tighten((current) => current.map((criterion) => (
      criterion.text === FIRST ? { ...criterion, verificationMethod: 'EXECUTABLE' } : criterion
    )));

    const standing = await read();
    assert.equal(standing.state, 'STALE');
    assert.deepEqual(standing.changesSinceConfirmed, {
      added: [{ key: await keyOf(FIFTH), ordinal: 1, text: FIFTH }],
      stricter: [{
        key: await keyOf(FIRST),
        ordinal: 2,
        verificationMethod: 'EXECUTABLE',
        confirmedVerificationMethod: METHOD,
      }],
      revised: [],
      removed: [],
      // Ordinals as the list reads now. SECOND's EXECUTABLE is the check (4) confirmed, so it is
      // unchanged here.
      unchanged: [3, 4, 5],
    });
  });

  // ═══ (6) confirming clears that too ══════════════════════════════════════════════════════════

  await t.test('(6) confirming clears a mixed diff as well', async () => {
    const answer = await confirm();
    assert.deepEqual(answer.changesSinceConfirmed, onlyUnchanged(1, 2, 3, 4, 5));
    const after = await read();
    assert.equal(after.state, 'CONFIRMED');
    assert.deepEqual(after.changesSinceConfirmed, onlyUnchanged(1, 2, 3, 4, 5));
    assert.equal(after.changesSinceConfirmedAbsentReason, null);
  });

  // ═══ (7) a loosening: held, then approved while the confirmation is behind ═══════════════════

  await t.test('(7) a loosening is no change until approved, and listed — not unchanged — after', async () => {
    // The confirmation falls behind first: a criterion added, which needs nobody.
    await tighten((current) => [...current, { text: SIXTH }]);
    const behind = {
      added: [{ key: await keyOf(SIXTH), ordinal: 6, text: SIXTH }],
      stricter: [],
      revised: [],
      removed: [],
      unchanged: [1, 2, 3, 4, 5],
    };
    assert.deepEqual((await read()).changesSinceConfirmed, behind);

    // Then THIRD reworded and FOURTH dropped, through the same door. That is the loosening kind:
    // it is held as a proposal for the owner, so it lands nowhere and changes nothing here.
    const thirdKey = await keyOf(THIRD);
    const fourthKey = await keyOf(FOURTH);
    const current = await definitions();
    const loosening = current
      .filter((criterion) => criterion.text !== FOURTH)
      .map((criterion) => (criterion.text === THIRD ? { ...criterion, text: THIRD_REWORDED } : criterion));
    assert.equal(classifyCriteriaEdit(current, loosening), 'WEAKENING');
    const { acceptanceCriteriaHold: held } = await state(loosening);
    assert.ok(held, 'a loosening is held rather than applied');
    assert.deepEqual((await read()).changesSinceConfirmed, behind,
      'a held edit did not land, so the diff is the one before it');

    // The owner approves it on its own card. The confirmation does not move with the approval: it
    // names a set the ruler had already left, so the result is a set nobody has confirmed.
    const { rows: [proposal] } = await sql.query<{ commit_token: string }>(
      `SELECT "commit_token" FROM "project_ratified_action_intent" WHERE "id" = $1::uuid`,
      [held.intentId],
    );
    const confirmationsBefore = await confirmationCount();
    const decided = await projects.decideCriteriaChange(ownerId, projectId, held.intentId, {
      decision: 'APPROVE',
      commitToken: proposal.commit_token,
      baseSeal: held.baselineSeal,
    } as never);
    assert.equal(decided.applied, true, 'the owner approved it, so it is in force');
    assert.equal(await confirmationCount(), confirmationsBefore,
      'the approval carried no confirmation, so the diff is still against the one from (6)');

    // So the two approved changes are changes since that confirmation: THIRD's new words listed as
    // revised, FOURTH's key as removed — and neither is numbered as unchanged.
    const standing = await read();
    assert.equal(standing.state, 'STALE');
    assert.deepEqual(standing.changesSinceConfirmed, {
      added: [{ key: await keyOf(SIXTH), ordinal: 5, text: SIXTH }],
      stricter: [],
      revised: [{ key: thirdKey, ordinal: 4, text: THIRD_REWORDED }],
      removed: [fourthKey],
      unchanged: [1, 2, 3],
    });

    assert.deepEqual((await confirm()).changesSinceConfirmed, onlyUnchanged(1, 2, 3, 4, 5),
      'and confirming clears it like any other');
  });
});

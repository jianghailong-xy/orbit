/**
 * THE ONE MOMENT THE WORDS A REWRITE REPLACES STILL EXIST — AND THE ROW THAT KEEPS THEM.
 *
 * An answered proposal's card could show one side of the change only: the words the proposal asked
 * for. What those words REPLACED was nowhere. The proposal states what it wants, the baseline it
 * names seals each criterion as `(definitionId, revision, contentHash)` and carries no text,
 * `project_criteria_authorship` records who wrote a revision rather than what it said — and the
 * definition's own `text` is overwritten by the approval itself. The account owner, 2026-09-17:
 * after approving, you can no longer see what the change was.
 *
 * The before-words exist in exactly one place at exactly one instant: inside the deciding
 * transaction, which has already read the definitions in force to compare the seal. 0279 stores the
 * diff taken there, and this file is the witness that it is a SNAPSHOT and not a derivation:
 *
 *   (1) an APPROVE, run through the real door. The stored column holds the words that were on
 *       record — asserted against the definition row the same approval overwrote, so what is
 *       witnessed is a value that survived its own source. The control is in the same case: the
 *       before-words are gone from every definition of that project, which is what makes the
 *       snapshot the only copy rather than a second one beside a recoverable original;
 *   (2) a REJECT, which stores the same thing for the opposite outcome — what the words that were
 *       turned down would have done to the ruler that stood at the time. Nothing else records that:
 *       a refusal moves no criterion, so a reader asking afterwards what was refused has only this;
 *   (3) a decision written BEFORE the column existed, which reads out as `PREDATES_SNAPSHOT` and
 *       not as a diff that moved nothing — and still has its criteria placed by the content-hash
 *       path (`sealedContentHashes`), which is exactly why that path stays.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-decision-diff-snapshot.pg.spec.ts
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, type PrismaClient } from '@prisma/client';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from './coordinator-pg-test-safety';
import {
  recentlySettledCriteriaDecisions,
  type CriteriaProposalDiff,
  type SettledCriteriaDecision,
} from './criteria-pending-decisions';
import { CRITERIA_WEAKENING_EFFECT_CLASS } from './criteria-weakening-intent';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** How the criteria say they are to be judged. Restated byte for byte by every edit below. */
const METHOD = 'A person reads the criterion and says whether it holds';

/** The assertion this file rewrites, and the assertion it is rewritten INTO. */
const BEFORE = 'every migration in this branch is replayed on a loaded database before it ships';
const AFTER = 'a migration in this branch is replayed on a loaded database when somebody asks';
const KEPT = 'the release notes name every client the tag builds';
const DROPPED = 'the criterion this fixture takes out, to make an edit a plain loosening';

/** What the write path returns when it held an edit — `HeldCriteriaEdit`, on the wire. */
interface Held {
  applied: false;
  intentId: string;
  baselineSeal: string;
}

interface Stack {
  db: PrismaClient;
  projects: ProjectsService;
}

/** The production wiring, over one client and with no seam. */
function connect(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  return { db, projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma)) };
}

/** One owner and one project. The contract row every intent binds to is the project trigger's. */
async function fixture(db: PrismaClient, label: string): Promise<{
  ownerId: string; projectId: string;
}> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@diff-snapshot.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: `${label} 的尺子` } });
  return { ownerId, projectId };
}

/**
 * The stored column, read with SQL and as TEXT: past Prisma, past every service, and past anything
 * that could be deriving it on the way out. What this returns is what is in the row.
 */
async function storedSnapshot(db: PrismaClient, intentId: string): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ snapshot: string | null }>>(Prisma.sql`
    SELECT "diff_snapshot"::text AS "snapshot"
      FROM "project_criteria_decision" WHERE "intent_id" = ${intentId}::uuid`);
  assert.equal(rows.length, 1, 'the decision row must exist');
  return rows[0]!.snapshot;
}

/** The diff a settled answer carries, or a failed assertion naming what it carried instead. */
function snapshotOf(settled: SettledCriteriaDecision): CriteriaProposalDiff {
  assert.equal(settled.diff.state, 'SNAPSHOT',
    `this decision was recorded through the door, so it has a diff of its own; the read says `
    + `${settled.diff.state}`);
  return (settled.diff as { state: 'SNAPSHOT'; diff: CriteriaProposalDiff }).diff;
}

test('a criteria decision stores the diff it was answered against', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const stack = connect(url);
  const db = stack.db;
  t.after(async () => { await db.$disconnect().catch(() => undefined); });

  /** State the whole collection through the owner's path — the only writer of a definition. */
  const state = async (
    ownerId: string,
    projectId: string,
    items: Array<{ id?: string; text: string }>,
  ): Promise<Held | null> => {
    const response = await stack.projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: METHOD,
      })),
    } as never) as unknown as { acceptanceCriteriaHold?: Held };
    return response.acceptanceCriteriaHold ?? null;
  };

  const definitions = (projectId: string) =>
    db.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId },
      orderBy: { ordinal: 'asc' },
      select: { id: true, text: true },
    });

  /** The proposal's own one-time key, which the proposer is never handed. */
  const keyOf = async (intentId: string): Promise<string> =>
    (await db.projectRatifiedActionIntent.findUniqueOrThrow({
      where: { id: intentId }, select: { commitToken: true },
    })).commitToken;

  // ═══ (1) an APPROVE keeps the version it is about to overwrite ═══════════════════════════════
  await t.test('(1) the snapshot holds the words the approval then overwrote', async () => {
    const { ownerId, projectId } = await fixture(db, 'approved');
    assert.equal(await state(ownerId, projectId, [{ text: BEFORE }, { text: KEPT }]), null,
      'stating a project’s first criteria is ADDITIVE and is never held');
    const before = await definitions(projectId);
    assert.equal(before.length, 2);

    // The edit: criterion 1 reworded, criterion 2 restated byte for byte. A rewording cannot be
    // read for direction, so it is held — which is what gives this case a proposal to answer.
    const held = await state(ownerId, projectId, [
      { id: before[0]!.id, text: AFTER },
      { id: before[1]!.id, text: KEPT },
    ]);
    assert.ok(held, 'a rewording is held rather than applied, and that is what is answered below');

    const decided = await stack.projects.decideCriteriaChange(ownerId, projectId, held.intentId, {
      commitToken: await keyOf(held.intentId), decision: 'APPROVE', baseSeal: held.baselineSeal,
    } as never);
    assert.equal(decided.decision, 'APPROVE');

    // THE OVERWRITE HAPPENED. Asserted first, because everything below is only interesting about a
    // value whose source is gone: the definition now says AFTER, and BEFORE is in no definition of
    // this project — not under another ordinal, not on an older row left behind.
    const after = await definitions(projectId);
    assert.equal(after.find((row) => row.id === before[0]!.id)?.text, AFTER,
      'the approval applied the rewording, so the words this snapshot is about are no longer here');
    assert.equal(after.filter((row) => row.text === BEFORE).length, 0,
      'and they are nowhere else in the standard set either — the snapshot is the only copy');

    // THE COLUMN. Read as text, so the claim is about bytes in the row rather than about a shape
    // some reader assembled.
    const stored = await storedSnapshot(db, held.intentId);
    assert.ok(stored, 'the decision wrote a snapshot');
    assert.ok(stored.includes(BEFORE),
      'the words the rewrite replaced are IN the column — the only place they still are');
    assert.ok(stored.includes(AFTER), 'and the words that replaced them, on the other side of it');

    // THE READ, which is the shape the card draws: one line with both versions cut into runs.
    const settled = await recentlySettledCriteriaDecisions(db, ownerId, projectId);
    assert.equal(settled.length, 1);
    const diff = snapshotOf(settled[0]!);
    assert.deepEqual(
      [diff.changedCount, diff.sameCount, diff.newCount, diff.removedCount], [1, 1, 0, 0],
      'one criterion moved and one was restated word for word, which is what the edit did',
    );
    const changed = diff.entries.find((entry) => entry.change === 'CHANGED');
    assert.equal(changed?.definitionId, before[0]!.id);
    assert.equal(changed?.onRecord?.text, BEFORE, 'the side no other row still holds');
    assert.equal(changed?.proposed?.text, AFTER);
    // The cut itself — what `<del>` and `<ins>` are drawn from. A snapshot that carried the two
    // versions and no cut would still render, coarsely; this pins that it carries the cut the
    // pending card was drawn with, so the answered card and the question agree run for run.
    const runs = changed?.rewrites.find((rewrite) => rewrite.field === 'text')?.segments ?? [];
    assert.ok(runs.some((run) => run.side === 'REMOVED'), 'the words struck through');
    assert.ok(runs.some((run) => run.side === 'ADDED'), 'the words underlined');
    assert.ok(runs.some((run) => run.side === 'KEPT'), 'and what both versions have in common');
    assert.equal(runs.filter((run) => run.side !== 'ADDED').map((run) => run.text).join(''), BEFORE,
      'the KEPT and REMOVED runs read back as the words on record, exactly');
    assert.equal(runs.filter((run) => run.side !== 'REMOVED').map((run) => run.text).join(''), AFTER,
      'and the KEPT and ADDED runs as the words the approval put in their place');
  });

  // ═══ (2) and a REJECT, whose snapshot is the only record of what was turned down ═════════════
  await t.test('(2) a refused proposal stores what it would have done', async () => {
    const { ownerId, projectId } = await fixture(db, 'refused');
    await state(ownerId, projectId, [{ text: BEFORE }, { text: DROPPED }]);
    const before = await definitions(projectId);

    // Dropping a criterion is a plain loosening, so this one is held for the direction rather than
    // for being unreadable prose.
    const held = await state(ownerId, projectId, [{ id: before[0]!.id, text: BEFORE }]);
    assert.ok(held, 'dropping a criterion is a loosening and has to be held');

    const decided = await stack.projects.decideCriteriaChange(ownerId, projectId, held.intentId, {
      commitToken: await keyOf(held.intentId), decision: 'REJECT', baseSeal: held.baselineSeal,
    } as never);
    assert.equal(decided.decision, 'REJECT');
    assert.deepEqual(await definitions(projectId), before,
      'a REJECT moves no criterion — which is why nothing but this row records what it was about');

    const stored = await storedSnapshot(db, held.intentId);
    assert.ok(stored?.includes(DROPPED),
      'the criterion the refusal saved is named in the snapshot, with its words');

    const [settled] = await recentlySettledCriteriaDecisions(db, ownerId, projectId);
    const diff = snapshotOf(settled!);
    assert.equal(settled!.decision, 'REJECT');
    assert.deepEqual([diff.removedCount, diff.sameCount, diff.changedCount], [1, 1, 0]);
    const removed = diff.entries.find((entry) => entry.change === 'REMOVED');
    assert.equal(removed?.definitionId, before[1]!.id);
    assert.equal(removed?.onRecord?.text, DROPPED,
      'and the words are the ones that were on record when the owner said no');
  });

  // ═══ (3) a decision older than the column, which is a fact and not a missing value ═══════════
  await t.test('(3) a decision recorded before 0279 reads as one, not as a diff of nothing',
    async () => {
      const { ownerId, projectId } = await fixture(db, 'historic');
      await state(ownerId, projectId, [{ text: BEFORE }, { text: DROPPED }]);
      const before = await definitions(projectId);
      const held = await state(ownerId, projectId, [{ id: before[0]!.id, text: AFTER }]);
      assert.ok(held);

      // The row every decision looked like until 0279: answered, with no snapshot. Written here
      // the way those rows exist on the deployment — the column simply not set.
      await db.projectCriteriaDecision.create({
        data: {
          intentId: held.intentId,
          projectId,
          ownerId,
          decision: 'APPROVE',
          decidedById: ownerId,
          baseSeal: held.baselineSeal,
          resultingSeal: held.baselineSeal,
        },
      });
      assert.equal(await storedSnapshot(db, held.intentId), null,
        'the column is NULL, which is the shape this case is about');

      const [settled] = await recentlySettledCriteriaDecisions(db, ownerId, projectId);
      assert.deepEqual(settled!.diff, { state: 'PREDATES_SNAPSHOT' },
        'a decision answered before the column existed says so — an empty diff would be this read '
        + 'claiming the decision moved nothing, which is a statement about the decision instead of '
        + 'about the record');

      // AND THE PATH THAT CARRIES THOSE ROWS IS STILL UNDER THEM. The hash comparison is the only
      // thing that can place a pre-0279 decision's criteria, so it is not something 0279 replaced.
      const proposal = settled!.proposal;
      assert.ok(proposal, 'the content-hash path still answers for a row with no snapshot');
      assert.deepEqual(
        [proposal.rewordedCount, proposal.droppedCount, proposal.addedCount],
        [1, 1, 0],
        'one criterion reworded and one dropped, placed by `sealedContentHashes` exactly as before',
      );
      assert.equal(proposal.changed.find((entry) => entry.change === 'REWORDED')?.text, AFTER,
        'and it still publishes the one side it has: the words the proposal asked for');

      // The fixture is a real proposal, so this case cannot pass by there being nothing to read.
      assert.equal(
        await db.projectRatifiedActionIntent.count({
          where: { projectId, effectClass: CRITERIA_WEAKENING_EFFECT_CLASS },
        }),
        1,
      );
    });
});

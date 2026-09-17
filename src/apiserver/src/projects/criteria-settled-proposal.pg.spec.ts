/**
 * THE ONE CLAIM IN `criteria-pending-decisions.ts` THAT ONLY POSTGRES CAN SETTLE.
 *
 * A settled proposal's card says which criteria the decision moved. It can only say that by
 * comparing each restated criterion against the content hash sealed into the proposal's baseline —
 * and `content_hash` is not a hash of anything this process can compute. Since 0233 the definition's
 * BEFORE trigger writes
 * `project_acceptance_definition_content_hash(btrim(text), btrim(verification_method))`, which
 * hashes the TEXT RENDERING OF A JSONB OBJECT: key order, separators and escaping all decided by
 * Postgres. A TypeScript reproduction that is one byte off does not fail loudly — every restated
 * criterion stops matching its own hash, and a proposal that moved one line in fourteen is reported
 * as having rewritten all fourteen.
 *
 * That is exactly the bug this file exists to make impossible to ship. `sealedContentHashes` asks
 * the database to apply its own two steps; these cases witness that what comes back IS the column
 * the trigger wrote, on rows the trigger actually wrote — including the two shapes where a
 * reproduction would most plausibly drift:
 *
 *   * an assertion in Chinese whose ends carry `　`, the ideographic space, which `btrim` does
 *     NOT remove and `String.prototype.trim` does. A criterion nobody touched would come back
 *     REWORDED;
 *   * two criteria differing only in their verification method, which the hash covers and an
 *     assertion-only recipe would call identical.
 *
 * And then the whole read, end to end, over a real filed proposal and a real answer: the words that
 * took effect, and which criterion they belong to.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-settled-proposal.pg.spec.ts
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';

import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from './coordinator-pg-test-safety';
import {
  recentlySettledCriteriaDecisions,
  sealedContentHashes,
} from './criteria-pending-decisions';
import {
  CRITERIA_WEAKENING_EFFECT_CLASS,
  criteriaWeakeningActionDigest,
  criteriaWeakeningRequest,
  type CriteriaWeakeningAction,
  type ProposedCriterion,
} from './criteria-weakening-intent';
import { criteriaFromDefinitions, standardSetVersion } from './project-acceptance';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const METHOD = 'EXECUTABLE';
/** Leading and trailing `　`. `btrim` keeps both; `trim` would eat both. */
const IDEOGRAPHIC = '　判据正文两端各带一个全角空格　';
/** A tab, which `btrim` also keeps. */
const TABBED = '\tthe assertion begins with a tab';
/** Ends padded with ASCII SPACE — the one thing `btrim` DOES take off, on the way in. */
const PADDED = '   an assertion whose ends the database will trim   ';
const PLAIN = 'the ordinary case, with nothing at the ends';

interface Fixture {
  ownerId: string;
  projectId: string;
}

/** One owner and one project. The contract row every intent binds to is the project trigger's. */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@settled-proposal.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: `${label} 的尺子` } });
  return { ownerId, projectId };
}

/** Criteria written the ordinary way, so the BEFORE trigger is what puts the hashes on them. */
async function state(
  db: PrismaClient,
  projectId: string,
  criteria: ReadonlyArray<{ text: string; verificationMethod?: string }>,
): Promise<void> {
  for (const [index, criterion] of criteria.entries()) {
    await db.projectAcceptanceCriterionDefinition.create({
      data: {
        projectId,
        ordinal: index + 1,
        text: criterion.text,
        verificationMethod: criterion.verificationMethod ?? METHOD,
        contentHash: '0'.repeat(64),
      },
    });
  }
}

const definitionsOf = (db: PrismaClient, projectId: string) =>
  db.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId },
    orderBy: { ordinal: 'asc' },
    select: {
      id: true, ordinal: true, text: true, verificationMethod: true,
      completionCriterionOverrideReason: true, revision: true, contentHash: true,
    },
  });

test('a settled proposal names the criteria it moved, against Postgres\'s own content hash', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const db = prismaClientFor(url);

  try {
    await t.test('(1) the hash this read asks for IS the column the trigger wrote', async () => {
      const { projectId } = await fixture(db, 'hash-parity');
      await state(db, projectId, [
        { text: PLAIN },
        { text: IDEOGRAPHIC },
        { text: TABBED },
        { text: PADDED },
        // The same assertion as the first, judged another way: the hash covers both fields, so
        // these two must NOT come out equal.
        { text: PLAIN, verificationMethod: 'OWNER_CONFIRMED' },
      ]);
      const definitions = await definitionsOf(db, projectId);
      assert.equal(definitions.length, 5);

      const asked = await sealedContentHashes(db, definitions.map((definition) => ({
        text: definition.text,
        verificationMethod: definition.verificationMethod,
      })));

      for (const [index, definition] of definitions.entries()) {
        assert.equal(asked[index], definition.contentHash,
          `criterion ${definition.ordinal} (${JSON.stringify(definition.text)}) hashes to `
          + `${asked[index]} here and to ${definition.contentHash} in its own row`);
      }
      // The control for the line above: the five hashes are not one value repeated. Two of them
      // share an assertion and differ only in how it is judged, and they differ.
      assert.equal(new Set(asked).size, 5, 'each criterion hashes to its own value');

      // The stored text is `btrim`ed, so the padded one is a DIFFERENT string from what was
      // written — and asking with the string as it was written still lands on the stored hash,
      // which is what makes a restatement carrying stray spaces not a rewrite.
      const padded = definitions.find((definition) => definition.text.endsWith('trim'));
      assert.ok(padded, 'the ends came off on the way in');
      assert.notEqual(padded.text, PADDED);
      const [fromTheUntrimmed] = await sealedContentHashes(db, [
        { text: PADDED, verificationMethod: METHOD },
      ]);
      assert.equal(fromTheUntrimmed, padded.contentHash);
    });

    await t.test('(2) the whole read: what was approved, and which criterion it was', async () => {
      const { ownerId, projectId } = await fixture(db, 'settled-read');
      await state(db, projectId, [{ text: IDEOGRAPHIC }, { text: PLAIN }, { text: TABBED }]);
      const definitions = await definitionsOf(db, projectId);
      const baseline = standardSetVersion(criteriaFromDefinitions(definitions));

      // The proposal: criterion 2 reworded, criterion 3 dropped, one added, criterion 1 — the one
      // with the ideographic spaces — restated character for character.
      const proposed: ProposedCriterion[] = [
        {
          id: definitions[0]!.id, ordinal: 1, text: IDEOGRAPHIC, verificationMethod: METHOD,
          completionCriterionOverrideReason: null,
        },
        {
          id: definitions[1]!.id, ordinal: 2, text: `${PLAIN}, restated more loosely`,
          verificationMethod: METHOD, completionCriterionOverrideReason: null,
        },
        {
          id: null, ordinal: 3, text: 'a criterion this proposal adds', verificationMethod: METHOD,
          completionCriterionOverrideReason: null,
        },
      ];
      const request = criteriaWeakeningRequest(projectId, proposed);
      const action: CriteriaWeakeningAction = {
        request,
        baseline: { seal: baseline.digest, material: baseline.material },
        supersedes: null,
      };
      const contract = await db.projectCompletionContract.findUniqueOrThrow({
        where: { projectId },
      });
      const intentId = randomUUID();
      await db.projectRatifiedActionIntent.create({
        data: {
          id: intentId,
          projectId,
          ownerId,
          principalType: 'OWNER',
          principalId: ownerId,
          triggerKind: 'MANUAL',
          effectClass: CRITERIA_WEAKENING_EFFECT_CLASS,
          contractDigest: contract.contractDigest,
          contractRevision: contract.contractRevision,
          evaluationPlanDigest: contract.evaluationPlanDigest,
          riskPolicyDigest: contract.riskPolicyDigest,
          permissionDigest: contract.permissionDigest,
          budgetDigest: contract.budgetDigest,
          recipientDigest: contract.recipientDigest,
          budgetCharge: 0,
          action: action as unknown as object,
          actionDigest: criteriaWeakeningActionDigest(request),
          idempotencyKey: `settled-read-${intentId}`,
          commitToken: randomUUID(),
        },
      });
      await db.projectCriteriaDecision.create({
        data: {
          intentId,
          projectId,
          ownerId,
          decision: 'APPROVE',
          decidedById: ownerId,
          baseSeal: baseline.digest,
          resultingSeal: baseline.digest,
        },
      });

      const settled = await recentlySettledCriteriaDecisions(db, ownerId, projectId);

      assert.equal(settled.length, 1);
      const proposal = settled[0]!.proposal;
      assert.ok(proposal, 'the answer publishes what the proposal asked for');
      assert.deepEqual(
        {
          reworded: proposal.rewordedCount,
          added: proposal.addedCount,
          dropped: proposal.droppedCount,
          unchanged: proposal.unchangedCount,
        },
        { reworded: 1, added: 1, dropped: 1, unchanged: 1 },
        'the criterion restated verbatim — the one whose ends are ideographic spaces — is the '
        + 'unchanged one, and it is the whole reason this case is here',
      );
      const reworded = proposal.changed.find((entry) => entry.change === 'REWORDED');
      assert.equal(reworded?.ordinal, 2);
      assert.equal(reworded?.definitionId, definitions[1]!.id);
      assert.equal(reworded?.text, `${PLAIN}, restated more loosely`);
      const dropped = proposal.changed.find((entry) => entry.change === 'DROPPED');
      assert.equal(dropped?.definitionId, definitions[2]!.id);
      assert.equal(dropped?.ordinal, null);
      assert.equal(proposal.changed.find((entry) => entry.change === 'ADDED')?.text,
        'a criterion this proposal adds');
    });
  } finally {
    await db.$disconnect();
  }
});

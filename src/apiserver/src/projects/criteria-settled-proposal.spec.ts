/**
 * WHAT AN ANSWERED PROPOSAL STILL SAYS ABOUT ITSELF.
 *
 * Until 2026-09-17 the answer published for a settled proposal was the outcome and the two seals,
 * and the proposal's own words were deliberately withheld — so pressing Approve turned a card
 * showing a word-by-word diff into one line of receipt, and the account owner's report was the
 * plain consequence: "after approving, I can no longer see what the change was".
 *
 * The words were never gone. A filed proposal is immutable (0195's BEFORE UPDATE OR DELETE
 * trigger), so the restatement that was applied is still in its `action` JSONB, and so is the
 * baseline it was composed against — which is what makes "WHICH of the fourteen moved" a question
 * the row can answer on its own. This file pins that it does, on both answers, and pins the two
 * things it must not pretend to:
 *
 *   * a REJECT publishes the same material as an APPROVE, with `decision` the only thing saying
 *     that none of it took effect — a reader shown the words with no answer beside them would read
 *     a refusal as a record of what the project now says;
 *   * a row whose `action` this reader cannot open comes back as an answer with no material, and
 *     does not take the other answers down with it. What happened is still true of a row nobody
 *     can parse.
 *
 * NO DATABASE. The read is driven over a stub that records what it was asked, because the claim
 * here is partly about the SHAPE of the asking: the proposals are fetched once, by the ids the
 * decision rows already named, rather than per row or over the project's whole history.
 * `criteria-pending-decisions.pg.spec.ts` is where the same derivation goes through the real write
 * path, which is a different claim.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';

import {
  recentlySettledCriteriaDecisions,
  settledProposalMaterial,
  type SettledCriterionEntry,
} from './criteria-pending-decisions';
import {
  criteriaWeakeningRequest,
  type CriteriaWeakeningAction,
  type ProposedCriterion,
} from './criteria-weakening-intent';
import { criteriaFromDefinitions, standardSetVersion } from './project-acceptance';

const OWNER = '2f6f2a62-1a3f-4a1e-9d4f-0f3a6c9b1e20';
const PROJECT = '7c1f0b52-7d94-4a2e-8f61-2b8a5d3c4e11';
const KEPT = 'aaaaaaaa-0000-4000-8000-000000000001';
const REWORDED = 'aaaaaaaa-0000-4000-8000-000000000002';
const DROPPED = 'aaaaaaaa-0000-4000-8000-000000000003';
const SEAL_AFTER = 'f'.repeat(64);

/** The three criteria in force when the proposal was composed. */
const ON_RECORD = [
  {
    id: KEPT,
    ordinal: 1,
    text: '每次成功回合结束都跑一次判据命令',
    verificationMethod: 'EXECUTABLE',
    revision: 3,
  },
  {
    id: REWORDED,
    ordinal: 2,
    text: '两个新测试文件都存在且都真的跑过用例并全绿',
    verificationMethod: 'EXECUTABLE',
    revision: 1,
  },
  {
    id: DROPPED,
    ordinal: 3,
    text: '判据命令在本 worktree 根执行，退出码 0',
    verificationMethod: 'EXECUTABLE',
    revision: 2,
  },
];

/**
 * The proposal that was answered: it rewords criterion 2, adds a fourth, drops the third, and
 * restates the first word for word — which is the ordinary shape, since a criteria edit is a
 * whole-collection replacement and most of what it carries is the words already on record.
 */
const PROPOSED: ProposedCriterion[] = [
  {
    id: KEPT,
    ordinal: 1,
    text: '每次成功回合结束都跑一次判据命令',
    verificationMethod: 'EXECUTABLE',
    completionCriterionOverrideReason: null,
  },
  {
    id: REWORDED,
    ordinal: 2,
    text: '两个新测试文件都存在且至少跑过一个用例',
    verificationMethod: 'EXECUTABLE',
    completionCriterionOverrideReason: null,
  },
  {
    id: null,
    ordinal: 3,
    text: '卡片展开后能看出这次批准了什么',
    verificationMethod: 'OWNER_CONFIRMED',
    completionCriterionOverrideReason: null,
  },
];

const BASELINE = standardSetVersion(criteriaFromDefinitions(ON_RECORD));

function filedAction(proposed: ProposedCriterion[] = PROPOSED): CriteriaWeakeningAction {
  return {
    request: criteriaWeakeningRequest(PROJECT, proposed),
    baseline: { seal: BASELINE.digest, material: BASELINE.material },
    supersedes: null,
  };
}

interface DecisionRow {
  intentId: string;
  decision: string;
  decidedAt: Date;
  baseSeal: string;
  resultingSeal: string;
}

/** An answer as the door records it: APPROVE moves the seal, REJECT leaves it where it was. */
function answered(intentId: string, decision: 'APPROVE' | 'REJECT'): DecisionRow {
  return {
    intentId,
    decision,
    decidedAt: new Date('2026-09-17T09:15:00.000Z'),
    baseSeal: BASELINE.digest,
    resultingSeal: decision === 'APPROVE' ? SEAL_AFTER : BASELINE.digest,
  };
}

/**
 * The two tables the read touches, and a record of how it touched the second one.
 *
 * The intent read filters on the ids it was given, because half of what is asserted below is that
 * those are the ids it asks for: a stub that ignored the filter could not tell a read bounded by
 * the answers from one that walked the project's whole history of proposals.
 */
function ledger(decisions: DecisionRow[], intents: Array<{ id: string; action: unknown }>) {
  const intentQueries: Array<{ where?: { id?: { in?: string[] } } }> = [];
  const tx = {
    projectCriteriaDecision: {
      findMany: async (args: { take?: number }) => decisions.slice(0, args.take ?? decisions.length),
    },
    projectRatifiedActionIntent: {
      findMany: async (args: { where?: { id?: { in?: string[] } } }) => {
        intentQueries.push(args);
        const wanted = args.where?.id?.in ?? [];
        return intents.filter((row) => wanted.includes(row.id));
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, intentQueries };
}

function entry(
  material: SettledCriterionEntry[],
  change: SettledCriterionEntry['change'],
): SettledCriterionEntry {
  const found = material.filter((each) => each.change === change);
  assert.equal(found.length, 1, `expected exactly one ${change} entry, got ${found.length}`);
  return found[0]!;
}

test('an approved proposal publishes which criteria moved, with the words that took effect',
  async () => {
    const { tx } = ledger(
      [answered('intent-approved', 'APPROVE')],
      [{ id: 'intent-approved', action: filedAction() }],
    );

    const settled = await recentlySettledCriteriaDecisions(tx, OWNER, PROJECT);

    assert.equal(settled.length, 1);
    const [answer] = settled;
    assert.equal(answer.decision, 'APPROVE');
    const proposal = answer.proposal;
    assert.ok(proposal, 'an approved proposal publishes what it asked for');

    // The counts a card folds on: one criterion rewritten, one added, one dropped, one restated
    // exactly as it stood.
    assert.deepEqual(
      {
        reworded: proposal.rewordedCount,
        added: proposal.addedCount,
        dropped: proposal.droppedCount,
        unchanged: proposal.unchangedCount,
      },
      { reworded: 1, added: 1, dropped: 1, unchanged: 1 },
    );

    // WHICH one was rewritten, by its place in the proposed set rather than by its place in this
    // list — a list of three out of four that renumbered them would name criteria nobody proposed.
    const reworded = entry(proposal.changed, 'REWORDED');
    assert.equal(reworded.ordinal, 2);
    assert.equal(reworded.definitionId, REWORDED);
    assert.equal(reworded.text, '两个新测试文件都存在且至少跑过一个用例',
      'the words that took effect are the proposal\'s, published verbatim');

    const added = entry(proposal.changed, 'ADDED');
    assert.equal(added.ordinal, 3);
    assert.equal(added.definitionId, null, 'a criterion being added names no definition yet');
    assert.equal(added.text, '卡片展开后能看出这次批准了什么');

    // A dropped criterion is entirely words-before, and those are the ones nothing kept: the row
    // says WHICH definition went and refuses to invent a place or a sentence for it.
    const dropped = entry(proposal.changed, 'DROPPED');
    assert.equal(dropped.definitionId, DROPPED);
    assert.equal(dropped.ordinal, null);
    assert.equal(dropped.text, null);

    // The one restated word for word is counted and not listed: `changed` is what moved.
    assert.equal(proposal.changed.length, 3);
    assert.ok(!proposal.changed.some((each) => each.definitionId === KEPT));
  });

test('a refused proposal publishes the same material, with the answer that says none of it applied',
  async () => {
    const { tx } = ledger(
      [answered('intent-refused', 'REJECT')],
      [{ id: 'intent-refused', action: filedAction() }],
    );

    const [answer] = await recentlySettledCriteriaDecisions(tx, OWNER, PROJECT);

    assert.equal(answer.decision, 'REJECT');
    // What a card needs to say "these are the words that were turned down": the material is there,
    // and the seal did not move. Without the material a refusal is a receipt for a question nobody
    // can read; without the answer beside it, it reads as what the project now says.
    assert.ok(answer.proposal, 'a refusal publishes what was asked for');
    assert.equal(answer.proposal.rewordedCount, 1);
    assert.equal(entry(answer.proposal.changed, 'REWORDED').text,
      '两个新测试文件都存在且至少跑过一个用例');
    assert.equal(answer.resultingSeal, answer.baseSeal,
      'nothing was applied, so the ruler stands where it stood');
  });

test('an answer whose proposal cannot be read is still an answer, and does not take the others down',
  async () => {
    const { tx } = ledger(
      [answered('intent-unreadable', 'APPROVE'), answered('intent-readable', 'APPROVE')],
      [
        // Shapes `storedAction` refuses: no request at all, which is every legacy and hand-written
        // row this reader can meet on a table it is not the only writer of.
        { id: 'intent-unreadable', action: { request: null, baseline: { seal: BASELINE.digest } } },
        { id: 'intent-readable', action: filedAction() },
      ],
    );

    const settled = await recentlySettledCriteriaDecisions(tx, OWNER, PROJECT);

    assert.equal(settled.length, 2, 'both answers come back');
    const unreadable = settled.find((each) => each.intentId === 'intent-unreadable');
    assert.ok(unreadable);
    assert.equal(unreadable.decision, 'APPROVE', 'what happened is still true of a row nobody parses');
    assert.equal(unreadable.proposal, null);
    assert.ok(settled.find((each) => each.intentId === 'intent-readable')?.proposal,
      'the readable one beside it is unaffected');
  });

test('an answer whose proposal row is gone publishes the answer and no material', async () => {
  const { tx } = ledger([answered('intent-vanished', 'REJECT')], []);

  const [answer] = await recentlySettledCriteriaDecisions(tx, OWNER, PROJECT);

  assert.equal(answer.decision, 'REJECT');
  assert.equal(answer.proposal, null);
});

test('the proposals are read once, for exactly the answers this read carries', async () => {
  const { tx, intentQueries } = ledger(
    [answered('intent-a', 'APPROVE'), answered('intent-b', 'REJECT')],
    [{ id: 'intent-a', action: filedAction() }, { id: 'intent-b', action: filedAction() }],
  );

  await recentlySettledCriteriaDecisions(tx, OWNER, PROJECT);

  // One query for both, and bounded by the ids the decision rows named: a read that asked which of
  // this project's intents were ever answered would be a walk of its whole history, on a read the
  // card polls every twenty seconds.
  assert.equal(intentQueries.length, 1);
  assert.deepEqual(intentQueries[0]?.where?.id?.in, ['intent-a', 'intent-b']);
});

test('a project with no answers asks the intent table nothing', async () => {
  const { tx, intentQueries } = ledger([], [{ id: 'intent-a', action: filedAction() }]);

  assert.deepEqual(await recentlySettledCriteriaDecisions(tx, OWNER, PROJECT), []);
  assert.equal(intentQueries.length, 0);
});

test('the comparison is the sealed hash, which covers the assertion and not the procedure',
  () => {
    // The floor this derivation stands on, pinned so that closing it is a deliberate act: 0178's
    // `project_acceptance_definition_normalize` computes `content_hash` from `btrim(text)` alone,
    // so a proposal that rewrote only a verification method is counted among the restated ones.
    // The pending card judges all three fields because it holds both sides; a settled one holds a
    // hash. Task B's stored diff is what changes this line.
    const methodOnly = PROPOSED.map((criterion) => criterion.id === REWORDED
      ? { ...criterion, text: ON_RECORD[1]!.text, verificationMethod: 'OWNER_CONFIRMED' }
      : criterion);

    const material = settledProposalMaterial(filedAction(methodOnly));

    assert.ok(material);
    assert.equal(material.rewordedCount, 0);
    assert.equal(material.unchangedCount, 2);
  });

test('a stored action of the wrong shape yields no material rather than a throw', () => {
  for (const action of [null, undefined, 'a string', [], {}, { request: {}, baseline: {} }]) {
    assert.equal(settledProposalMaterial(action), null);
  }
});

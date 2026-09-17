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
 * baseline it was composed against. This file pins what the read makes of the two, and pins the
 * things it must not pretend to:
 *
 *   * a REJECT publishes the same material as an APPROVE, with `decision` the only thing saying
 *     that none of it took effect;
 *   * a row whose `action` this reader cannot open comes back as an answer with no material, and
 *     does not take the other answers down with it;
 *   * a restated criterion whose content hash the database did not answer for leaves the whole
 *     proposal unpublished, rather than being guessed onto one side of "did it move".
 *
 * WHOSE HASH IT IS, WHICH IS THE POINT OF THE STUB BELOW. `content_hash` is not `sha256(text)` and
 * has not been since 0233: the definition's BEFORE trigger writes
 * `project_acceptance_definition_content_hash(btrim(text), btrim(verification_method))`, which
 * hashes the text rendering of a jsonb object. Nothing in TypeScript may reproduce that — a
 * reproduction one byte off reports every restated criterion as rewritten — so the read asks
 * Postgres, and this file's fake Postgres answers with a recipe that is deliberately NOT a hash at
 * all. Every assertion still lands, which is the claim: this code compares what the database said
 * and assumes nothing about how it said it. `criteria-settled-proposal.pg.spec.ts` is where the
 * real recipe is checked against real rows.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';

import {
  recentlySettledCriteriaDecisions,
  sealedWordingKey,
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

const KEPT_TEXT = '每次成功回合结束都跑一次判据命令';
const WAS_TEXT = '两个新测试文件都存在且都真的跑过用例并全绿';
const NOW_TEXT = '两个新测试文件都存在且至少跑过一个用例';
const DROPPED_TEXT = '判据命令在本 worktree 根执行，退出码 0';
const ADDED_TEXT = '卡片展开后能看出这次批准了什么';

/**
 * THE FAKE POSTGRES: `btrim` and then a rendering that is not a hash and not a digest of anything.
 *
 * `btrim` with one argument strips ASCII SPACE and nothing else — not a tab, not `　` — which
 * is the half of the database's behaviour this stub has to keep, because a restatement that differs
 * only in spaces IS the same criterion to the definitions table. The rest is deliberately unlike
 * any hash: if a single assertion below needed the answer to look like sha256 of something, that
 * would be this code assuming the recipe.
 */
const btrim = (value: string): string => value.replace(/^ +| +$/g, '');
const asPostgresWouldSay = (text: string, method: string): string =>
  `pg(${btrim(text)}|${btrim(method)})`;

/** The three criteria in force when the proposal was composed, with the hashes the trigger wrote. */
const ON_RECORD = [
  {
    id: KEPT, ordinal: 1, text: KEPT_TEXT, verificationMethod: 'EXECUTABLE', revision: 3,
    contentHash: asPostgresWouldSay(KEPT_TEXT, 'EXECUTABLE'),
  },
  {
    id: REWORDED, ordinal: 2, text: WAS_TEXT, verificationMethod: 'EXECUTABLE', revision: 1,
    contentHash: asPostgresWouldSay(WAS_TEXT, 'EXECUTABLE'),
  },
  {
    id: DROPPED, ordinal: 3, text: DROPPED_TEXT, verificationMethod: 'EXECUTABLE', revision: 2,
    contentHash: asPostgresWouldSay(DROPPED_TEXT, 'EXECUTABLE'),
  },
];

/**
 * The proposal that was answered: it rewords criterion 2, adds a third, drops the one on record at
 * 3, and restates the first word for word — the ordinary shape, since a criteria edit is a
 * whole-collection replacement and most of what it carries is the words already on record.
 */
const PROPOSED: ProposedCriterion[] = [
  {
    id: KEPT, ordinal: 1, text: KEPT_TEXT, verificationMethod: 'EXECUTABLE',
    completionCriterionOverrideReason: null,
  },
  {
    id: REWORDED, ordinal: 2, text: NOW_TEXT, verificationMethod: 'EXECUTABLE',
    completionCriterionOverrideReason: null,
  },
  {
    id: null, ordinal: 3, text: ADDED_TEXT, verificationMethod: 'OWNER_CONFIRMED',
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

/** The lookup the read gets from the database, here answered by the fake above. */
const postgresAnswers = (wording: { text: string; verificationMethod: string }): string =>
  asPostgresWouldSay(wording.text, wording.verificationMethod);

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
 * The two tables the read touches and the one function it asks Postgres to apply, with a record of
 * how it asked.
 *
 * The intent read filters on the ids it was given, because half of what is asserted below is that
 * those are the ids it asks for. `$queryRaw` is a tagged template, so the three arrays the read
 * sends down arrive as its interpolated values; the stub hashes them the way the fake Postgres
 * above does and hands back `(at, hash)` rows IN A SHUFFLED ORDER — a read that matched them up by
 * position rather than by `at` would pass on a real database most days and lie on the others.
 */
function ledger(
  decisions: DecisionRow[],
  intents: Array<{ id: string; action: unknown }>,
  /** Wordings the fake Postgres returns no row for — a result set short of what was asked. */
  unanswered: readonly string[] = [],
) {
  const intentQueries: Array<{ where?: { id?: { in?: string[] } } }> = [];
  const hashQueries: Array<{ texts: string[]; methods: string[] }> = [];
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
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const [ats, texts, methods] = values as [number[], string[], string[]];
      hashQueries.push({ texts, methods });
      return ats
        .filter((_, index) => !unanswered.includes(texts[index]!))
        .map((at) => ({ at, hash: asPostgresWouldSay(texts[at]!, methods[at]!) }))
        .reverse();
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, intentQueries, hashQueries };
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
    assert.equal(reworded.text, NOW_TEXT,
      'the words that took effect are the proposal\'s, published verbatim');

    const added = entry(proposal.changed, 'ADDED');
    assert.equal(added.ordinal, 3);
    assert.equal(added.definitionId, null, 'a criterion being added names no definition yet');
    assert.equal(added.text, ADDED_TEXT);

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
    assert.equal(entry(answer.proposal.changed, 'REWORDED').text, NOW_TEXT);
    assert.equal(answer.resultingSeal, answer.baseSeal,
      'nothing was applied, so the ruler stands where it stood');
  });

test('whether a criterion moved is the database\'s answer, not a comparison of the words',
  () => {
    // Two restatements of the same criterion that differ as STRINGS: one pads the ends with ASCII
    // spaces, which `btrim` takes off, so the definitions table would store the row it already has.
    // The read is told so by the hash and says "unchanged" — a comparison of the two texts would
    // have called it a rewrite, and a hash this file computed for itself would have agreed with the
    // texts rather than with the database.
    const padded = settledProposalMaterial(
      filedAction([{ ...PROPOSED[0]!, text: `  ${KEPT_TEXT}  ` }]), postgresAnswers,
    );

    assert.ok(padded);
    assert.equal(padded.rewordedCount, 0, 'spaces the database strips are not an edit');
    assert.equal(padded.unchangedCount, 1);

    // And the positive control, so the line above can fail: one character of the assertion moved is
    // a rewrite. A `　` is a character — `btrim` does NOT take it off — which is why the
    // comparison cannot be JavaScript's idea of trimming either.
    const ideographic = settledProposalMaterial(
      filedAction([{ ...PROPOSED[0]!, text: `　${KEPT_TEXT}` }]), postgresAnswers,
    );

    assert.equal(ideographic?.rewordedCount, 1,
      'an ideographic space is part of the assertion, and the database says so');
    assert.equal(ideographic?.unchangedCount, 0);
  });

test('a rewrite of only the verification method is a rewrite', () => {
  // `content_hash` covers the assertion AND how it is judged (0233), so this is not a hole in the
  // way `completionCriterionOverrideReason` — which the hash does not cover — still is.
  const material = settledProposalMaterial(
    filedAction([{ ...PROPOSED[0]!, verificationMethod: 'OWNER_CONFIRMED' }]), postgresAnswers,
  );

  assert.equal(material?.rewordedCount, 1);
  assert.equal(material?.unchangedCount, 0);
  assert.equal(entry(material!.changed, 'REWORDED').definitionId, KEPT);
});

test('a restated criterion the database did not answer for leaves the proposal unpublished', () => {
  // Not a guess in either direction. "This reader cannot say what this proposal did" is a state the
  // card already draws — as the receipt line and no fold — and putting an unmeasured criterion into
  // `unchangedCount` would make the folded line assert something nobody derived.
  assert.equal(settledProposalMaterial(filedAction(), () => undefined), null);

  // The criterion being ADDED needs no hash: there is nothing on record for it to differ from.
  const onlyAdded = settledProposalMaterial(filedAction([PROPOSED[2]!]), () => undefined);
  assert.equal(onlyAdded?.addedCount, 1);
});

test('a wording the database returned no row for leaves that proposal unpublished', async () => {
  // The result set came back one row short. Nothing in the answer says WHICH criterion that was, so
  // the read must not fill the gap: an empty string compares unequal to every sealed hash, and a
  // placeholder would have arrived looking exactly like a criterion that had been rewritten.
  const { tx } = ledger(
    [answered('intent-short', 'APPROVE')],
    [{ id: 'intent-short', action: filedAction() }],
    [KEPT_TEXT],
  );

  const [answer] = await recentlySettledCriteriaDecisions(tx, OWNER, PROJECT);

  assert.equal(answer.decision, 'APPROVE', 'the answer itself is still published');
  assert.equal(answer.proposal, null);
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

test('the proposals and their hashes are read once, for exactly the answers this read carries',
  async () => {
    const { tx, intentQueries, hashQueries } = ledger(
      [answered('intent-a', 'APPROVE'), answered('intent-b', 'REJECT')],
      [{ id: 'intent-a', action: filedAction() }, { id: 'intent-b', action: filedAction() }],
    );

    const settled = await recentlySettledCriteriaDecisions(tx, OWNER, PROJECT);

    // One query for both proposals, bounded by the ids the decision rows named: a read that asked
    // which of this project's intents were ever answered would be a walk of its whole history, on a
    // read the card polls every twenty seconds.
    assert.equal(intentQueries.length, 1);
    assert.deepEqual(intentQueries[0]?.where?.id?.in, ['intent-a', 'intent-b']);
    // And ONE query for every hash, over the DISTINCT wordings: two answers about the same three
    // criteria ask about three, not six.
    assert.equal(hashQueries.length, 1);
    assert.deepEqual(hashQueries[0]?.texts, [KEPT_TEXT, NOW_TEXT, ADDED_TEXT]);
    assert.deepEqual(hashQueries[0]?.methods, ['EXECUTABLE', 'EXECUTABLE', 'OWNER_CONFIRMED']);
    // The stub hands its rows back reversed, so this also says the read matches them up by `at`.
    assert.equal(settled[0]?.proposal?.rewordedCount, 1);
    assert.equal(settled[1]?.proposal?.unchangedCount, 1);
  });

test('a project with no answers asks the intent table nothing', async () => {
  const { tx, intentQueries, hashQueries } = ledger([], [{ id: 'intent-a', action: filedAction() }]);

  assert.deepEqual(await recentlySettledCriteriaDecisions(tx, OWNER, PROJECT), []);
  assert.equal(intentQueries.length, 0);
  assert.equal(hashQueries.length, 0);
});

test('a stored action of the wrong shape yields no material rather than a throw', () => {
  for (const action of [null, undefined, 'a string', [], {}, { request: {}, baseline: {} }]) {
    assert.equal(settledProposalMaterial(action, postgresAnswers), null);
  }
});

test('one wording is one key, and two are two', () => {
  // What the read looks a hash up by. Both fields, because both are in the hash — and a separator
  // that cannot appear in either, so two criteria cannot collide into one answer.
  assert.equal(
    sealedWordingKey({ text: 'a', verificationMethod: 'b' }),
    sealedWordingKey({ text: 'a', verificationMethod: 'b' }),
  );
  assert.notEqual(
    sealedWordingKey({ text: 'a', verificationMethod: 'b' }),
    sealedWordingKey({ text: 'a', verificationMethod: 'c' }),
  );
});

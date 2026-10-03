import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import { criterionStandingRefusal } from './task-evidence-decision';
import {
  type CriterionStandingTask,
  evidenceCriterionMatch,
  heldToProjectCriterion,
  parseEvidenceEnvelope,
} from './task-evidence-envelope';

/**
 * The live standard a task in NO project is held to, which is its own `acceptanceCriteria`.
 *
 * WHAT WAS WRONG
 * --------------
 * `evidenceCriterionMatch` resolved the live text from exactly one place, the project's criterion
 * definitions, and skipped even that when the task had no project:
 *
 *     const definitionId = projectId ? definitionIdFromKey(criterion.key) : null;
 *
 * so for a task with no project `live` was unconditionally null and `matchesLive` unconditionally
 * false. Check 2 of the decision door then spent that false as a refusal — 409
 * `EVIDENCE_JUDGMENT_CRITERION_MOVED` — on evidence whose quote had not moved anywhere. Observed
 * on 2026-09-05: a task with six resolved TOOL_CALL citations could not be CONFIRMed or even
 * SEND_BACK'd, at any revision, because both decisions run through the same check.
 *
 * The two sentences that got collapsed into one are "the standard moved" and "nothing was ever
 * consulted", and only the second was true. A task in no project does state a standard: its
 * `acceptanceCriteria` column, editable through `task_update` for the whole life of the task, and
 * already the text such a submission quotes verbatim.
 *
 * WHAT IS PINNED HERE
 * -------------------
 * Both functions take `tx` as a parameter, so a fake transaction client drives all of it and no
 * database is involved. The fake also RECORDS every criterion-definition lookup, which is how the
 * two directions are told apart: the project lane must still ask that table, and the task's own
 * lane must not ask it at all.
 *
 * AND A TASK IN A PROJECT THAT DECLARES NO CRITERION
 * --------------------------------------------------
 * The same lie survived one door further in: the lane was chosen by `projectId`, so a task filed
 * under a project WITHOUT a `criterionKey` was held to the project's criterion table — a standard
 * it never declared. Quoting its own `acceptanceCriteria` was refused as moved at every revision
 * (observed on 2026-10-03), and the only quote that passed was some other criterion of the
 * project's, borrowed as a wrapper. The lane is now chosen by the declaration
 * (`heldToProjectCriterion`): such a task is held to its own criteria exactly like a task in no
 * project, and a task that declares a criterion answers exactly as before.
 */

const PROJECT_ID = '00000000-0000-7000-8000-00000000c0de';
const DEFINITION_ID = '11111111-1111-7111-8111-111111111111';
/** What `project_get` prints beside a criterion: the Base62 public id of the definition row. */
const DEFINITION_KEY = uuidToBase62(DEFINITION_ID);
/** A key that resolves to no definition row at all — `base62ToUuid` gives a non-UUID for it. */
const UNRESOLVABLE_KEY = 'notacriterionkey';
/** What submitters write for a task in no project today: the task's own public id. */
const OWN_PUBLIC_ID_KEY = '34JPtYithZCi65TgVIaUu';

const CRITERION_TEXT = 'the four pg specs are run on a disposable postgres and their output quoted';
const MOVED_TEXT = `${CRITERION_TEXT}, and the deployed apiserver is upgraded`;
/** Carries a composed character, so NFC and NFD are genuinely different strings for it. */
const ACCENTED_TEXT = 'the résumé of the run is quoted verbatim';

interface Definition {
  id: string;
  projectId: string;
  text: string;
}

/** A transaction client that answers the one query the criterion lane makes, and remembers it. */
function transactionOver(definitions: ReadonlyArray<Definition>) {
  const lookups: Array<{ id: string; projectId: string }> = [];
  const tx = {
    projectAcceptanceCriterionDefinition: {
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) => {
        lookups.push({ id: where.id, projectId: where.projectId });
        const row = definitions.find(
          (definition) => definition.id === where.id && definition.projectId === where.projectId,
        );
        return row ? { text: row.text } : null;
      },
    },
  };
  return { tx: tx as never, lookups };
}

const LIVE_DEFINITION: Definition = {
  id: DEFINITION_ID,
  projectId: PROJECT_ID,
  text: CRITERION_TEXT,
};

/** The stored envelope, exactly as `task_evidence_submit` wrote it. */
function evidence(criterion: { key: string; text: string }): unknown {
  return {
    claim: 'the work is done and the citations resolve',
    criterion,
    checks: [{ kind: 'TOOL_CALL', ref: 'toolu_01', command: 'npm test', succeeded: true }],
    gaps: [],
  };
}

function taskInNoProject(acceptanceCriteria: string | null): CriterionStandingTask {
  return { projectId: null, criterionDefinitionId: null, criterionRevision: null, acceptanceCriteria };
}

/** Filed under the project with `criterionKey` naming the live definition. */
function taskDeclaringTheCriterion(acceptanceCriteria: string | null): CriterionStandingTask {
  return { projectId: PROJECT_ID, criterionDefinitionId: DEFINITION_ID, criterionRevision: 1, acceptanceCriteria };
}

/** Filed under the same project, with no `criterionKey` at all. */
function taskInProjectDeclaringNone(acceptanceCriteria: string | null): CriterionStandingTask {
  return { projectId: PROJECT_ID, criterionDefinitionId: null, criterionRevision: null, acceptanceCriteria };
}

/** Declared the criterion, which the project has since deleted: the FK's ON DELETE SET NULL took
 *  the id and left the revision (0232). */
function taskWhoseDeclaredCriterionWasDeleted(acceptanceCriteria: string | null): CriterionStandingTask {
  return { projectId: PROJECT_ID, criterionDefinitionId: null, criterionRevision: 1, acceptanceCriteria };
}

/** This task's own words: deliberately NOT the project criterion's, so borrowing one shows. */
const OWN_CRITERIA_TEXT = 'the decision door accepts evidence quoting this task\'s own acceptance criteria';

// ── 1. A task in no project, quoting its own criteria word for word ─────────────────────────────

test('a task in no project is decided against its own acceptance criteria', async () => {
  const { tx, lookups } = transactionOver([LIVE_DEFINITION]);
  const task = taskInNoProject(CRITERION_TEXT);
  const quoted = { key: OWN_PUBLIC_ID_KEY, text: CRITERION_TEXT };

  assert.equal((await evidenceCriterionMatch(tx, task, quoted)).matchesLive, true);
  assert.equal(await criterionStandingRefusal(tx, task, evidence(quoted)), null,
    'a quote that is word for word the task\'s own stated criteria was refused as having moved');

  // And it did not get there by asking the project's criterion table anything: a task with no
  // project has no definition row to name, and a lookup here would mean the answer came from
  // somewhere this task has no relationship with.
  assert.deepEqual(lookups, []);
});

test('the same comparison as the project lane: line endings, composition and edge whitespace', async () => {
  const { tx } = transactionOver([]);
  // \r\n for \n, NFD for NFC, and padding at both ends: the three differences
  // `comparableCriterionText` already normalises away for a project's criteria. The same standard,
  // typed on a different machine, is not a rewritten standard — and this lane compares with that
  // same function rather than a second, stricter one.
  const stated = `  ${ACCENTED_TEXT.normalize('NFC')}\n`;
  const quoted = { key: OWN_PUBLIC_ID_KEY, text: `${ACCENTED_TEXT.normalize('NFD')}\r\n` };
  assert.notEqual(stated, quoted.text, 'the two spellings are identical, so this proves nothing');

  const task = taskInNoProject(stated);
  assert.equal((await evidenceCriterionMatch(tx, task, quoted)).matchesLive, true);
  assert.equal(await criterionStandingRefusal(tx, task, evidence(quoted)), null);
});

test('the key is the task\'s own public id by convention, and nothing reads it', async () => {
  const { tx, lookups } = transactionOver([]);
  const task = taskInNoProject(CRITERION_TEXT);

  // The shape layer requires a non-blank key, so an envelope for a task in no project has to put
  // SOMETHING there. The convention is the task's own public id, which is what the submission that
  // hit the 409 on 2026-09-05 already wrote, and it has to keep working.
  const asSubmittedToday = evidence({ key: OWN_PUBLIC_ID_KEY, text: CRITERION_TEXT });
  assert.equal(parseEvidenceEnvelope(asSubmittedToday).criterion.key, OWN_PUBLIC_ID_KEY);
  assert.equal(await criterionStandingRefusal(tx, task, asSubmittedToday), null);

  // And the convention is compatible because nothing resolves it: this lane binds to the TEXT,
  // exactly as the project lane does, so a key naming something else entirely decides nothing.
  for (const key of [DEFINITION_KEY, UNRESOLVABLE_KEY, 'the acceptance criteria of this task']) {
    assert.equal((await evidenceCriterionMatch(tx, task, { key, text: CRITERION_TEXT })).matchesLive,
      true, `the key ${key} was resolved for a task that has no project to resolve it in`);
  }
  assert.deepEqual(lookups, [], 'a task with no project sent a key to the project criterion table');
});

// ── 2. A quote that drifted from those criteria: refused, and refused as having MOVED ───────────

test('a quote the task\'s own criteria no longer match is refused as a standard that moved', async () => {
  const { tx, lookups } = transactionOver([LIVE_DEFINITION]);
  const task = taskInNoProject(MOVED_TEXT);
  const quoted = { key: OWN_PUBLIC_ID_KEY, text: CRITERION_TEXT };

  assert.equal((await evidenceCriterionMatch(tx, task, quoted)).matchesLive, false);
  const refusal = await criterionStandingRefusal(tx, task, evidence(quoted));
  assert.ok(refusal, 'evidence measured against superseded wording was accepted');

  // The reason is the one that is true: this task states criteria, and they are not these.
  assert.match(String(refusal?.reason), /not what this task states today/);
  assert.doesNotMatch(String(refusal?.reason), /states no acceptance criteria/,
    'a standard that moved was reported as a standard that never existed');
  assert.match(String(refusal?.message), /nothing was written/);
  assert.equal(refusal?.criterionKey, OWN_PUBLIC_ID_KEY);
  assert.deepEqual(lookups, []);
});

// ── 3. A task in no project with nothing stated: refused, because there IS no standard ──────────

test('a task in no project that states no criteria has nothing to decide evidence against', async () => {
  // null, never written; empty, cleared; blank, written and then emptied out. All three are the
  // same fact: this task has published no standard, so there is nothing to hold evidence to.
  for (const stated of [null, '', '   \n\t  ']) {
    const { tx, lookups } = transactionOver([LIVE_DEFINITION]);
    const task = taskInNoProject(stated);
    const quoted = { key: OWN_PUBLIC_ID_KEY, text: CRITERION_TEXT };

    assert.equal((await evidenceCriterionMatch(tx, task, quoted)).matchesLive, false,
      `acceptanceCriteria ${JSON.stringify(stated)} was treated as a live standard`);
    const refusal = await criterionStandingRefusal(tx, task, evidence(quoted));
    assert.ok(refusal, `acceptanceCriteria ${JSON.stringify(stated)} decided evidence`);
    assert.match(String(refusal?.reason), /states no acceptance criteria/);
    assert.doesNotMatch(String(refusal?.reason), /not what this task states today/,
      'a task with no standard at all was told its standard had moved');
    // The refusal says what would clear it, which for this case is writing the criteria at all.
    assert.match(String(refusal?.message), /acceptanceCriteria/);
    assert.deepEqual(lookups, []);
  }
});

test('the two refusals a task in no project can get are different sentences', async () => {
  const { tx } = transactionOver([]);
  const quoted = { key: OWN_PUBLIC_ID_KEY, text: CRITERION_TEXT };
  const moved = await criterionStandingRefusal(tx, taskInNoProject(MOVED_TEXT), evidence(quoted));
  const absent = await criterionStandingRefusal(tx, taskInNoProject(null), evidence(quoted));

  assert.ok(moved && absent, 'one of the two cases was not refused at all');
  assert.notEqual(moved?.reason, absent?.reason,
    'a moved standard and a missing one are the same refusal again');
});

// ── 4. A task in a project that declares no criterion: its own criteria, like a task in none ────

test('a project task that declares no criterion is decided against its own acceptance criteria',
  async () => {
    const { tx, lookups } = transactionOver([LIVE_DEFINITION]);
    const task = taskInProjectDeclaringNone(OWN_CRITERIA_TEXT);
    const quoted = { key: OWN_PUBLIC_ID_KEY, text: OWN_CRITERIA_TEXT };

    assert.equal((await evidenceCriterionMatch(tx, task, quoted)).matchesLive, true);
    assert.equal(await criterionStandingRefusal(tx, task, evidence(quoted)), null,
      'a project task quoting its own stated criteria word for word was refused as having moved');
    // Being filed under the project does not make its criterion table this task's standard: the
    // task declared none of it, so nothing there was asked.
    assert.deepEqual(lookups, []);
  });

test('borrowing another criterion of the project no longer passes for a task that declares none',
  async () => {
    // The wrapper that used to be the only quote such a task could get through: a live criterion of
    // the same project, quoted by its real key and its exact current text. It is not this task's
    // standard, so it is a quote that does not match the standard this task states.
    const { tx, lookups } = transactionOver([LIVE_DEFINITION]);
    const task = taskInProjectDeclaringNone(OWN_CRITERIA_TEXT);
    const borrowed = { key: DEFINITION_KEY, text: CRITERION_TEXT };

    assert.equal((await evidenceCriterionMatch(tx, task, borrowed)).matchesLive, false);
    const refusal = await criterionStandingRefusal(tx, task, evidence(borrowed));
    assert.ok(refusal, 'an unrelated project criterion was accepted as this task\'s standard');
    assert.match(String(refusal?.reason), /not what this task states today/);
    assert.equal(refusal?.criterionKey, DEFINITION_KEY);
    assert.deepEqual(lookups, [], 'the borrowed key was resolved for a task that declares no criterion');
  });

test('a project task whose own criteria were rewritten refuses the old quote as moved', async () => {
  const { tx, lookups } = transactionOver([LIVE_DEFINITION]);
  const task = taskInProjectDeclaringNone(`${OWN_CRITERIA_TEXT}, and says so in the receipt`);
  const quoted = { key: OWN_PUBLIC_ID_KEY, text: OWN_CRITERIA_TEXT };

  assert.equal((await evidenceCriterionMatch(tx, task, quoted)).matchesLive, false);
  const refusal = await criterionStandingRefusal(tx, task, evidence(quoted));
  assert.ok(refusal, 'evidence measured against superseded wording was accepted');
  assert.match(String(refusal?.reason), /not what this task states today/);
  assert.doesNotMatch(String(refusal?.reason), /not what the project states today/,
    'a task that declares no project criterion was told the project\'s criterion moved');
  assert.match(String(refusal?.message), /nothing was written/);
  assert.deepEqual(lookups, []);
});

test('a project task that declares no criterion and states none is told both ways out', async () => {
  for (const stated of [null, '', '   \n\t  ']) {
    const { tx, lookups } = transactionOver([LIVE_DEFINITION]);
    const task = taskInProjectDeclaringNone(stated);
    const quoted = { key: DEFINITION_KEY, text: CRITERION_TEXT };

    assert.equal((await evidenceCriterionMatch(tx, task, quoted)).matchesLive, false,
      `acceptanceCriteria ${JSON.stringify(stated)} was treated as a live standard`);
    const refusal = await criterionStandingRefusal(tx, task, evidence(quoted));
    assert.ok(refusal, `acceptanceCriteria ${JSON.stringify(stated)} decided evidence`);
    assert.match(String(refusal?.reason), /declares no live criterion of its project/);
    assert.match(String(refusal?.reason), /states no acceptance criteria/);
    // It IS in a project, so the no-project sentence would be false; and nothing moved.
    assert.doesNotMatch(String(refusal?.reason), /in no project/);
    assert.doesNotMatch(String(refusal?.reason), /states today/);
    assert.match(String(refusal?.message), /acceptanceCriteria/);
    assert.match(String(refusal?.message), /criterionKey/);
    assert.deepEqual(lookups, []);
  }
});

test('declaring the criterion, not filing the task, is what puts it on the project lane', async () => {
  // One project, one live criterion, and the same two quotes put to the two shapes a task in it
  // can have. Each shape accepts exactly the quote of its own standard and refuses the other's —
  // so the task's own criteria do not rescue a task that declared a project criterion, and the
  // project's criterion does not rescue a task that declared none.
  const own = { key: OWN_PUBLIC_ID_KEY, text: OWN_CRITERIA_TEXT };
  const declared = { key: DEFINITION_KEY, text: CRITERION_TEXT };
  const cases = [
    { task: taskInProjectDeclaringNone(OWN_CRITERIA_TEXT), quoted: own, live: true },
    { task: taskInProjectDeclaringNone(OWN_CRITERIA_TEXT), quoted: declared, live: false },
    { task: taskDeclaringTheCriterion(OWN_CRITERIA_TEXT), quoted: declared, live: true },
    { task: taskDeclaringTheCriterion(OWN_CRITERIA_TEXT), quoted: own, live: false },
  ];
  for (const each of cases) {
    const { tx } = transactionOver([LIVE_DEFINITION]);
    const name = `${each.task.criterionDefinitionId ? 'declaring' : 'declaring none'}, quoting ${each.quoted.key}`;
    assert.equal((await evidenceCriterionMatch(tx, each.task, each.quoted)).matchesLive, each.live, name);
    assert.equal(await criterionStandingRefusal(tx, each.task, evidence(each.quoted)) === null, each.live, name);
  }
});

test('the lane is the project\'s only when the task is filed there AND declares one of its criteria', () => {
  assert.equal(heldToProjectCriterion(taskInNoProject(CRITERION_TEXT)), false);
  assert.equal(heldToProjectCriterion(taskInProjectDeclaringNone(CRITERION_TEXT)), false);
  assert.equal(heldToProjectCriterion(taskDeclaringTheCriterion(CRITERION_TEXT)), true);
  assert.equal(heldToProjectCriterion(taskWhoseDeclaredCriterionWasDeleted(CRITERION_TEXT)), true);
});

test('a task whose declared criterion was deleted is decided against neither its own criteria nor another', async () => {
  // The decoy: the task's own criteria repeat the deleted criterion word for word, so its own lane
  // would match the old quote. Deleting a criterion is also how a rewording that drops the item's
  // id arrives (the row is replaced), so this is the declared lane's "the wording moved" too. And
  // the project still states a live criterion, word for word the same, under a key of its own: a
  // declaration that no longer names one does not get to borrow it either.
  const { tx, lookups } = transactionOver([LIVE_DEFINITION]);
  const task = taskWhoseDeclaredCriterionWasDeleted(CRITERION_TEXT);
  for (const quoted of [
    { key: DEFINITION_KEY, text: CRITERION_TEXT },
    { key: OWN_PUBLIC_ID_KEY, text: CRITERION_TEXT },
  ]) {
    assert.equal((await evidenceCriterionMatch(tx, task, quoted)).matchesLive, false,
      `a task whose criterion was deleted passed quoting ${quoted.key}`);
    const refusal = await criterionStandingRefusal(tx, task, evidence(quoted));
    assert.ok(refusal, `a task whose criterion was deleted was decidable quoting ${quoted.key}`);
    assert.equal(refusal?.criterionKey, quoted.key);
    assert.match(String(refusal?.reason), /declared has since been deleted/);
    assert.match(String(refusal?.message), /nothing was written/);
    assert.match(String(refusal?.message), /criterionKey: null/,
      'the refusal does not say how a declaration whose criterion is gone is taken back');
  }
  assert.deepEqual(lookups, [], 'a key was resolved for a declaration that names no criterion');
});

// ── 5. The project lane, unchanged in all four of its cases ─────────────────────────────────────

test('a task that declares a project criterion answers exactly as it did before this fallback existed', async () => {
  // The four cases, with the answers the implementation gave before the no-project branch was
  // added: the live text is the definition row the key names, and a quote matches only when it is
  // still worded that way. Nothing here is new behaviour; this is the row-by-row negative control
  // that the fallback did not leak into the lane that was already right.
  const cases = [
    { name: 'key resolves, text still matches', key: DEFINITION_KEY, text: CRITERION_TEXT, matches: true },
    { name: 'key resolves, text was rewritten', key: DEFINITION_KEY, text: MOVED_TEXT, matches: false },
    { name: 'key resolves to nothing, text matches the live criterion', key: UNRESOLVABLE_KEY, text: CRITERION_TEXT, matches: false },
    { name: 'key resolves to nothing, text does not match either', key: UNRESOLVABLE_KEY, text: MOVED_TEXT, matches: false },
  ];

  for (const each of cases) {
    const { tx, lookups } = transactionOver([LIVE_DEFINITION]);
    // The decoy: this task's OWN acceptance criteria are word for word what the evidence quotes.
    // A task that declares a project criterion is held to the project's stated criterion and to
    // nothing else, so this column must not rescue a single one of the three refusals below.
    const task = taskDeclaringTheCriterion(each.text);
    const quoted = { key: each.key, text: each.text };

    assert.equal((await evidenceCriterionMatch(tx, task, quoted)).matchesLive, each.matches, each.name);
    const refusal = await criterionStandingRefusal(tx, task, evidence(quoted));
    assert.equal(refusal === null, each.matches, each.name);
    if (refusal !== null) {
      const reason =
        `the criterion this evidence quotes (${each.key}) is not what the project states today`;
      assert.equal(refusal.reason, reason,
        'the project lane\'s refusal is worded differently than it was');
      assert.equal(
        refusal.message,
        `${reason}; nothing was written. The quote is bound to the criterion's CONTENT, not to `
        + 'its key, so a rewritten standard is a different standard and this evidence has not been '
        + 'measured against it',
      );
      assert.equal(refusal.criterionKey, each.key);
    }

    // A resolvable key is still looked up in the project's own definitions, by the id the key
    // decodes to — once for each of the two calls above, which is the same lookup asked twice.
    // An unresolvable one never reaches the table at all.
    assert.deepEqual(
      lookups,
      each.key === DEFINITION_KEY
        ? [{ id: DEFINITION_ID, projectId: PROJECT_ID }, { id: DEFINITION_ID, projectId: PROJECT_ID }]
        : [],
      each.name,
    );
  }
});

test('a task that declares a criterion is held to it, not to another live criterion of its project', async () => {
  // Both criteria are live and quoted word for word under their own keys; only one is this task's.
  const otherId = '22222222-2222-7222-8222-222222222222';
  const other: Definition = { id: otherId, projectId: PROJECT_ID, text: MOVED_TEXT };
  const { tx, lookups } = transactionOver([LIVE_DEFINITION, other]);
  const task = taskDeclaringTheCriterion(MOVED_TEXT);
  const borrowed = { key: uuidToBase62(otherId), text: MOVED_TEXT };

  assert.equal((await evidenceCriterionMatch(tx, task, borrowed)).matchesLive, false,
    'another criterion of the project stood in for the one this task declares');
  const refusal = await criterionStandingRefusal(tx, task, evidence(borrowed));
  assert.ok(refusal, 'evidence measured against a criterion the task does not declare was decidable');
  assert.equal(refusal?.reason,
    `the criterion this evidence quotes (${borrowed.key}) is not the one this task declares (${DEFINITION_KEY})`);
  assert.match(String(refusal?.message), /nothing was written/);
  assert.match(String(refusal?.message), /criterionKey/);
  assert.deepEqual(lookups, [], 'the borrowed key was resolved for a task that declares another');

  // The criterion it declares still decides it, by the Base62 key or the raw UUID alike.
  for (const key of [DEFINITION_KEY, DEFINITION_ID]) {
    const own = { key, text: CRITERION_TEXT };
    assert.equal((await evidenceCriterionMatch(tx, task, own)).matchesLive, true, key);
    assert.equal(await criterionStandingRefusal(tx, task, evidence(own)), null, key);
  }
});

test('evidence that quotes no criterion at all is refused wherever the task is filed', async () => {
  const { tx } = transactionOver([LIVE_DEFINITION]);
  for (const task of [
    taskInNoProject(CRITERION_TEXT),
    taskInProjectDeclaringNone(CRITERION_TEXT),
    taskDeclaringTheCriterion(CRITERION_TEXT),
  ]) {
    const refusal = await criterionStandingRefusal(tx, task, { summary: 'the suite passed' });
    assert.ok(refusal, 'a submission from before the envelope was decided');
    assert.equal(refusal?.criterionKey, null);
    assert.match(String(refusal?.reason), /quotes no project criterion/);
  }
});

// ── 6. One predicate, and both doors call it ────────────────────────────────────────────────────

const MATRIX: ReadonlyArray<{ task: CriterionStandingTask; key: string; text: string }> = [
  { task: taskInNoProject(CRITERION_TEXT), key: OWN_PUBLIC_ID_KEY, text: CRITERION_TEXT },
  { task: taskInNoProject(CRITERION_TEXT), key: OWN_PUBLIC_ID_KEY, text: MOVED_TEXT },
  { task: taskInNoProject(null), key: OWN_PUBLIC_ID_KEY, text: CRITERION_TEXT },
  { task: taskInNoProject(''), key: DEFINITION_KEY, text: CRITERION_TEXT },
  { task: taskDeclaringTheCriterion(CRITERION_TEXT), key: DEFINITION_KEY, text: CRITERION_TEXT },
  { task: taskDeclaringTheCriterion(CRITERION_TEXT), key: DEFINITION_KEY, text: MOVED_TEXT },
  { task: taskDeclaringTheCriterion(CRITERION_TEXT), key: UNRESOLVABLE_KEY, text: CRITERION_TEXT },
  { task: taskDeclaringTheCriterion(null), key: DEFINITION_KEY, text: CRITERION_TEXT },
  { task: taskInProjectDeclaringNone(OWN_CRITERIA_TEXT), key: OWN_PUBLIC_ID_KEY, text: OWN_CRITERIA_TEXT },
  { task: taskInProjectDeclaringNone(OWN_CRITERIA_TEXT), key: DEFINITION_KEY, text: CRITERION_TEXT },
  { task: taskInProjectDeclaringNone(MOVED_TEXT), key: OWN_PUBLIC_ID_KEY, text: CRITERION_TEXT },
  { task: taskInProjectDeclaringNone(null), key: DEFINITION_KEY, text: CRITERION_TEXT },
];

test('what the submitter is told and what the door does cannot disagree', async () => {
  // The submission path REPORTS `criterionMatch.matchesLive` and the decision door REFUSES on the
  // standing check. If those were two derivations, the receipt could say the quote is live while
  // the door refused it as moved — and the queue, which asks the door's predicate, would list a
  // row every decision fails on. Same inputs, opposite sides, one answer.
  for (const each of MATRIX) {
    const { tx } = transactionOver([LIVE_DEFINITION]);
    const quoted = { key: each.key, text: each.text };
    const reported = await evidenceCriterionMatch(tx, each.task, quoted);
    const refusal = await criterionStandingRefusal(tx, each.task, evidence(quoted));

    assert.equal(reported.matchesLive, refusal === null,
      `the submitter was told matchesLive=${reported.matchesLive} and the door said `
      + `${refusal === null ? 'decidable' : 'refused'} for the same evidence`);
    // The receipt is a quote of the submission, never of the live standard: a submitter who is
    // told their evidence is stale still needs to see what they themselves wrote.
    assert.deepEqual(reported, { key: each.key, text: each.text, matchesLive: reported.matchesLive });
  }
});

function repoRoot(): string {
  // build/tasks -> build -> apiserver -> src -> repository root
  return path.resolve(__dirname, '../../../..');
}

function read(relative: string): string {
  return readFileSync(path.join(repoRoot(), relative), 'utf8');
}

test('all three callers hand the predicate the task row, not a project id', () => {
  // A text scan, because what it checks is a WIRING: the runtime agreement above holds for the
  // arguments the callers pass, and passing a different task — or a row read without the column —
  // is how the two doors would come to answer different questions while still sharing a function.
  const service = read('src/apiserver/src/tasks/task-completion-evidence.service.ts');
  const queue = read('src/apiserver/src/tasks/pending-evidence-judgments.ts');

  // The submission path: the locked task row itself, which already carries `acceptanceCriteria`.
  assert.match(service, /evidenceCriterionMatch\(tx, task, envelope\.criterion\)/);
  // The decision door: the same row, and its SELECT has to actually read the column, or the
  // fallback would see `undefined` and refuse every task in no project exactly as before.
  assert.match(service, /assertCriterionUnmoved\(tx, task, latest\.evidence\)/);
  const decide = service.slice(service.indexOf('  async decide('), service.indexOf('  async list('));
  assert.match(decide, /"acceptance_criteria" AS "acceptanceCriteria"/,
    'the decision door locks the task row without reading the criteria it decides against');
  // The queue read asks the door's own predicate, so it has to select the column too.
  assert.match(queue, /criterionStandingRefusal\(tx, task, latest\.evidence\)/);
  assert.match(queue, /acceptanceCriteria: true,/,
    'the queue asks the standing question about a row that never read the criteria');

  // And nobody kept a copy of the old signature to call with a bare project id.
  for (const source of [service, queue]) {
    assert.doesNotMatch(source, /evidenceCriterionMatch\(tx, task\.projectId/);
    assert.doesNotMatch(source, /criterionStandingRefusal\(tx, task\.projectId/);
    assert.doesNotMatch(source, /assertCriterionUnmoved\(tx, task\.projectId/);
  }
});

test('both locked rows read the declaration the lane is chosen by', () => {
  // The two doors lock the task with raw SQL, whose result type is whatever the call site says it
  // is: a SELECT that never read `criterion_definition_id` or `criterion_revision` would still
  // compile and hand the predicate `undefined`, which is not null — so every task filed under a
  // project would go down the project lane, which is the bug this lane exists to fix. The Prisma
  // selects of the other callers are checked by the compiler; these two only by reading.
  const service = read('src/apiserver/src/tasks/task-completion-evidence.service.ts');
  const submit = service.slice(service.indexOf('  async submit('), service.indexOf('  async importLegacyComment('));
  const decide = service.slice(service.indexOf('  async decide('), service.indexOf('  async list('));
  for (const [door, source] of [['submission', submit], ['decision', decide]] as const) {
    assert.match(source, /"criterion_definition_id" AS "criterionDefinitionId"/,
      `the ${door} door locks the task row without reading the criterion it declares`);
    assert.match(source, /"criterion_revision" AS "criterionRevision"/,
      `the ${door} door locks the task row without reading whether it declared a criterion since deleted`);
  }
});

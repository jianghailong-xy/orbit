import assert from 'node:assert/strict';
import test from 'node:test';
import { AggregationTaskStatus, TaskVerdictValue } from './task-aggregation';
import {
  VerificationSubjectFact,
  VerificationVerdictFact,
  planVerificationVerdicts,
  verificationDefectIdempotencyKey,
  verificationVerdictActionKey,
  verificationVerdictTurnFacts,
} from './task-verification-verdict';

/** Terse fixture spelling, as in `task-aggregation.spec.ts`: single-letter ids, one line each. */
function check(
  id: string,
  options: {
    status?: AggregationTaskStatus;
    verifies?: string | null;
    verdict?: TaskVerdictValue | null;
    revision?: string;
    live?: boolean;
    session?: VerificationVerdictFact['session'];
  } = {},
): VerificationVerdictFact {
  return {
    id,
    status: options.status ?? 'DONE',
    verifiesTaskId: options.verifies === undefined ? 's' : options.verifies,
    verdict: options.verdict === undefined ? 'FAIL' : options.verdict,
    verdictRevision: options.revision ?? '1',
    hasLiveSession: options.live ?? false,
    session: options.session ?? null,
  };
}

function subject(id: string, status: AggregationTaskStatus = 'DONE'): VerificationSubjectFact {
  return { id, status };
}

const SUBJECTS = [subject('s'), subject('t')];

interface Case {
  name: string;
  verifications: VerificationVerdictFact[];
  subjects?: VerificationSubjectFact[];
  /** `id:verdict@revision -> revert,defect,block,raise,resolve,turn` for each planned verdict. */
  expect: string[];
  skipped?: string[];
}

function shape(plan: ReturnType<typeof planVerificationVerdicts>): string[] {
  return plan.verdicts.map((planned) => {
    const on = Object.entries(planned.consequences)
      .filter(([, value]) => value)
      .map(([name]) => name)
      .sort()
      .join(',');
    return `${planned.verifierTaskId}:${planned.verdict}@${planned.verdictRevision} -> ${on || 'none'}`;
  });
}

const CASES: Case[] = [
  // ---- §13.2's table, one row each ------------------------------------------------------------
  {
    name: 'PASS resolves the conditions about its subject and changes nothing else',
    verifications: [check('v', { verdict: 'PASS' })],
    expect: ['v:PASS@1 -> resolveConditions'],
  },
  {
    name: 'FAIL reverts, files a defect, blocks downstream and raises the condition',
    verifications: [check('v', { verdict: 'FAIL' })],
    expect: ['v:FAIL@1 -> blockDownstream,fileDefect,opensCoordinatorTurn,raiseCondition,revertSubject'],
  },
  {
    name: 'INCONCLUSIVE raises the condition and wakes the coordinator — no revert, no defect',
    verifications: [check('v', { verdict: 'INCONCLUSIVE' })],
    expect: ['v:INCONCLUSIVE@1 -> opensCoordinatorTurn,raiseCondition'],
  },

  // ---- V1: the carrier is the verification task's own terminal state --------------------------
  {
    name: 'a task that verifies nothing has no verdict to apply',
    verifications: [check('v', { verifies: null, verdict: null })],
    expect: [],
    skipped: ['v:NOT_A_VERIFICATION'],
  },
  {
    name: 'a verification that has not concluded is not a verdict',
    verifications: [check('v', { verdict: null })],
    expect: [],
    skipped: ['v:NO_VERDICT'],
  },
  {
    name: 'V1: a conclusion on a check that has not finished is not yet a conclusion',
    verifications: [check('v', { status: 'IN_PROGRESS' })],
    expect: [],
    skipped: ['v:NOT_CONCLUDED'],
  },
  {
    name: 'V5: a check whose run is still in flight waits for the run to reach a terminal state',
    verifications: [check('v', { live: true })],
    expect: [],
    skipped: ['v:RUN_IN_FLIGHT'],
  },

  // ---- V6: the subject can be gone ------------------------------------------------------------
  {
    name: 'V6: a verdict about a subject the snapshot no longer holds plans nothing',
    verifications: [check('v', { verifies: 'gone' })],
    expect: [],
    skipped: ['v:SUBJECT_MISSING'],
  },

  // ---- V7: an unrevisioned verdict has no action identity -------------------------------------
  {
    name: 'a verdict written before the revision column existed has no key, so no consequences',
    verifications: [check('v', { revision: '0' })],
    expect: [],
    skipped: ['v:UNREVISIONED_VERDICT'],
  },

  // ---- Several checks at once -----------------------------------------------------------------
  {
    name: 'two checks on one subject each get their own conclusion',
    verifications: [
      check('a', { verdict: 'FAIL', revision: '2' }),
      check('b', { verdict: 'PASS', revision: '7' }),
    ],
    expect: [
      'a:FAIL@2 -> blockDownstream,fileDefect,opensCoordinatorTurn,raiseCondition,revertSubject',
      'b:PASS@7 -> resolveConditions',
    ],
  },
  {
    name: 'checks on different subjects are independent',
    verifications: [
      check('a', { verifies: 's', verdict: 'FAIL' }),
      check('b', { verifies: 't', verdict: 'INCONCLUSIVE' }),
    ],
    expect: [
      'a:FAIL@1 -> blockDownstream,fileDefect,opensCoordinatorTurn,raiseCondition,revertSubject',
      'b:INCONCLUSIVE@1 -> opensCoordinatorTurn,raiseCondition',
    ],
  },
  {
    name: 'a reverted subject does not stop the conclusion about it from being planned again',
    verifications: [check('v', { verdict: 'FAIL', revision: '3' })],
    subjects: [subject('s', 'OPEN')],
    expect: ['v:FAIL@3 -> blockDownstream,fileDefect,opensCoordinatorTurn,raiseCondition,revertSubject'],
  },
];

for (const one of CASES) {
  test(`verification verdict — ${one.name}`, () => {
    const plan = planVerificationVerdicts(one.verifications, one.subjects ?? SUBJECTS);
    assert.deepEqual(shape(plan), one.expect);
    assert.deepEqual(
      plan.skipped.map((skip) => `${skip.verifierTaskId}:${skip.reason}`),
      one.skipped ?? [],
    );
  });
}

test('the plan is a pure function of the snapshot, whatever order it arrives in', () => {
  const facts = [
    check('c', { verdict: 'PASS', revision: '4' }),
    check('a', { verdict: 'FAIL', revision: '2' }),
    check('b', { verdict: 'INCONCLUSIVE', revision: '9' }),
  ];
  const forwards = planVerificationVerdicts(facts, SUBJECTS);
  const backwards = planVerificationVerdicts([...facts].reverse(), SUBJECTS);
  assert.deepEqual(JSON.stringify(forwards), JSON.stringify(backwards));
  assert.deepEqual(forwards.verdicts.map((one) => one.verifierTaskId), ['a', 'b', 'c']);
});

test('the evidence is structured and carries the run by its terminal state, never a turn count', () => {
  const session = {
    id: 'sess',
    runStatus: 'SUCCEEDED',
    finishedAt: '2026-08-20T00:00:00.000Z',
    resultHash: 'a'.repeat(64),
    errorHash: null,
  };
  const [planned] = planVerificationVerdicts([check('v', { session })], SUBJECTS).verdicts;
  assert.deepEqual(planned.evidence, {
    v: 1,
    verifierTaskId: 'v',
    subjectTaskId: 's',
    verdict: 'FAIL',
    verdictRevision: '1',
    verifierStatus: 'DONE',
    subjectStatus: 'DONE',
    session,
  });
  // Nothing in it is free text, and nothing in it counts turns.
  assert.doesNotMatch(JSON.stringify(planned.evidence), /numTurns|turns/i);
});

test('TF4: the turn facts are (verifier, revision, verdict) for the two conclusions that open one', () => {
  const plan = planVerificationVerdicts(
    [
      check('b', { verdict: 'INCONCLUSIVE', revision: '5' }),
      check('a', { verdict: 'FAIL', revision: '2' }),
      check('c', { verdict: 'PASS', revision: '8' }),
    ],
    SUBJECTS,
  );
  assert.deepEqual(verificationVerdictTurnFacts(plan), [
    ['a', '2', 'FAIL'],
    ['b', '5', 'INCONCLUSIVE'],
  ]);
});

test('TF4: the same verdict at a new revision is a different turn fact', () => {
  const first = verificationVerdictTurnFacts(
    planVerificationVerdicts([check('v', { verdict: 'FAIL', revision: '1' })], SUBJECTS),
  );
  const second = verificationVerdictTurnFacts(
    planVerificationVerdicts([check('v', { verdict: 'FAIL', revision: '2' })], SUBJECTS),
  );
  assert.notDeepEqual(first, second);
});

test('V7: the action key is keyed on the revision, not on the verdict', () => {
  assert.equal(
    verificationVerdictActionKey('p', 'v', '3'),
    'pc:v1:p:verdict:v:3',
  );
  // The property the whole revision exists for: the SECOND FAIL is a different key from the first.
  assert.notEqual(
    verificationVerdictActionKey('p', 'v', '1'),
    verificationVerdictActionKey('p', 'v', '2'),
  );
  // And the same conclusion delivered twice is the same key.
  assert.equal(
    verificationVerdictActionKey('p', 'v', '2'),
    verificationVerdictActionKey('p', 'v', 2n),
  );
  assert.equal(verificationDefectIdempotencyKey('p', 'v', '3'), 'pc:v1:p:verdict-defect:v:3');
  // The defect key and the action key never collide, whatever the ids are.
  assert.notEqual(
    verificationVerdictActionKey('p', 'v', '3'),
    verificationDefectIdempotencyKey('p', 'v', '3'),
  );
});

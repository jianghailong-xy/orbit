import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SOURCE_REFUSAL_CODES, SourceRefusalCode } from '@orbit/shared';

import {
  SourceResolutionInput,
  SourceResolutionRefusal,
  classifyPinnedRevision,
  resolveSource,
} from './source-selector';

/**
 * §4's priority table, as behaviour.
 *
 * This unit (`docs/project-source-contract.md` §12.2, S2) owns the PROTOCOL — freeze at create, pin
 * at first claim, refuse an incapable runner — and the resolver is the thing the protocol freezes.
 * So what is asserted here is what the protocol needs to be true of it: that WHERE cannot reach it,
 * that a selector is one shape or the other and never both, and that an ordering the contract wrote
 * down is the ordering the code has.
 *
 * The exhaustive matrix — all five kinds, D1–D4's four both-predicates-true constructions, the
 * negative case per refusal code, the admission gate's full ordering — belongs to the selector unit
 * (`34D2Ag6etI5BbQiXFAMTb`, cases S3.01–S3.08). These are its foundation, not its replacement.
 */

// Resolved against the package root, not `__dirname`: this runs from `build/projects`, and the
// subject of the source-level assertion below is the TypeScript a reviewer reads.
const SRC = path.resolve(__dirname, '../../src');
const SHA = (c: string) => c.repeat(40);

const CODEBASE = {
  id: '00000000-0000-4000-8000-0000000000c1',
  canonicalRepoUrl: 'https://github.com/acme/widgets',
  rootCommitSha: SHA('a'),
  upstreamRef: 'refs/heads/main',
  integrationRef: 'refs/heads/release/next',
  refAuthority: 'REMOTE' as const,
  remoteName: 'origin',
  authorityRunnerId: null,
  configRevision: 7n,
};

function input(overrides: {
  task?: Partial<SourceResolutionInput['task']>;
  codebase?: SourceResolutionInput['codebase'];
  subjectCandidate?: SourceResolutionInput['subjectCandidate'];
  prerequisiteCheckpoints?: SourceResolutionInput['prerequisiteCheckpoints'];
} = {}): SourceResolutionInput {
  return {
    task: {
      id: '00000000-0000-4000-8000-0000000000t1',
      projectId: '00000000-0000-4000-8000-0000000000p1',
      verifiesTaskId: null,
      pinnedRevision: null,
      codeless: false,
      attemptGeneration: 0n,
      inheritedKnownGoodSha: null,
      dependsOnTaskIds: [],
      ...overrides.task,
    },
    codebase: overrides.codebase === undefined ? CODEBASE : overrides.codebase,
    subjectCandidate: overrides.subjectCandidate ?? null,
    prerequisiteCheckpoints: overrides.prerequisiteCheckpoints ?? [],
  };
}

test("P0': no binding and codeless both resolve UNBOUND, and neither refuses", () => {
  // SR5. A project with no code line is not a misconfigured one — its tasks take no Git
  // requirement at all, and a `codeless` task inside a project that HAS one is the escape hatch
  // for the research/documentation work filed alongside the code.
  const unbound = resolveSource(input({ codebase: null }));
  assert.equal(unbound.state, 'UNBOUND');
  assert.equal(unbound.reason.rank, "P0'");

  const optedOut = resolveSource(input({ task: { codeless: true } }));
  assert.equal(optedOut.state, 'UNBOUND');
  assert.equal(optedOut.reason.rank, "P0'");
});

test('P5: an ordinary project code task starts from the upstream ref, not the integration ref', () => {
  const resolved = resolveSource(input());
  assert.equal(resolved.state, 'SELECTED');
  assert.equal(resolved.selector.kind, 'PROJECT_UPSTREAM');
  // Where the line comes FROM, not where it goes TO. The two are different columns precisely
  // because a project can integrate somewhere other than it branches from, and reading the wrong
  // one would start every ordinary task on the release branch.
  assert.equal(resolved.selector.ref, 'refs/heads/main');
  assert.equal(resolved.selector.revisionSha, null);
  assert.deepEqual(resolved.selector.requiredContains, []);
});

test('P4: prerequisites move the baseline to the integration ref and record what it must contain', () => {
  const resolved = resolveSource(
    input({
      task: { dependsOnTaskIds: ['t-a'] },
      prerequisiteCheckpoints: [
        { taskId: 't-a', commitSha: SHA('b'), kind: 'ACCEPTED' },
        // SR25: red work may not become anybody's baseline, so it never enters the closure. The
        // same rule the merge-receipt trigger enforces one table over.
        { taskId: 't-a', commitSha: SHA('c'), kind: 'WIP_RED' },
      ],
    }),
  );
  assert.equal(resolved.state, 'SELECTED');
  assert.equal(resolved.selector.kind, 'DEPENDENCY_CLOSURE');
  assert.equal(resolved.selector.ref, 'refs/heads/release/next');
  assert.deepEqual(resolved.selector.requiredContains, [SHA('b')]);
});

test('P2 beats P3, and P1 beats both (D1–D3, on inputs where both predicates are true)', () => {
  // A pinned task that is ALSO a retry carrying a known-good commit. Both predicates hold; the
  // contract says the pin wins, because what a person wrote down outranks what the machine
  // remembered.
  const pinnedRetry = resolveSource(
    input({
      task: {
        pinnedRevision: SHA('d'),
        attemptGeneration: 3n,
        inheritedKnownGoodSha: SHA('e'),
      },
    }),
  );
  assert.equal(pinnedRetry.reason.rank, 'P2');
  assert.equal(pinnedRetry.state === 'SELECTED' && pinnedRetry.selector.revisionSha, SHA('d'));

  // A verification that is also a retry. P1 wins: re-running a verification must re-check the SAME
  // candidate, or the code that failed last round escapes the re-check by the tip having moved.
  const verificationRetry = resolveSource(
    input({
      task: {
        verifiesTaskId: 't-subject',
        attemptGeneration: 2n,
        inheritedKnownGoodSha: SHA('e'),
      },
      subjectCandidate: { taskId: 't-subject', commitSha: SHA('f') },
    }),
  );
  assert.equal(verificationRetry.reason.rank, 'P1');
  assert.equal(
    verificationRetry.state === 'SELECTED' && verificationRetry.selector.revisionSha,
    SHA('f'),
  );
});

test('SR19: a matched row with no usable input refuses instead of falling to the next row', () => {
  // The whole failure mode this contract exists for is the fall-through: a run that should have
  // stopped gets a baseline that merely looks runnable. A verification with no candidate must not
  // quietly become "start from main and check whatever is there".
  assert.throws(
    () => resolveSource(input({ task: { verifiesTaskId: 't-subject' } })),
    (error: unknown) =>
      error instanceof SourceResolutionRefusal && error.code === 'BASE_SHA_UNAVAILABLE',
  );
});

test('SR15: a pinned revision is a full SHA or a full-name ref; an abbreviation is refused', () => {
  assert.deepEqual(classifyPinnedRevision(SHA('a').toUpperCase()), { kind: 'sha', sha: SHA('a') });
  assert.deepEqual(classifyPinnedRevision('refs/tags/v1'), { kind: 'ref', ref: 'refs/tags/v1' });
  for (const ambiguous of ['a1b2c3d', 'main', 'HEAD', 'origin/main']) {
    assert.throws(
      () => classifyPinnedRevision(ambiguous),
      (error: unknown) =>
        error instanceof SourceResolutionRefusal && error.code === 'CODEBASE_AUTHORITY_INVALID',
      `"${ambiguous}" names a set of commits, not one, and a baseline has to be checkable afterwards`,
    );
  }
});

test('every selector is exactly one of ref-valued or SHA-valued', () => {
  // Migration 0231 states this as a CHECK (`session_source_snapshot_chk`), so a resolver that
  // produced both or neither would not fail here — it would fail at the INSERT, at dispatch time,
  // as a constraint violation with no explanation attached.
  const cases = [
    input(),
    input({ task: { pinnedRevision: 'refs/heads/topic' } }),
    input({ task: { pinnedRevision: SHA('9') } }),
    input({ task: { attemptGeneration: 1n, inheritedKnownGoodSha: SHA('8') } }),
    input({
      task: { dependsOnTaskIds: ['t-a'] },
      prerequisiteCheckpoints: [{ taskId: 't-a', commitSha: SHA('7'), kind: 'ACCEPTED' }],
    }),
  ];
  for (const one of cases) {
    const resolved = resolveSource(one);
    assert.equal(resolved.state, 'SELECTED');
    assert.equal(
      (resolved.selector.ref === null) !== (resolved.selector.revisionSha === null),
      true,
      `${resolved.selector.kind} produced both or neither`,
    );
    // SR18: a baseline that cannot say why it was chosen leaves the UI with nothing to answer
    // "why did this run start here" with.
    assert.match(resolved.reason.rank, /^P[1-5]$/);
    assert.ok(resolved.reason.because.length > 0);
  }
});

test('SR1/SR17: the resolver cannot read WHERE, because its input has nowhere to put it', () => {
  // A source-level assertion on purpose. The type already makes the leak unrepresentable, but a
  // type is erased at runtime and a `(input as any).workspace` would compile — this is what makes
  // "WHERE decides SOURCE" fail as a test rather than as a review comment somebody forgot to make.
  const source = readFileSync(path.join(SRC, 'projects/source-selector.ts'), 'utf8');
  // Comments AND string literals are blanked. Prose may name a workspace — the sentence this
  // resolver hands the UI for a Legacy task says the run starts wherever the workspace already is,
  // and that is the true and useful thing to tell a person. What must not exist is a place the code
  // READS one, so what is scanned is identifiers.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  for (const forbidden of ['workspace', 'workDir', 'defaultMergeTarget', 'assignedRunner', 'HEAD']) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`, 'i').test(code),
      false,
      `the resolver names ${forbidden} — the one input SOURCE may never have is where it runs`,
    );
  }
});

test('the same task resolves identically however many times it is asked', () => {
  // The selector is frozen into one INSERT and never rewritten, so a resolver that depended on
  // anything outside its input would make "what did this session freeze" unanswerable after the
  // fact. Includes ordering: `requiredContains` is a set the database stores as an array.
  const one = input({
    task: { dependsOnTaskIds: ['t-a', 't-b'] },
    prerequisiteCheckpoints: [
      { taskId: 't-b', commitSha: SHA('2'), kind: 'ACCEPTED' },
      { taskId: 't-a', commitSha: SHA('1'), kind: 'ACCEPTED' },
      { taskId: 't-a', commitSha: SHA('1'), kind: 'ACCEPTED' },
    ],
  });
  const first = resolveSource(one);
  const second = resolveSource(one);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.state === 'SELECTED' ? first.selector.requiredContains : null,
    [SHA('1'), SHA('2')],
  );
});

/* -------------------------------------------------------------------------------------------- *
 * Everything below was added by the audit of §4 / §4.2 (task `34IMkgju3LpGIRhaEv3FL`). The tests
 * above are the ones `a9389ea7` landed with; these close the rows and pairs they left open — D1,
 * D4, D5, D6, SR19's second and third negatives, the refusal-code division, `SourceReason` field by
 * field, and the type-level form of SR17 the source-text scan above could only approximate.
 * -------------------------------------------------------------------------------------------- */

/**
 * SR17's closed input set as a VALUE, so the type and the assertion cannot drift apart.
 *
 * `Record<keyof T, true>` refuses to compile the day a field is added to the input and not listed
 * here — but a compile error is satisfied by adding the key, and the point of SR17 is that certain
 * keys must never be addable. `Object.keys` on these witnesses is what turns that into a test that
 * goes RED on the value rather than merely failing to build.
 */
const INPUT_KEYS: Record<keyof SourceResolutionInput, true> = {
  task: true,
  codebase: true,
  subjectCandidate: true,
  prerequisiteCheckpoints: true,
};

const TASK_KEYS: Record<keyof SourceResolutionInput['task'], true> = {
  id: true,
  projectId: true,
  verifiesTaskId: true,
  pinnedRevision: true,
  codeless: true,
  attemptGeneration: true,
  inheritedKnownGoodSha: true,
  dependsOnTaskIds: true,
};

const CODEBASE_KEYS: Record<keyof NonNullable<SourceResolutionInput['codebase']>, true> = {
  id: true,
  canonicalRepoUrl: true,
  rootCommitSha: true,
  upstreamRef: true,
  integrationRef: true,
  refAuthority: true,
  remoteName: true,
  authorityRunnerId: true,
  configRevision: true,
};

/** The two §10.1 codes the PRIORITY TABLE can reach. The other eight belong to §5's gate. */
const SELECTOR_CODES: readonly SourceRefusalCode[] = [
  'BASE_SHA_UNAVAILABLE',
  'CODEBASE_AUTHORITY_INVALID',
];

function selected(resolution: ReturnType<typeof resolveSource>) {
  assert.equal(resolution.state, 'SELECTED');
  if (resolution.state !== 'SELECTED') throw new Error('unreachable');
  return resolution;
}

function refusalFrom(run: () => unknown): SourceResolutionRefusal | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof SourceResolutionRefusal) return error;
    throw error;
  }
}

/**
 * §4.1 top to bottom, one positive per row, each with the `reason` §4.1 obliges it to carry.
 *
 * `because` is checked against the fact that DECIDED the row, not against a fixed string: what has
 * to be true of it is that a person reading it learns why this run starts here, which a message
 * that never mentions the pin, the candidate or the ref cannot do.
 */
const ROWS: readonly {
  row: string;
  kind: string;
  input: SourceResolutionInput;
  ref: string | null;
  revisionSha: string | null;
  requiredContains: string[];
  becauseMentions: RegExp;
}[] = [
  {
    row: 'P1',
    kind: 'VERIFICATION_SUBJECT',
    input: input({
      task: { verifiesTaskId: 't-subject' },
      subjectCandidate: { taskId: 't-subject', commitSha: SHA('f') },
    }),
    ref: null,
    revisionSha: SHA('f'),
    requiredContains: [],
    becauseMentions: /verifies .*checkpoint ffffffff/,
  },
  {
    row: 'P2',
    kind: 'PINNED_REVISION',
    input: input({ task: { pinnedRevision: 'refs/tags/v1.2.3' } }),
    ref: 'refs/tags/v1.2.3',
    revisionSha: null,
    requiredContains: [],
    becauseMentions: /pins its baseline to refs\/tags\/v1\.2\.3/,
  },
  {
    row: 'P3',
    kind: 'TASK_KNOWN_GOOD',
    input: input({ task: { attemptGeneration: 2n, inheritedKnownGoodSha: SHA('e') } }),
    ref: null,
    revisionSha: SHA('e'),
    requiredContains: [],
    becauseMentions: /retry 2 of the same work.*known-good commit eeeeeeee/,
  },
  {
    row: 'P4',
    kind: 'DEPENDENCY_CLOSURE',
    input: input({
      task: { dependsOnTaskIds: ['t-a'] },
      prerequisiteCheckpoints: [{ taskId: 't-a', commitSha: SHA('b'), kind: 'ACCEPTED' }],
    }),
    ref: 'refs/heads/release/next',
    revisionSha: null,
    requiredContains: [SHA('b')],
    becauseMentions: /already be in refs\/heads\/release\/next/,
  },
  {
    row: 'P5',
    kind: 'PROJECT_UPSTREAM',
    input: input(),
    ref: 'refs/heads/main',
    revisionSha: null,
    requiredContains: [],
    becauseMentions: /ordinary task .*starts from refs\/heads\/main/,
  },
];

test('S3.01 §4.1: each of the five rows has a positive case, and produces its own selector', () => {
  for (const expected of ROWS) {
    const resolved = selected(resolveSource(expected.input));
    assert.equal(resolved.reason.rank, expected.row, `${expected.row} did not win its own row`);
    assert.equal(resolved.selector.kind, expected.kind);
    assert.equal(resolved.selector.ref, expected.ref);
    assert.equal(resolved.selector.revisionSha, expected.revisionSha);
    assert.deepEqual(resolved.selector.requiredContains, expected.requiredContains);
    // Criterion 5's other half: the output's `repoUrl` describes the CHOSEN source's repository and
    // is read off the binding — it is not a WHERE field that leaked in through the back door.
    assert.equal(resolved.selector.repoUrl, CODEBASE.canonicalRepoUrl);
    assert.equal(resolved.selector.codebaseId, CODEBASE.id);
    assert.equal(resolved.selector.configRevision, CODEBASE.configRevision);
  }
});

test('SR18: `reason.rank` and `reason.because` are both asserted, per row', () => {
  const sentences = new Map<string, string>();
  for (const expected of [...ROWS]) {
    const { reason } = resolveSource(expected.input);
    assert.equal(reason.rank, expected.row);
    assert.match(
      reason.because,
      expected.becauseMentions,
      `${expected.row}'s sentence does not name the fact that decided it: "${reason.because}"`,
    );
    sentences.set(expected.row, reason.because);
  }
  // P0' has two sentences of its own — no binding and opted out are different answers to "why does
  // this run start where it starts", and a UI that showed the same one for both would be wrong.
  sentences.set("P0'/unbound", resolveSource(input({ codebase: null })).reason.because);
  sentences.set("P0'/codeless", resolveSource(input({ task: { codeless: true } })).reason.because);

  for (const [row, because] of sentences) {
    assert.ok(because.length >= 20, `${row}'s because is too short to be a sentence: "${because}"`);
    assert.ok(because.trim().split(/\s+/).length >= 5, `${row}'s because is not a sentence`);
    assert.doesNotMatch(
      because,
      /TODO|TBD|FIXME|placeholder|lorem|^n\/?a$|^-+$/i,
      `${row}'s because is a placeholder, and this string is shown to a person`,
    );
  }
  // A placeholder's tell is that it is the SAME string everywhere. Seven rows, seven answers.
  assert.equal(new Set(sentences.values()).size, sentences.size, 'two rows share one sentence');
});

test('D1 (SR20): a verification that is ALSO pinned resolves at P1, not at the pin', () => {
  // Both predicates true. SR16 stops new rows from being written this way, but rows written before
  // it exist, and D1 is what gives them a determined answer: allowing the pin to move the baseline
  // is allowing a verification to declare PASS about code that is not the code it was filed against.
  const pinnedVerification = selected(
    resolveSource(
      input({
        task: { verifiesTaskId: 't-subject', pinnedRevision: SHA('d') },
        subjectCandidate: { taskId: 't-subject', commitSha: SHA('f') },
      }),
    ),
  );
  assert.equal(pinnedVerification.reason.rank, 'P1');
  assert.equal(pinnedVerification.selector.kind, 'VERIFICATION_SUBJECT');
  assert.equal(pinnedVerification.selector.revisionSha, SHA('f'));
});

test('D4 (SR20/SR22): a retry that also has prerequisites resolves at P3 and still carries the closure', () => {
  // P3 wins: re-basing onto a moved integration tip throws away the known-good point the previous
  // generation earned. The ordering does NOT buy an exemption from the dependency check — the
  // closure travels with the P3 selector so G5 makes the same demand of a different baseline.
  const retryWithPrerequisites = selected(
    resolveSource(
      input({
        task: {
          attemptGeneration: 4n,
          inheritedKnownGoodSha: SHA('e'),
          dependsOnTaskIds: ['t-a'],
        },
        prerequisiteCheckpoints: [{ taskId: 't-a', commitSha: SHA('b'), kind: 'ACCEPTED' }],
      }),
    ),
  );
  assert.equal(retryWithPrerequisites.reason.rank, 'P3');
  assert.equal(retryWithPrerequisites.selector.kind, 'TASK_KNOWN_GOOD');
  assert.equal(retryWithPrerequisites.selector.revisionSha, SHA('e'));
  assert.deepEqual(retryWithPrerequisites.selector.requiredContains, [SHA('b')]);
});

test('D5: P4 and P5 are structurally exclusive — the same set decides both', () => {
  // §4.2 says this pair needs no ordering because the predicates are complements. That is a claim
  // about the code, so it is asserted rather than trusted: the presence of a code prerequisite is
  // the whole difference between the two rows, with nothing else changed.
  const withPrerequisite = input({
    task: { dependsOnTaskIds: ['t-a'] },
    prerequisiteCheckpoints: [{ taskId: 't-a', commitSha: SHA('b'), kind: 'ACCEPTED' }],
  });
  const withoutPrerequisite = input();
  assert.equal(selected(resolveSource(withPrerequisite)).reason.rank, 'P4');
  assert.equal(selected(resolveSource(withoutPrerequisite)).reason.rank, 'P5');
});

test('D6 / P0: with no binding every other predicate is moot, and nothing is refused', () => {
  // §4.2 D6 says P0 cannot intersect P1–P5 because they all read the codebase. Constructed here at
  // its worst: verification AND pinned AND retried AND with prerequisites, all at once, with no
  // binding. SR5 settles what comes out — an unbound project's task takes no Git requirement and
  // produces NO refusal — and §9's SR45 says the same thing from the Legacy side.
  const everythingAtOnce = resolveSource(
    input({
      codebase: null,
      task: {
        verifiesTaskId: 't-subject',
        pinnedRevision: 'not-a-ref-and-not-a-sha',
        attemptGeneration: 9n,
        inheritedKnownGoodSha: 'also-not-a-sha',
        dependsOnTaskIds: ['t-a'],
      },
      subjectCandidate: { taskId: 't-subject', commitSha: SHA('f') },
      prerequisiteCheckpoints: [{ taskId: 't-a', commitSha: SHA('c'), kind: 'WIP_RED' }],
    }),
  );
  assert.equal(everythingAtOnce.state, 'UNBOUND');
  assert.equal(everythingAtOnce.reason.rank, "P0'");
});

test('SR19: all three of §4.1\'s unusable-input rows refuse rather than fall to the next row', () => {
  // §11 asks for three negatives here. P1's was the one `a9389ea7` shipped; P3's and P4's are new,
  // and P4's is the one that was WRONG — a task whose prerequisite had produced nothing accepted
  // fell through to P5 and started from the upstream tip with an EMPTY containment requirement.
  // Neither the prerequisite's work nor a demand for it would have been anywhere in the run.
  const p1 = refusalFrom(() => resolveSource(input({ task: { verifiesTaskId: 't-subject' } })));
  assert.equal(p1?.code, 'BASE_SHA_UNAVAILABLE');
  assert.equal(p1?.detail.sourceKind, 'VERIFICATION_SUBJECT');

  const p3 = refusalFrom(() =>
    resolveSource(input({ task: { attemptGeneration: 1n, inheritedKnownGoodSha: 'a1b2c3d' } })),
  );
  assert.equal(p3?.code, 'BASE_SHA_UNAVAILABLE');
  assert.equal(p3?.detail.sourceKind, 'TASK_KNOWN_GOOD');

  const p4 = refusalFrom(() =>
    resolveSource(
      input({
        task: { dependsOnTaskIds: ['t-a'] },
        prerequisiteCheckpoints: [{ taskId: 't-a', commitSha: SHA('c'), kind: 'WIP_RED' }],
      }),
    ),
  );
  assert.equal(p4?.code, 'BASE_SHA_UNAVAILABLE');
  assert.equal(p4?.detail.sourceKind, 'DEPENDENCY_CLOSURE');
  assert.deepEqual(p4?.detail.prerequisiteTaskIds, ['t-a']);

  // And the same shape one prerequisite wider: a task with two code prerequisites of which only one
  // delivered must not ship a closure that is short by the other one.
  const halfLanded = refusalFrom(() =>
    resolveSource(
      input({
        task: { dependsOnTaskIds: ['t-a', 't-b'] },
        prerequisiteCheckpoints: [
          { taskId: 't-a', commitSha: SHA('b'), kind: 'ACCEPTED' },
          { taskId: 't-b', commitSha: SHA('c'), kind: 'WIP_RED' },
        ],
      }),
    ),
  );
  assert.equal(halfLanded?.code, 'BASE_SHA_UNAVAILABLE');
  assert.deepEqual(halfLanded?.detail.prerequisiteTaskIds, ['t-b']);
});

test('SR27: a prerequisite with no checkpoints of its own makes no Git requirement', () => {
  // The positive side of the refusal above, and the line between them. A `codeless` prerequisite —
  // a piece of writing, a decision — reaches the resolver as a task id with no checkpoint rows,
  // because the caller that gathers those rows is where SR27's exclusion is applied. It must leave
  // this task at P5, not refuse it and not invent a containment requirement for a commit that was
  // never going to exist.
  const documentationPrerequisite = selected(
    resolveSource(input({ task: { dependsOnTaskIds: ['t-doc'] }, prerequisiteCheckpoints: [] })),
  );
  assert.equal(documentationPrerequisite.reason.rank, 'P5');
  assert.equal(documentationPrerequisite.selector.kind, 'PROJECT_UPSTREAM');
  assert.deepEqual(documentationPrerequisite.selector.requiredContains, []);
});

test('§10.1 division: the priority table reaches two codes, and names none of the gate\'s eight', () => {
  // §4 decides WHICH selector; §5's G0–G6 decide whether it may be used, on the runner, which is
  // the machine that has the repository. So the eight gate codes are not this file's to produce,
  // and the assertion is that it cannot produce them by accident: every refusal reachable from the
  // priority table is one of two, and the other eight are not so much as spelled here.
  const everyRefusal = [
    () => resolveSource(input({ task: { verifiesTaskId: 't-subject' } })),
    () => resolveSource(input({ task: { attemptGeneration: 1n, inheritedKnownGoodSha: 'nope' } })),
    () =>
      resolveSource(
        input({
          task: { dependsOnTaskIds: ['t-a'] },
          prerequisiteCheckpoints: [{ taskId: 't-a', commitSha: SHA('c'), kind: 'WIP_RED' }],
        }),
      ),
    () => resolveSource(input({ task: { pinnedRevision: 'main' } })),
    () => classifyPinnedRevision('origin/main'),
  ];
  const raised = new Set<SourceRefusalCode>();
  for (const one of everyRefusal) {
    const refusal = refusalFrom(one);
    assert.ok(refusal, 'an input built to be refused resolved instead');
    raised.add(refusal.code);
  }
  assert.deepEqual([...raised].sort(), [...SELECTOR_CODES].sort());

  const source = readFileSync(path.join(SRC, 'projects/source-selector.ts'), 'utf8');
  for (const code of SOURCE_REFUSAL_CODES) {
    if (SELECTOR_CODES.includes(code)) continue;
    assert.equal(
      source.includes(code),
      false,
      `${code} is a §5 admission-gate code — the resolver naming it means the two halves have been mixed back together`,
    );
  }
});

test('§10.1 division: both of the resolver\'s codes have a positive side too', () => {
  // A code with only a refusing case proves the refusal fires, not that it fires on the right
  // input. Each of these is one field away from the negative above and must resolve cleanly.
  const candidatePresent = selected(
    resolveSource(
      input({
        task: { verifiesTaskId: 't-subject' },
        subjectCandidate: { taskId: 't-subject', commitSha: SHA('f') },
      }),
    ),
  );
  assert.equal(candidatePresent.selector.revisionSha, SHA('f'));

  const knownGoodUsable = selected(
    resolveSource(input({ task: { attemptGeneration: 1n, inheritedKnownGoodSha: SHA('8') } })),
  );
  assert.equal(knownGoodUsable.selector.revisionSha, SHA('8'));

  const prerequisiteDelivered = selected(
    resolveSource(
      input({
        task: { dependsOnTaskIds: ['t-a'] },
        prerequisiteCheckpoints: [{ taskId: 't-a', commitSha: SHA('b'), kind: 'ACCEPTED' }],
      }),
    ),
  );
  assert.deepEqual(prerequisiteDelivered.selector.requiredContains, [SHA('b')]);

  // CODEBASE_AUTHORITY_INVALID's positive side: the two spellings SR15 does accept.
  assert.deepEqual(classifyPinnedRevision(SHA('a')), { kind: 'sha', sha: SHA('a') });
  assert.deepEqual(classifyPinnedRevision('refs/heads/main'), {
    kind: 'ref',
    ref: 'refs/heads/main',
  });
});

test('SR1/SR17: the input type is the contract\'s closed set, field for field', () => {
  // The source-text scan further up catches a resolver that READS a workspace. This catches the
  // step before it — a workspace being addable to the input at all — and it catches it as a failed
  // assertion on a list of names, which a type-only check could not do.
  assert.deepEqual(Object.keys(INPUT_KEYS).sort(), [
    'codebase',
    'prerequisiteCheckpoints',
    'subjectCandidate',
    'task',
  ]);
  assert.deepEqual(Object.keys(TASK_KEYS).sort(), [
    'attemptGeneration',
    'codeless',
    'dependsOnTaskIds',
    'id',
    'inheritedKnownGoodSha',
    'pinnedRevision',
    'projectId',
    'verifiesTaskId',
  ]);

  const everyInputField = [
    ...Object.keys(INPUT_KEYS),
    ...Object.keys(TASK_KEYS),
    ...Object.keys(CODEBASE_KEYS),
  ];
  // Matched exactly, not by substring, and that is the point: `canonicalRepoUrl` is the identity of
  // the repository the binding names and `authorityRunnerId` is where a ref resolution COUNTS
  // (§2 — "not which machine runs it"). Neither is a place to put where this run happens, which is
  // what the five names below are.
  for (const forbidden of [
    'workspace',
    'workDir',
    'defaultMergeTarget',
    'runnerId',
    'assignedRunnerId',
    'repoUrl',
  ]) {
    assert.equal(
      everyInputField.includes(forbidden),
      false,
      `${forbidden} became an input to SOURCE resolution — WHERE a run happens may not decide WHICH code it starts from`,
    );
  }
});

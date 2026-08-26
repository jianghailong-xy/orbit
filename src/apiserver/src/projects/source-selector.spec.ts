import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

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
  // Migration 0175 states this as a CHECK (`session_source_snapshot_chk`), so a resolver that
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

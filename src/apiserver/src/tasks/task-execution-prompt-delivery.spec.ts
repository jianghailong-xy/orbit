import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTaskExecutionPrompt } from './task-execution-prompt';

/**
 * Contract §10.5 O-L3: a task's brief tells its run how the project's work reaches the line, in the
 * contract's own words — one sentence for AGENT_PUSH, another for PLATFORM once the project has
 * started integrating — and says nothing where neither holds, leaving the brief byte for byte what
 * it was before the setting existed.
 *
 * Every brief is built through `brief`, whose cast lets this file compile against a builder that
 * does not read the project yet: there each case fails on the sentence it names.
 */

const STARTED = new Date('2026-10-28T15:53:49.865Z');

function binding(overrides: Partial<{
  deliveryMode: string;
  integrationStartedAt: Date | null;
  integrationRef: string;
  remoteName: string;
}> = {}) {
  return {
    deliveryMode: 'PLATFORM',
    integrationStartedAt: STARTED,
    integrationRef: 'refs/heads/main',
    remoteName: 'origin',
    ...overrides,
  };
}

const TASK = {
  title: 'Fold the release notes into the changelog',
  description: 'Move every entry under its version heading.',
  acceptanceCriteria: 'The changelog lists every release.',
  completionCriterion: 'EVIDENCE_JUDGMENT' as const,
  isForeman: false,
  verifiesTaskId: null,
  list: null,
};

const brief = (task: object): string =>
  buildTaskExecutionPrompt(task as Parameters<typeof buildTaskExecutionPrompt>[0]);

/** The sentence as its own paragraph, right before the steps — where the brief puts it. */
const said = (sentence: string) => `\n\n${sentence}\n\nFollow these steps:\n`;

const BARE = brief(TASK);

test('O-L3: an AGENT_PUSH project tells the run to push to the upstream, in the contract\'s words', () => {
  const pushing = brief({
    ...TASK,
    project: { codebases: [binding({ deliveryMode: 'AGENT_PUSH', integrationRef: 'refs/heads/feature/v1.1.1' })] },
  });
  assert.ok(pushing.includes(said('This project delivers by pushing to feature/v1.1.1. Push your commits to '
    + 'origin/feature/v1.1.1 before you finish — Orbit checks that they are there.')), pushing);
  assert.equal(pushing.replace(said('This project delivers by pushing to feature/v1.1.1. Push your commits to '
    + 'origin/feature/v1.1.1 before you finish — Orbit checks that they are there.'), '\n\nFollow these steps:\n'),
  BARE, 'the sentence is the only thing it adds');

  // Before the line has started too: the agents push from the first task on.
  const unstarted = brief({
    ...TASK,
    project: { codebases: [binding({ deliveryMode: 'AGENT_PUSH', integrationStartedAt: null })] },
  });
  assert.ok(unstarted.includes(said('This project delivers by pushing to main. Push your commits to origin/main '
    + 'before you finish — Orbit checks that they are there.')), unstarted);

  // The remote is the binding's, not a guess.
  const remote = brief({
    ...TASK,
    project: { codebases: [binding({ deliveryMode: 'AGENT_PUSH', remoteName: 'upstream' })] },
  });
  assert.ok(remote.includes(said('This project delivers by pushing to main. Push your commits to upstream/main '
    + 'before you finish — Orbit checks that they are there.')), remote);
});

test('O-L3: a PLATFORM project that has started integrating tells the run not to push', () => {
  const platform = brief({ ...TASK, project: { codebases: [binding()] } });
  assert.ok(platform.includes(said('Do not push to main. Orbit lands your branch after your work is accepted.')),
    platform);
  assert.equal(platform.replace(said('Do not push to main. Orbit lands your branch after your work is accepted.'),
    '\n\nFollow these steps:\n'), BARE, 'the sentence is the only thing it adds');

  // The line's branch, which on a project branch is the branch Orbit lands on.
  const branched = brief({
    ...TASK,
    project: { codebases: [binding({ integrationRef: 'refs/heads/project/34noHniU4wmCRkZJkR6df' })] },
  });
  assert.ok(branched.includes(said('Do not push to project/34noHniU4wmCRkZJkR6df. Orbit lands your branch after '
    + 'your work is accepted.')), branched);
});

test('O-L3: no sentence, and the brief as it was, where neither mode has anything to say', () => {
  const unsaid: Array<[string, object]> = [
    ['no project', { ...TASK, project: null }],
    ['a project with no binding', { ...TASK, project: { codebases: [] } }],
    ['PLATFORM before integration starts', { ...TASK, project: { codebases: [binding({ integrationStartedAt: null })] } }],
    ['a codeless task', { ...TASK, codeless: true, project: { codebases: [binding({ deliveryMode: 'AGENT_PUSH' })] } }],
    ['a foreman', { ...TASK, isForeman: true, project: { codebases: [binding({ deliveryMode: 'AGENT_PUSH' })] } }],
    ['a verifier', { ...TASK, verifiesTaskId: 'b6c1d6c0-0000-7000-8000-000000000001', project: { codebases: [binding()] } }],
  ];
  for (const [label, task] of unsaid) {
    assert.equal(brief(task), BARE, label);
  }
  // The twins that do speak, so the cases above cannot pass merely because nothing ever does.
  assert.notEqual(brief({ ...TASK, project: { codebases: [binding()] } }), BARE);
  assert.notEqual(brief({ ...TASK, project: { codebases: [binding({ deliveryMode: 'AGENT_PUSH' })] } }), BARE);
});

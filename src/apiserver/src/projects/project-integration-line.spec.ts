import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import { integrationJobLimitSeconds } from './project-integration-job';
import {
  canonicalRepoUrl,
  lastLandingCheck,
  projectBranchRef,
  projectBranchSlug,
  projectDefaultLine,
  repositoryShortName,
} from './project-integration-line';

/** Whether git itself takes the name as a ref: `git check-ref-format` exits 0 for a valid one. */
function gitAcceptsRef(ref: string): boolean {
  try {
    execFileSync('git', ['check-ref-format', ref], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const PROJECT_ID = '019ab7c2-5f3e-7d41-9c6a-2b8e4f1d0a37';
const SHORT_ID = uuidToBase62(PROJECT_ID).slice(0, 8);

test('a project branch is named after its title and the first 8 characters of its public id', () => {
  assert.equal(SHORT_ID.length, 8);
  assert.equal(projectBranchRef(PROJECT_ID, 'Readable project branch names'),
    `refs/heads/project/readable-project-branch-names-${SHORT_ID}`);
  // Every other run of characters is one dash, and none is left at either end.
  assert.equal(projectBranchRef(PROJECT_ID, '  Fix: login redirect (v2.1)!! '),
    `refs/heads/project/fix-login-redirect-v2-1-${SHORT_ID}`);
  // ASCII letters and digits survive a mixed title; the rest of it does not.
  assert.equal(projectBranchRef(PROJECT_ID, 'Orbit Files 文档 rename'),
    `refs/heads/project/orbit-files-rename-${SHORT_ID}`);
});

test('an accented letter keeps its base letter in the branch name', () => {
  assert.equal(projectBranchSlug('Ünïcödé Café v2'), 'unicode-cafe-v2');
  assert.equal(projectBranchSlug('Crème brûlée façade'), 'creme-brulee-facade');
  assert.equal(projectBranchSlug('Ｆｕｌｌｗｉｄｔｈ ①'), 'fullwidth-1');
  // Latin letters Unicode does not decompose are spelled out.
  assert.equal(projectBranchSlug('Straße Ørsted Łódź Æsir'), 'strasse-orsted-lodz-aesir');
  assert.equal(projectBranchRef(PROJECT_ID, 'Café'), `refs/heads/project/cafe-${SHORT_ID}`);
});

test('a title with no ASCII letter or digit names the branch by the short id alone', () => {
  for (const title of ['项目分支命名优化', '?!… — ...', '', '   ', '..', '@{', '/']) {
    assert.equal(projectBranchRef(PROJECT_ID, title), `refs/heads/project/${SHORT_ID}`, title);
  }
  assert.equal(projectBranchSlug('项目分支命名优化'), '');
});

test('a long title is capped at 40 characters, on a word boundary', () => {
  const long = 'Make the project branch names readable in git, on GitHub pull requests and in the CLI';
  const slug = projectBranchSlug(long);
  assert.equal(slug, 'make-the-project-branch-names-readable');
  assert.ok(slug.length <= 40);
  assert.equal(projectBranchRef(PROJECT_ID, long), `refs/heads/project/${slug}-${SHORT_ID}`);
  // The boundary at exactly the cap keeps the whole word before it.
  assert.equal(projectBranchSlug(`${'a'.repeat(19)} ${'b'.repeat(20)} tail`), `${'a'.repeat(19)}-${'b'.repeat(20)}`);
  // One word longer than the cap has no boundary to cut at, so it is cut inside.
  assert.equal(projectBranchSlug('x'.repeat(60)), 'x'.repeat(40));
  assert.equal(projectBranchSlug(`${'y'.repeat(45)} more`), 'y'.repeat(40));
});

test('every project branch name is a ref git accepts', () => {
  const titles = [
    'Readable project branch names', '项目分支命名优化', '?!…', '', 'a..b', 'x.lock', 'branch.lock',
    'refs/heads/main', '@{upstream}', 'back\\slash', 'tab\tand\nnewline', '-leading dash', 'trailing dash-',
    '~^:?*[', 'Ünïcödé títlé', 'x'.repeat(200), `${'word '.repeat(30)}`, '/a//b/', '.hidden', 'HEAD',
  ];
  const ids = [PROJECT_ID, '00000000-0000-0000-0000-000000000001', 'ffffffff-ffff-ffff-ffff-ffffffffffff'];
  for (const id of ids) {
    for (const title of titles) {
      const ref = projectBranchRef(id, title);
      assert.match(ref, /^refs\/heads\/project\/([a-z0-9]+(-[a-z0-9]+)*-)?[0-9A-Za-z]{1,8}$/u, title);
      assert.ok(gitAcceptsRef(ref), `git check-ref-format refuses ${ref}`);
    }
  }
  // CONTROL: the check does refuse what git refuses.
  assert.equal(gitAcceptsRef('refs/heads/project/a..b'), false);
  assert.equal(gitAcceptsRef('refs/heads/project/x.lock'), false);
});

test('landing checks require actual complete check results to pass', () => {
  for (const checks of [undefined, null, [], {}, [null], [{}], [{ exitCode: 0 }]]) {
    assert.equal(lastLandingCheck(checks), 'UNKNOWN');
  }
  assert.equal(lastLandingCheck([{ expectedExitCode: 0, exitCode: 0, timedOut: false }]), 'PASSING');
  assert.equal(lastLandingCheck([{ expectedExitCode: 2, exitCode: 2, timedOut: false }]), 'PASSING');
});

test('a failed or timed out check is failing, even if another result is missing', () => {
  assert.equal(lastLandingCheck([
    { expectedExitCode: 0, exitCode: 0, timedOut: false },
    { expectedExitCode: 0, exitCode: 1, timedOut: false },
  ]), 'FAILING');
  assert.equal(lastLandingCheck([{}, { expectedExitCode: 0, exitCode: null, timedOut: true }]), 'FAILING');
  assert.equal(lastLandingCheck([{ expectedExitCode: 0, exitCode: null, timedOut: false }]), 'UNKNOWN');
});

test('a running job may stay silent for the lease, or for its check budgets plus the lease while checking', () => {
  const landing = {
    kind: 'LAND_TASK', promotionSourceKind: null, skipMergeCheck: false,
    acceptanceCommand: 'npm test -w web', acceptanceExpectedExitCode: 0, acceptanceTimeoutSeconds: 300,
    mergeCheckCommand: 'npm run build', mergeCheckTimeoutSeconds: null,
  };
  for (const phase of [null, 'FETCH', 'MAIN_SYNC', 'REBASE', 'MERGE', 'PUSH', 'VERIFY']) {
    assert.equal(integrationJobLimitSeconds({ ...landing, state: 'RUNNING', phase }), 600, String(phase));
  }
  // Task acceptance (300), two landing-check budgets (combined and baseline), then the lease.
  assert.equal(integrationJobLimitSeconds({ ...landing, state: 'RUNNING', phase: 'CHECK' }), 300 + 2 * 3600 + 600);
  // A generation whose merge check was approved away runs the acceptance alone.
  assert.equal(integrationJobLimitSeconds({ ...landing, skipMergeCheck: true, state: 'RUNNING', phase: 'CHECK' }),
    300 + 600);
  // A project-branch promotion runs the merge check and nothing else.
  assert.equal(integrationJobLimitSeconds({
    ...landing, kind: 'LAND_PROMOTION', promotionSourceKind: 'PROJECT_BRANCH', mergeCheckTimeoutSeconds: 900,
    state: 'RUNNING', phase: 'CHECK',
  }), 900 + 600);
  assert.equal(integrationJobLimitSeconds({ ...landing, state: 'QUEUED', phase: null }), null);
  // A v2 claim reports every 30 seconds whatever it is doing, so the lease bounds every phase —
  // checking included (§2.2 J-T4).
  for (const phase of [null, 'FETCH', 'CHECK', 'PUSH'] as const) {
    assert.equal(
      integrationJobLimitSeconds({ ...landing, progressProtocol: 'v2', state: 'RUNNING', phase }),
      600, `v2 ${phase}`,
    );
  }
});

test('project default line checks dependency endpoints by project without large ID lists', async () => {
  let query: unknown;
  const db = {
    taskDependency: {
      findFirst: async (args: unknown) => {
        query = args;
        return { id: 'edge-1' };
      },
    },
  } as unknown as Parameters<typeof projectDefaultLine>[0];

  assert.equal(await projectDefaultLine(db, 'project-1'), 'PROJECT_BRANCH');
  assert.deepEqual(query, {
    where: {
      task: { projectId: 'project-1', status: { not: 'CANCELLED' } },
      dependsOnTask: { projectId: 'project-1', status: { not: 'CANCELLED' } },
    },
    select: { id: true },
  });
});

test('project default line stays on main when no in-scope dependency exists', async () => {
  const db = {
    taskDependency: { findFirst: async () => null },
  } as unknown as Parameters<typeof projectDefaultLine>[0];

  assert.equal(await projectDefaultLine(db, 'project-1'), 'MAIN');
});

test('a repository is shown by the last two segments of its canonical URL', () => {
  for (const [remote, shown] of [
    ['git@github.com:acme/payments-api.git', 'acme/payments-api'],
    ['https://GitHub.com/Acme/Payments-API.git/', 'Acme/Payments-API'],
    ['ssh://git@gitlab.example.com:2222/group/sub/repo', 'sub/repo'],
    ['https://example.com/repo', 'example.com/repo'],
  ] as const) {
    assert.equal(repositoryShortName(canonicalRepoUrl(remote)!), shown, remote);
  }
});

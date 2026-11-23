import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { isOrbitOwnedRef, landingRefFor } from '@orbit/shared';
import type { GithubPullRequestReading } from './github-api.client';
import { grantsPullRequestLanding, pullRequestPermissionsPending } from './github-installation-grants';
import { deliveryAbout, githubSignatureValid } from './github-webhook';
import { decidePullRequest, mergeMethodFor, mergeMethodRefused, mergeRefusedForMovedBase } from './pull-request-door';
import { failureLinesIn, landingFixMessage } from '../projects/landing-fix-turn';
import { isOrbitAuthoredTurn } from '../sessions/orbit-authored-turn';
import { pullRequestFixMessage, pullRequestFixTurnId } from '../sessions/pull-request-fix-turn';
import { assertClientTurnIdNotReserved } from '../sessions/watch-turn-key';
import {
  githubCheckResult,
  githubFailureLines,
  landingCommandFields,
  landingModeOf,
  pullRequestBlockingCode,
  pullRequestViewOf,
  pullRequestWaitSummary,
  storedRefusal,
  type LandingModeFacts,
} from '../projects/pull-request-landing';

// docs/design/protected-branch-landing.md §3, §4.3, §4.4, §4.7 and §10: the rules the pull request door and the
// hand-out decide with, as pure functions. The pg spec (pull-request-landing.pg.spec.ts) holds the rows they write.

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function reading(over: Partial<GithubPullRequestReading> = {}): GithubPullRequestReading {
  return {
    number: 214, url: 'https://github.com/o/r/pull/214', state: 'OPEN', merged: false, mergedBy: null,
    mergeCommitSha: null, mergeCommitTreeSha: null, headSha: HEAD, baseRef: 'main', baseSha: BASE,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, inMergeQueue: false, mergeQueueEnabled: false,
    closedBy: null, checks: [], allowed: { merge: true, rebase: true, squash: true },
    ...over,
  };
}
const row = { headSha: HEAD, baseSha: BASE };
const check = (name: string, required: boolean, state: 'PASSED' | 'FAILED' | 'PENDING') =>
  ({ name, required, state, url: null, conclusion: null, actionsJobId: null, summary: null });

test('§4.3: what one read decides, in the table\'s order', () => {
  const decide = (over: Partial<GithubPullRequestReading>, facts = row) => {
    const verdict = decidePullRequest(facts, reading(over));
    return `${verdict.decision.kind}${verdict.condition ? `/${verdict.condition}` : ''}`;
  };
  assert.equal(decide({ merged: true, state: 'MERGED' }), 'MERGED');
  assert.equal(decide({ state: 'CLOSED' }), 'CLOSED');
  assert.equal(decide({ headSha: 'c'.repeat(40) }), 'HEAD_CHANGED', 'Orbit merges only the commit it pushed');
  assert.equal(decide({ checks: [check('ci', true, 'FAILED'), check('ci2', true, 'PENDING')] }), 'CHECK_FAILED/CHECK_FAILED', 'J-T16');
  const failed = decidePullRequest(row, reading({ checks: [check('ci', true, 'FAILED'), check('lint', false, 'FAILED'), check('pg', true, 'FAILED')] })).decision;
  assert.deepEqual(failed.kind === 'CHECK_FAILED' ? failed.failed.map((one) => one.name) : null, ['ci', 'pg'], 'only the required ones');
  assert.equal(decide({ checks: [check('labeler', false, 'FAILED')] }), 'MERGE/MERGEABLE', 'a check GitHub does not require does not hold the merge');
  assert.equal(decide({ mergeQueueEnabled: true }), 'WAIT/MERGE_QUEUE');
  assert.equal(decide({ mergeStateStatus: 'BEHIND' }), 'TARGET_MOVED/BEHIND', 'J-T17 as soon as GitHub says behind');
  assert.equal(decide({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), 'TARGET_MOVED/CONFLICTING');
  assert.equal(decide({ mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' }), 'WAIT/CHANGES_REQUESTED');
  assert.equal(decide({ mergeStateStatus: 'BLOCKED', checks: [check('ci', true, 'PENDING')], reviewDecision: 'REVIEW_REQUIRED' }), 'WAIT/CHECKS_PENDING');
  assert.equal(decide({ mergeStateStatus: 'BLOCKED', checks: [check('ci', true, 'PASSED')], reviewDecision: 'REVIEW_REQUIRED' }), 'WAIT/REVIEW_REQUIRED');
  assert.equal(decide({ mergeStateStatus: 'BLOCKED' }), 'WAIT/CHECKS_PENDING', 'blocked on a required check that has not reported yet');
  assert.equal(decide({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }), 'WAIT/UNKNOWN');
  for (const status of ['CLEAN', 'UNSTABLE', 'HAS_HOOKS']) {
    assert.equal(decide({ mergeStateStatus: status }), 'MERGE/MERGEABLE', status);
  }
  assert.equal(decide({ baseSha: 'd'.repeat(40) }), 'TARGET_MOVED/BEHIND', 'mergeable onto a base that moved is not merged (J-T17)');
  assert.equal(decide({ baseSha: 'd'.repeat(40), mergeStateStatus: 'BLOCKED', checks: [check('ci', true, 'PASSED')], reviewDecision: 'REVIEW_REQUIRED' }),
    'WAIT/REVIEW_REQUIRED', 'a pull request waiting for a review is not rebuilt each time main moves (§4.5)');
});

test('§4.4: the merge method that gives what a direct push would have, then the next one allowed', () => {
  const all = { merge: true, rebase: true, squash: true };
  assert.equal(mergeMethodFor('PROJECT_BRANCH', all), 'merge');
  assert.equal(mergeMethodFor('TASK', all), 'rebase');
  assert.equal(mergeMethodFor('SESSION', all), 'rebase');
  assert.equal(mergeMethodFor('PROJECT_BRANCH', { merge: false, rebase: true, squash: true }), 'rebase');
  assert.equal(mergeMethodFor('TASK', { merge: true, rebase: false, squash: true }), 'merge');
  assert.equal(mergeMethodFor('TASK', all, new Set(['rebase', 'merge'])), 'squash');
  assert.equal(mergeMethodFor('TASK', { merge: false, rebase: false, squash: false }), null);
  assert.equal(mergeMethodRefused('Rebase merges are not allowed on this repository.'), true);
  assert.equal(mergeMethodRefused('Merge commits are not allowed on this branch.'), true);
  assert.equal(mergeMethodRefused('Pull Request is not mergeable'), false, 'not yet, rather than never');
  assert.equal(mergeMethodRefused(null), false);
  assert.equal(mergeRefusedForMovedBase('Base branch was modified. Review and try the merge again.'), true, 'J-T17, counted');
  assert.equal(mergeRefusedForMovedBase('Pull Request is not mergeable'), false);
});

test('§4.5: a failed GitHub check as the job keeps it — the log\'s failure lines, redacted, under the runner\'s heading', () => {
  const log = [
    '2026-11-23T10:00:00.0000000Z ##[group]Run npm test',
    '2026-11-23T10:00:01.0000000Z Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    '2026-11-23T10:00:02.0000000Z ##[error]expected 2, got 3',
  ].join('\n');
  const result = githubCheckResult({
    name: 'PostgreSQL specs', url: 'https://github.com/o/r/actions/runs/1/job/2', conclusion: 'failure', log, summary: null,
    pullRequest: { number: 214, url: 'https://github.com/o/r/pull/214' }, headSha: HEAD,
  });
  assert.equal(result.name, 'GITHUB_CHECK');
  assert.equal(result.command, 'PostgreSQL specs');
  assert.notEqual(result.exitCode, result.expectedExitCode, 'it reads as the check that failed');
  assert.deepEqual(failureLinesIn(result.outputTail), ['expected 2, got 3']);
  assert.doesNotMatch(result.outputTail, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.deepEqual(result.github, {
    conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/1/job/2',
    pullRequest: { number: 214, url: 'https://github.com/o/r/pull/214' }, headSha: HEAD,
  });
  // Without an Actions log: what the check said about itself.
  const status = githubCheckResult({
    name: 'ci/external', url: 'https://ci.example/1', conclusion: 'error', log: null, summary: 'Build #9 failed: 2 tests',
    pullRequest: { number: 214, url: 'https://github.com/o/r/pull/214' }, headSha: HEAD,
  });
  assert.deepEqual(failureLinesIn(status.outputTail), ['Build #9 failed: 2 tests']);
  // Without either, no failure section.
  assert.equal(failureLinesIn(githubCheckResult({
    name: 'x', url: null, conclusion: null, log: null, summary: null, pullRequest: { number: 1, url: 'u' }, headSha: HEAD,
  }).outputTail), null);
  // With no ##[error] line, the lines that say they failed.
  assert.deepEqual(githubFailureLines('ok 1\nnot ok 2 - it FAILED\nsome error here\nfine'), ['not ok 2 - it FAILED', 'some error here']);
});

test('§4.5 / §4.6: the fix turns name the pull request, the check and the log', () => {
  const tail = githubCheckResult({
    name: 'PostgreSQL specs', url: 'https://github.com/o/r/actions/runs/1/job/2', conclusion: 'failure',
    log: '##[error]expected 2, got 3', summary: null, pullRequest: { number: 214, url: 'https://github.com/o/r/pull/214' }, headSha: HEAD,
  });
  const session = pullRequestFixMessage({
    title: 'Tidy the settings page', targetBranch: 'main', pullRequest: { number: 214, url: 'https://github.com/o/r/pull/214' },
    headSha: HEAD, checks: [tail], round: 1, rounds: 2,
  });
  assert.match(session, /^Orbit could not merge "Tidy the settings page" into main\./);
  assert.match(session, /The required check "PostgreSQL specs" failed on pull request #214 \(aaaaaaa\):\nexpected 2, got 3\nFull log: https:\/\/github\.com\/o\/r\/actions\/runs\/1\/job\/2/);
  assert.match(session, /main is unchanged, and pull request #214 stays open/);
  assert.match(session, /This is fix round 1 of 2\.$/);
  assert.equal(pullRequestFixTurnId('p', HEAD), `pull-request-fix:v1:p:${HEAD}`);
  assert.ok(isOrbitAuthoredTurn(pullRequestFixTurnId('p', HEAD)), 'the platform\'s own turn');
  assert.throws(() => assertClientTurnIdNotReserved(pullRequestFixTurnId('p', HEAD)), 'no caller may take its key');
  const task = landingFixMessage({
    taskTitle: 'Add the landing timeline', state: 'CHECK_FAILED', phase: 'PUSH', targetBranch: 'main', upstreamBranch: 'main',
    targetSha: BASE, upstreamSha: BASE, conflicts: [],
    check: { name: 'GITHUB_CHECK', command: 'PostgreSQL specs', exitCode: 1, url: 'https://github.com/o/r/actions/runs/1/job/2' },
    pullRequest: { number: 214, url: 'https://github.com/o/r/pull/214', headSha: HEAD },
    testedSha: HEAD, failureLines: ['expected 2, got 3'], landingSessionId: null,
  });
  assert.match(task, /The required check "PostgreSQL specs" failed on pull request #214 \(aaaaaaa\):\nexpected 2, got 3\nFull log: /);
  assert.match(task, /Orbit updates pull request #214 with your commit, and GitHub runs the checks again\. Do not push main\./);
  assert.doesNotMatch(task, /Nothing was pushed/, 'the landing branch was pushed; main was not');
});

test('§4.7: a delivery is GitHub\'s only when signed with the saved secret', () => {
  const body = Buffer.from('{"action":"completed"}');
  const signature = `sha256=${createHmac('sha256', 'the-secret').update(body).digest('hex')}`;
  assert.equal(githubSignatureValid('the-secret', body, signature), true);
  assert.equal(githubSignatureValid('another-secret', body, signature), false);
  assert.equal(githubSignatureValid('the-secret', Buffer.from('{"action":"opened"}'), signature), false);
  assert.equal(githubSignatureValid('the-secret', body, undefined), false);
  assert.equal(githubSignatureValid('the-secret', body, signature.replace('sha256=', 'sha1=')), false);
  assert.equal(githubSignatureValid('', body, signature), false);
});

test('§4.7: what a delivery is about, read only to find which pull requests to read again', () => {
  assert.deepEqual(deliveryAbout('pull_request', {
    action: 'synchronize', installation: { id: 7 }, repository: { id: 9 }, pull_request: { number: 214, head: { sha: HEAD } },
  }), { action: 'synchronize', installationId: 7n, repoId: 9n, pullNumbers: [214], headShas: [HEAD], pushedRef: null });
  assert.deepEqual(deliveryAbout('check_suite', {
    action: 'completed', repository: { id: 9 }, check_suite: { head_sha: HEAD, pull_requests: [{ number: 214 }, { number: 215 }] },
  }).pullNumbers, [214, 215]);
  assert.deepEqual(deliveryAbout('status', { repository: { id: 9 }, sha: HEAD }).headShas, [HEAD]);
  assert.equal(deliveryAbout('push', { repository: { id: 9 }, ref: 'refs/heads/main' }).pushedRef, 'refs/heads/main');
  assert.deepEqual(deliveryAbout('installation', { action: 'new_permissions_accepted', installation: { id: 7 } }), {
    action: 'new_permissions_accepted', installationId: 7n, repoId: null, pullNumbers: [], headShas: [], pushedRef: null,
  });
  assert.deepEqual(deliveryAbout('pull_request', 'not an object'), {
    action: null, installationId: null, repoId: null, pullNumbers: [], headShas: [], pushedRef: null,
  });
});

test('§10: an installation lands through pull requests once it granted every permission they need', () => {
  const old = { contents: 'write', metadata: 'read' };
  assert.equal(grantsPullRequestLanding(old), false);
  assert.deepEqual(pullRequestPermissionsPending(old), ['pull_requests', 'checks', 'statuses']);
  const accepted = { ...old, pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read', workflows: 'write' };
  assert.equal(grantsPullRequestLanding(accepted), true);
  assert.deepEqual(pullRequestPermissionsPending(accepted), []);
  assert.equal(grantsPullRequestLanding({ ...accepted, pull_requests: 'read' }), false, 'reading pull requests cannot merge one');
  assert.equal(grantsPullRequestLanding({ ...accepted, checks: 'write' }), true, 'write covers read');
});

test('§3: the mode a landing is handed out with', () => {
  const facts = (over: Partial<LandingModeFacts> = {}): LandingModeFacts => ({
    targetRef: 'refs/heads/main', githubRepoId: 9n, githubInstallationId: 7n, runnerDeclares: true, permissionsGranted: true,
    landingKey: 'a7b9c2d0-0000-7000-8000-000000000001', openPullRequest: null, ...over,
  });
  assert.deepEqual(landingModeOf(facts()), {
    landVia: 'PULL_REQUEST', rule: 'DEFAULT', landingRef: 'refs/heads/orbit/land/a7b9c2d0-0000-7000-8000-000000000001',
  });
  assert.equal(landingModeOf(facts({ targetRef: 'refs/heads/project/x' })).rule, 'ORBIT_BRANCH');
  assert.equal(landingModeOf(facts({ targetRef: 'refs/heads/orbit/land/y' })).landVia, 'PUSH');
  assert.equal(landingModeOf(facts({ githubRepoId: null })).rule, 'NOT_FROM_GITHUB');
  assert.equal(landingModeOf(facts({ runnerDeclares: false })).rule, 'RUNNER_OUTDATED');
  assert.equal(landingModeOf(facts({ permissionsGranted: false })).rule, 'PERMISSIONS_PENDING');
  assert.equal(landingModeOf(facts({ permissionsGranted: null })).rule, 'PERMISSIONS_PENDING', 'a grant nobody could read is not one');
  assert.equal(landingModeOf(facts({ landingKey: null })).rule, 'NO_LANDING_SUBJECT');
  // An open pull request is finished through, whatever the grant says now.
  assert.deepEqual(landingModeOf(facts({ permissionsGranted: false, openPullRequest: { headSha: HEAD } })), {
    landVia: 'PULL_REQUEST', rule: 'OPEN_PULL_REQUEST', landingRef: 'refs/heads/orbit/land/a7b9c2d0-0000-7000-8000-000000000001',
    landingRefSha: HEAD, pullRequestOpen: true,
  });
  // Only a runner that declared the capability is handed any of it.
  assert.deepEqual(landingCommandFields(landingModeOf(facts()), false), {});
  assert.deepEqual(landingCommandFields({ landVia: 'PUSH', rule: 'ORBIT_BRANCH' }, true), { landVia: 'PUSH' });
  assert.equal(isOrbitOwnedRef('refs/heads/main'), false);
  assert.equal(isOrbitOwnedRef('project/p'), true);
  assert.equal(landingRefFor('s'), 'refs/heads/orbit/land/s');
});

test('§8: the pull request block and the sentence a waiting landing reads as', () => {
  const view = pullRequestViewOf({
    number: 214, url: 'https://github.com/o/r/pull/214', state: 'OPEN', condition: 'CHECKS_PENDING',
    checks: [check('unit', true, 'PASSED'), check('pg', true, 'PENDING'), check('lint', true, 'FAILED'), check('labeler', false, 'FAILED')],
    mergeMethod: null, mergedSha: null, refusal: { via: 'PULL_REQUEST', message: 'GH006: Protected branch update failed', at: 'x' },
  });
  assert.deepEqual(view.checks, { passed: 1, required: 3, failed: [{ name: 'lint', url: null }] });
  assert.deepEqual(view.refusal, { via: 'PULL_REQUEST', message: 'GH006: Protected branch update failed' });
  assert.equal(pullRequestBlockingCode('REVIEW_REQUIRED'), 'WAITING_FOR_REVIEW');
  assert.equal(pullRequestBlockingCode('CHECKS_PENDING'), 'WAITING_FOR_CHECKS');
  assert.equal(pullRequestBlockingCode(null), 'WAITING_FOR_CHECKS');
  assert.equal(pullRequestWaitSummary('WAITING_FOR_CHECKS', view, 'main'), 'Waiting for the required checks on pull request #214 · 1 of 3');
  assert.equal(pullRequestWaitSummary('WAITING_FOR_REVIEW', { ...view, condition: 'REVIEW_REQUIRED' }, 'main'), 'Waiting for review on pull request #214');
  assert.equal(pullRequestWaitSummary('WAITING_FOR_CHECKS', { ...view, number: null }, 'trunk'), 'Opening a pull request: trunk requires one');
  assert.equal(storedRefusal('  '), null);
  assert.equal(storedRefusal('x'.repeat(5000))?.length, 1000);
});

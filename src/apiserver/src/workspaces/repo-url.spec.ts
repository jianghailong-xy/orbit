import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloneTargetDir, parseRepoUrl, sameRepo } from './repo-url';

// The user pastes a URL and never types a path, so the directory name has to come out of the URL.
// Everything here is about that derivation — not about whether the remote resolves, which is git's
// answer to give on the runner.

test('the three spellings of one remote all land in the same directory', () => {
  for (const url of [
    'https://github.com/anthropics/orbit.git',
    'https://github.com/anthropics/orbit',
    'git@github.com:anthropics/orbit.git',
    'ssh://git@github.com:22/anthropics/orbit.git',
  ]) {
    assert.equal(parseRepoUrl(url)?.dirName, 'anthropics-orbit', url);
    assert.equal(cloneTargetDir('/srv/repos', url), '/srv/repos/anthropics-orbit', url);
  }
});

test('two spellings of one remote are the same repository', () => {
  assert.equal(
    sameRepo('git@github.com:anthropics/orbit.git', 'https://github.com/Anthropics/Orbit'),
    true,
  );
  assert.equal(
    sameRepo('https://github.com/anthropics/orbit', 'https://gitlab.com/anthropics/orbit'),
    false,
  );
  assert.equal(
    sameRepo('https://github.com/anthropics/orbit', 'https://github.com/anthropics/other'),
    false,
  );
});

test('a nested group keeps only the two segments that name the repository', () => {
  assert.equal(parseRepoUrl('https://gitlab.com/team/sub/tools/agent.git')?.dirName, 'tools-agent');
});

// This string becomes a path on someone else's disk. A traversal is refused rather than cleaned
// up: a sanitized `..` is still a request to write outside the repos root.
test('a URL that would escape the repos root yields no directory at all', () => {
  for (const url of [
    'https://github.com/../../etc/passwd',
    'https://github.com/owner/..',
    'git@github.com:../evil.git',
    'https://github.com/owner',
    'not a url',
    '',
  ]) {
    assert.equal(parseRepoUrl(url), null, url);
    assert.equal(cloneTargetDir('/srv/repos', url), null, url);
  }
});

test('a trailing slash on the repos root does not double up in the path', () => {
  assert.equal(
    cloneTargetDir('/srv/repos/', 'https://github.com/anthropics/orbit.git'),
    '/srv/repos/anthropics-orbit',
  );
});

// Falling back to an exact comparison, rather than inventing an identity for a URL nobody could
// read, is what keeps "the same repo" from ever being a guess.
test('unreadable URLs compare as themselves', () => {
  assert.equal(sameRepo('whatever', 'whatever'), true);
  assert.equal(sameRepo('whatever', 'something else'), false);
});

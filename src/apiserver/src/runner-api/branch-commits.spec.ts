import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storableBranchCommits } from './branch-commits';

test('a report without a commit list leaves the stored one as it was', () => {
  assert.equal(storableBranchCommits(undefined), undefined);
  assert.equal(storableBranchCommits(null), undefined);
  assert.equal(storableBranchCommits('a41c9e2'), undefined);
});

test('an empty list is stored as empty: the branch holds no commit of its own', () => {
  assert.deepEqual(storableBranchCommits([]), []);
});

test('a commit keeps the fields the bar reads, NUL-free, and drops one with no sha', () => {
  const stored = storableBranchCommits([
    {
      sha: 'a41c9e2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      subject: 'feat(rows): paginate\u0000',
      body: 'Why.',
      committedAt: '2026-11-19T10:20:00Z',
      savedBy: 'session-end',
      files: [{ path: 'a.ts', additions: 3, deletions: 1 }, { path: 'b.png', additions: -1, deletions: -1 }, { nope: 1 }],
      extra: 'not stored',
    },
    { subject: 'no sha' },
  ]);
  assert.deepEqual(stored, [
    {
      sha: 'a41c9e2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      subject: 'feat(rows): paginate',
      body: 'Why.',
      committedAt: '2026-11-19T10:20:00Z',
      savedBy: 'session-end',
      files: [{ path: 'a.ts', additions: 3, deletions: 1 }, { path: 'b.png', additions: -1, deletions: -1 }],
    },
  ]);
});

test('the list and each commit’s files are capped', () => {
  const files = Array.from({ length: 150 }, (_, i) => ({ path: `f${i}`, additions: 1, deletions: 0 }));
  const many = Array.from({ length: 150 }, (_, i) => ({
    sha: i.toString(16).padStart(40, '0'), subject: `c${i}`, committedAt: '', files,
  }));
  const stored = storableBranchCommits(many)!;
  assert.equal(stored.length, 100);
  assert.equal(stored[0].files.length, 100);
  assert.equal(stored[0].filesTruncated, true);
});

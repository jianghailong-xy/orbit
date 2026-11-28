import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validSnapshotAnswer } from './main-checkout.service';

// The runner's own answers (runner-go TestWriteMainCheckoutWebFixtures: a real repository, 21 commits ahead, 3 files
// uncommitted) as the control plane stores them. The web's Main checkout bar is drawn from the same file.
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '../../../shared/src/main-checkout-unpushed.fixture.json'), 'utf8'),
) as { plain: { snapshot: { commits: unknown[]; commitsTruncated: boolean; ahead: number; fileCount: number } }; commit: { diffs: unknown[] } };

test('the runner’s snapshot answer passes the control plane unchanged: 20 of 21 commits, truncated', () => {
  const kept = validSnapshotAnswer(fixture.plain);
  assert.deepEqual(kept, fixture.plain);
  assert.equal(kept.snapshot?.commits?.length, 20);
  assert.equal(kept.snapshot?.commitsTruncated, true);
  assert.equal(kept.snapshot?.ahead, 21);
  assert.equal(kept.snapshot?.fileCount, 3);
});

test('a commit read’s answer keeps that commit’s patch', () => {
  assert.deepEqual(validSnapshotAnswer(fixture.commit), fixture.commit);
  assert.equal(fixture.commit.diffs.length, 1);
});

test('more than 20 commits in an answer are cut to 20', () => {
  const commits = [...fixture.plain.snapshot.commits, ...fixture.plain.snapshot.commits];
  const cut = validSnapshotAnswer({ snapshot: { ...fixture.plain.snapshot, commits } });
  assert.equal(cut.snapshot?.commits?.length, 20);
});

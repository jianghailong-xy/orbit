import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFailure } from '@orbit/shared';

// Verbatim from this deployment's `session.error` column. Sampling the real text rather than
// paraphrasing it is the whole point: these markers are substring matches, and a classifier
// tested against invented wording is a classifier tested against nothing.
const REAL = {
  quota:
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase " +
    'more credits or try again at Aug 9th, 2026 1:26 PM.',
  infrastructure: 'runner offline',
  contentFilter: 'API Error: 400 Output blocked by content filtering policy',
};

test('the three catalogued wordings land in their own buckets', () => {
  // 1,571 / 126 / 9 of this deployment's 1,710 failed runs respectively.
  assert.equal(classifyFailure(REAL.quota), 'quota');
  assert.equal(classifyFailure(REAL.infrastructure), 'infrastructure');
  assert.equal(classifyFailure(REAL.contentFilter), 'contentFilter');
});

test('an unrecorded error is unattributed, not filed under a guess', () => {
  // The four failures with no error text are exactly the ones worth a human's attention; folding
  // them into a known bucket would hide that, and each bucket names a different lever.
  assert.equal(classifyFailure(null), 'unattributed');
  assert.equal(classifyFailure(''), 'unattributed');
  assert.equal(classifyFailure('Something nobody has catalogued yet'), 'unattributed');
});

test('quota is decided by the shared marker, not a second copy of the wording', () => {
  // Claude phrases its own limit differently, and the gate that holds dispatch back already
  // knows both. A classifier with its own list would disagree with the gate about the same run.
  assert.equal(
    classifyFailure("You've hit your session limit · resets 6:20pm (Europe/Berlin)"),
    'quota',
  );
});

test('classification is case-insensitive, as the runtimes are not consistent about it', () => {
  assert.equal(classifyFailure('RUNNER OFFLINE'), 'infrastructure');
  assert.equal(classifyFailure('Output Blocked by content filtering'), 'contentFilter');
});

test('quota wins over a message that also mentions the runner', () => {
  // Order matters: a run killed by a spent quota while its runner happened to be flapping is a
  // quota failure, and waiting for the window is the lever. Reporting it as infrastructure sends
  // someone to restart a machine that is working.
  assert.equal(
    classifyFailure("You've hit your usage limit — runner offline shortly after"),
    'quota',
  );
});

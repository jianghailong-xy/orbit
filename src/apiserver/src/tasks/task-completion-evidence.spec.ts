import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  canonicalCompletionJson,
  completionDigest,
  normalizeCompletionEvidence,
} from './task-completion-evidence.service';

test('canonical evidence ignores object order, Unicode composition and line-ending representation', () => {
  const first = normalizeCompletionEvidence({
    summary: { z: 2, a: 'caf\u00e9\r\n' },
    commands: [{ command: 'npm test', exitCode: 0 }],
  });
  const equivalent = normalizeCompletionEvidence({
    commands: [{ exitCode: 0, command: 'npm test' }],
    summary: { a: 'cafe\u0301\n', z: 2 },
  });
  assert.equal(canonicalCompletionJson(first), canonicalCompletionJson(equivalent));
  assert.equal(completionDigest(first), completionDigest(equivalent));
});

test('substantive evidence changes affect the digest while array order and whitespace remain facts', () => {
  const base = normalizeCompletionEvidence({ output: 'ok\n', exitCode: 0, checks: ['a', 'b'] });
  assert.notEqual(completionDigest(base), completionDigest({ ...base as object, exitCode: 1 }));
  assert.notEqual(completionDigest(base), completionDigest({ ...base as object, output: ' ok\n' }));
  assert.notEqual(completionDigest(base), completionDigest({ ...base as object, checks: ['b', 'a'] }));
  assert.match(completionDigest(base), /^[0-9a-f]{64}$/);
});

test('the evidence service is state-orthogonal and only the explicit legacy door reads a comment', () => {
  const source = readFileSync('src/tasks/task-completion-evidence.service.ts', 'utf8');
  const liveSubmit = source.slice(
    source.indexOf('  async submit('),
    source.indexOf('  async importLegacyComment('),
  );
  assert.ok(liveSubmit.length > 1_000, 'the static check did not locate the live submission path');
  assert.doesNotMatch(liveSubmit, /taskComment|lastAssistant|finalReply/,
    'ordinary evidence submission must never infer a fact from prose');
  assert.doesNotMatch(source, /lastAssistant|finalReply|publish|notify/);
  assert.equal((source.match(/taskComment\.findFirst/g) ?? []).length, 1,
    'exactly the explicit one-comment import may read a historical comment');
  assert.doesNotMatch(source, /taskComment\.(?:findMany|aggregate|count)/,
    'legacy import must not enumerate comments for bulk inference');
  assert.match(source, /async importLegacyComment[\s\S]*actor\.type !== CreatorType\.USER/);
  assert.match(source, /createHash\('sha256'\)\.update\(sourceComment\.body, 'utf8'\)/);
  // Still state-orthogonal on the way IN: submitting or importing evidence writes no Task and no
  // Session. What decides is the decision door, and only there — one compare-and-set that restates
  // the criterion and the pending statuses in its WHERE clause, so a decision cannot complete a
  // task that declared something else or one that was already cancelled or failed.
  const submitAndImport = source.slice(0, source.indexOf('  async decide('));
  assert.ok(submitAndImport.includes('async importLegacyComment('), 'the slice lost a write door');
  assert.doesNotMatch(submitAndImport,
    /(?:tx|this\.prisma)\.task\.update|(?:tx|this\.prisma)\.session\.update/);
  assert.doesNotMatch(source, /(?:tx|this\.prisma)\.session\.update/);
  const decide = source.slice(source.indexOf('  async decide('), source.indexOf('  async list('));
  assert.equal((decide.match(/(?:tx|this\.prisma)\.task\.update/g) ?? []).length, 1,
    'the decision door writes the task once, and nothing else in this file writes it at all');
  assert.match(decide, /completionCriterion: 'EVIDENCE_JUDGMENT',/);
  assert.match(decide, /status: \{ in: \[TaskStatus\.OPEN, TaskStatus\.IN_PROGRESS\] \},/);
  assert.doesNotMatch(source, /ATTEMPT_WAKE_SESSION_PARKED/);
  assert.match(source, /source session for task not found/);
  assert.match(source, /taskCompletionEvidence\.create/);
  // The ledger writes evidence and nothing else. Until 2026-09-02 the same transaction raised a
  // judgment request and superseded the previous one; both went with the request table.
  assert.doesNotMatch(source, /taskJudgmentRequest/);
  assert.doesNotMatch(source, /TaskJudgmentRequestStatus/);
});

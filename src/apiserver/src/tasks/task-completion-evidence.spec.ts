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

test('the evidence service is state-orthogonal and contains no comment/final-reply inference', () => {
  const source = readFileSync('src/tasks/task-completion-evidence.service.ts', 'utf8');
  assert.doesNotMatch(source, /taskComment|lastAssistant|finalReply|publish|notify/);
  assert.doesNotMatch(source, /task\.update|session\.update|status\s*[:=]/);
  assert.match(source, /source session for task not found/);
  assert.match(source, /taskCompletionEvidence\.create/);
});

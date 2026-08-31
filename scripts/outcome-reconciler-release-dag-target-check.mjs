#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const plan = JSON.parse(readFileSync(path.join(
  repo, 'contracts/outcome-reconciler-release-dag.json'
), 'utf8'));
const authoritative = JSON.parse(readFileSync(path.join(
  repo, 'contracts/outcome-reconciler-authoritative-target.json'
), 'utf8'));

function run(file, args) {
  return execFileSync(file, args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const head = run('git', ['rev-parse', 'HEAD']);
const originMain = run('git', ['rev-parse', 'refs/remotes/origin/main']);
const remoteMain = run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/u)[0];
assert.match(head, /^[0-9a-f]{40}$/u);
assert.equal(originMain, head, 'fresh origin/main does not equal the frozen checkout');
assert.equal(remoteMain, head, 'remote refs/heads/main does not equal the frozen checkout');
assert.equal(run('git', ['status', '--porcelain=v1', '--untracked-files=no']), '',
  'frozen target checkout has tracked changes');
assert.equal(authoritative.taskId, plan.builderTaskId);
assert.equal(authoritative.sourceBranch, plan.builder.sourceBranch);
assert.equal(plan.target.resolution, 'BUILDER_AGENT_MERGE_RECEIPT');
assert.equal(plan.target.requiredReceipt.sessionDatabaseId, plan.builder.sessionDatabaseId);
assert.equal(plan.target.requiredReceipt.sourceBranch, plan.builder.sourceBranch);

const sql = `
SELECT result, source_branch, btrim(source_sha::text), target_branch,
       btrim(target_sha_after::text), recorded_by
 FROM session_merge_receipt
 WHERE session_id = '${plan.builder.sessionDatabaseId}'::uuid
   AND task_id = '${plan.builder.taskDatabaseId}'::uuid
   AND source_branch = '${authoritative.sourceBranch}'
   AND source_sha = '${head}'::char(40)
   AND target_branch = 'main'
   AND target_sha_after = '${head}'::char(40)
   AND result IN ('MERGED', 'ALREADY_MERGED')
 ORDER BY created_at DESC
 LIMIT 1`;
const row = run('docker', [
  'exec', 'orbit-postgres', 'psql', '-U', 'orbit', '-d', 'orbit',
  '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql,
]).split('\t');
assert.equal(row.length, 6, 'merge/push receipt is missing');
assert.ok(['MERGED', 'ALREADY_MERGED'].includes(row[0]));
assert.deepEqual(row.slice(1), [authoritative.sourceBranch, head, 'main', head, 'AGENT']);

console.log(JSON.stringify({
  outcome: 'PASS',
  targetSha: head,
  targetRef: plan.target.ref,
  sourceBranch: authoritative.sourceBranch,
  receiptResult: row[0],
}));

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const root = path.resolve(import.meta.dirname, '..');
const outputPath = path.resolve(process.argv[2] ?? path.join(
  root,
  'build/outcome-reconciler-authoritative-target-manifest.json',
));
const allowUnpushed = process.env.AUTHORITATIVE_TARGET_ALLOW_UNPUSHED === '1';
const dagPredeploy = process.env.OUTCOME_RELEASE_DAG_ACTIVE === '1'
  && process.env.OUTCOME_RELEASE_DAG_PHASE === 'PREDEPLOY_EVALUATION';

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function git(...args) {
  return run('git', args);
}

function isAncestor(ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr || 'git merge-base failed');
  return result.status === 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileDigest(relative) {
  const value = readFileSync(path.join(root, relative));
  return { sha256: sha256(value), bytes: value.byteLength };
}

function uuidToBase62(uuid) {
  assert.match(uuid, UUID);
  let value = BigInt(`0x${uuid.replaceAll('-', '')}`);
  if (value === 0n) return '0';
  let output = '';
  while (value > 0n) {
    output = ALPHABET[Number(value % 62n)] + output;
    value /= 62n;
  }
  return output;
}

function queryOrbit(sql) {
  return run('docker', [
    'exec', 'orbit-postgres', 'psql', '-U', 'orbit', '-d', 'orbit',
    '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql,
  ]);
}

function assertTracked(relative) {
  const absolute = path.join(root, relative);
  assert.ok(existsSync(absolute), `${relative} is missing`);
  assert.ok(statSync(absolute).isFile(), `${relative} is not a file`);
  assert.equal(git('ls-files', '--error-unmatch', relative), relative, `${relative} is not tracked`);
}

const inventoryPath = 'contracts/outcome-reconciler-authoritative-target.json';
const inventory = JSON.parse(readFileSync(path.join(root, inventoryPath), 'utf8'));
const releaseDag = JSON.parse(readFileSync(path.join(
  root, 'contracts/outcome-reconciler-release-dag.json',
), 'utf8'));
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(inventory.schemaVersion, 1);
assert.equal(inventory.targetBranch, 'main');
assert.equal(inventory.targetRef, 'refs/heads/main');
assert.equal(inventory.lineage.historyPolicy, 'NO_FORCE_NO_RESET_NO_REWRITE');
assert.match(inventory.lineage.remoteMainObservedBeforeIntegration, SHA);
assert.match(inventory.lineage.localMainIntegrationBase, SHA);
assert.equal(inventory.immutableVerifier.status, 'DONE');
assert.equal(inventory.immutableVerifier.verdict, 'FAIL');
assert.match(inventory.immutableVerifier.evidenceDigest, DIGEST);
assert.equal(inventory.historicalEvidencePolicy,
  'ANCESTRY_INVENTORY_ONLY_NOT_CURRENT_RELEASE_EVIDENCE');
assert.equal(releaseDag.builderTaskId, inventory.taskId);
assert.equal(releaseDag.builder.sourceBranch, inventory.sourceBranch);
assert.equal(releaseDag.target.resolution, 'BUILDER_AGENT_MERGE_RECEIPT');
// Every other identity in the receipt lookup below is read from the Release DAG builder, so a
// rebind that moves the builder cannot leave them behind. The branch was the one field read from
// this inventory instead, which is how it stayed on a two-generation-old branch whose receipt
// attests a superseded target: the lookup then matched nothing and the node failed with a bare
// "receipt is missing". Tying it to the branch the rest of the contract already agrees on makes
// that drift a contract error at the top of the run rather than a mystery at the query.
assert.equal(inventory.authoritativeReceiptLookup.sourceBranch, inventory.sourceBranch,
  'the authoritative receipt lookup names a different branch than the declared source branch');

if (!allowUnpushed) git('fetch', '--quiet', 'origin', 'refs/heads/main:refs/remotes/origin/main');

const target = git('rev-parse', 'HEAD');
assert.match(target, SHA);
const branch = git('branch', '--show-current') || 'DETACHED_HEAD';
const remoteUrl = git('config', '--get', 'remote.origin.url');
const refs = {
  declaredTarget: target,
  checkoutHead: target,
  localMain: allowUnpushed ? null : git('rev-parse', 'refs/heads/main'),
  originMain: allowUnpushed ? null : git('rev-parse', 'refs/remotes/origin/main'),
  remoteHeadsMain: allowUnpushed
    ? null
    : git('ls-remote', 'origin', inventory.targetRef).split(/\s+/u)[0],
};
if (!allowUnpushed) {
  if (dagPredeploy) {
    assert.equal(process.env.OUTCOME_RELEASE_DAG_TARGET_SHA, target,
      'Release DAG target binding differs from the authoritative target');
  } else {
    assert.equal(branch, 'main', 'clean verification checkout is not on main');
  }
  for (const [name, value] of Object.entries(refs)) {
    assert.match(value, SHA, `${name} is not a full SHA`);
    if (name !== 'localMain' || !dagPredeploy) {
      assert.equal(value, target, `${name} does not equal the declared target`);
    }
  }
  if (dagPredeploy) {
    assert.ok(isAncestor(refs.localMain, target),
      'local deployment main is not an ancestor of the frozen predeploy target');
  }
}

const cleanBefore = git('status', '--porcelain=v1', '--untracked-files=all');
assert.equal(cleanBefore, '', 'verification worktree is not clean');
assert.ok(
  isAncestor(inventory.lineage.remoteMainObservedBeforeIntegration, target),
  'the original remote main was removed from target ancestry',
);
assert.ok(
  isAncestor(inventory.lineage.localMainIntegrationBase, target),
  'the local integration base was removed from target ancestry',
);

const candidates = inventory.candidates.map((candidate) => {
  assert.match(candidate.candidateCommit, SHA, `${candidate.taskId} has an invalid candidate SHA`);
  assert.match(candidate.sessionId, /^[0-9A-Za-z]+$/u);
  assert.ok(candidate.branch.startsWith('orbit/'));
  const objectType = git('cat-file', '-t', candidate.candidateCommit);
  assert.equal(objectType, 'commit', `${candidate.candidateCommit} is not a commit`);
  const ancestor = isAncestor(candidate.candidateCommit, target);
  if (candidate.requiredAncestor) {
    assert.ok(ancestor, `${candidate.taskId}/${candidate.candidateCommit} is missing from target ancestry`);
  }
  return { ...candidate, targetAncestor: ancestor };
});
assert.equal(candidates.length, 29, 'the terminal project session inventory is incomplete');
assert.equal(new Set(candidates.map((candidate) => candidate.taskId)).size, candidates.length);
assert.equal(new Set(candidates.map((candidate) => candidate.sessionId)).size, candidates.length);

const recordedMergeReceipts = inventory.recordedMergeReceipts.map((receipt) => {
  for (const field of ['sourceSha', 'targetShaBefore', 'targetShaAfter']) {
    assert.match(receipt[field], SHA, `${receipt.id}.${field} is not a full SHA`);
    assert.equal(git('cat-file', '-t', receipt[field]), 'commit');
  }
  assert.ok(isAncestor(receipt.sourceSha, receipt.targetShaAfter), `${receipt.id} source is not landed`);
  assert.ok(isAncestor(receipt.targetShaBefore, receipt.targetShaAfter), `${receipt.id} rewrites history`);
  assert.ok(isAncestor(receipt.targetShaAfter, target), `${receipt.id} target is outside authority ancestry`);
  return { ...receipt, rechecked: true };
});

const integrationMerges = inventory.integrationMerges.map((merge) => {
  assert.match(merge.mergeCommit, SHA);
  assert.equal(git('cat-file', '-t', merge.mergeCommit), 'commit');
  assert.ok(isAncestor(merge.mergeCommit, target), `${merge.mergeCommit} is outside target ancestry`);
  const source = candidates.find((candidate) => candidate.branch === merge.sourceBranch);
  assert.ok(source, `${merge.sourceBranch} has no candidate inventory row`);
  assert.ok(
    isAncestor(source.candidateCommit, merge.mergeCommit),
    `${merge.mergeCommit} does not integrate ${source.candidateCommit}`,
  );
  const parents = git('rev-list', '--parents', '-n', '1', merge.mergeCommit).split(' ');
  assert.ok(parents.length >= 3, `${merge.mergeCommit} is not a merge commit`);
  return { ...merge, candidateCommit: source.candidateCommit, targetAncestor: true };
});

const integratedDeliveries = releaseDag.integratedDeliveries.map((delivery) => ({
  ...delivery,
  commits: delivery.commits.map((commit, index) => {
    assert.match(commit, SHA);
    assert.equal(git('cat-file', '-t', commit), 'commit');
    assert.ok(isAncestor(commit, target), `${delivery.taskId}/${commit} is missing from target`);
    assert.equal(git('show', '-s', '--format=%s', commit), delivery.requiredSubjects[index]);
    return { sha: commit, subject: delivery.requiredSubjects[index], targetAncestor: true };
  }),
}));

const entrypoints = inventory.requiredEntrypoints.map((entrypoint) => {
  assert.equal(packageJson.scripts?.[entrypoint.packageScript], entrypoint.command);
  assertTracked(entrypoint.shell);
  assertTracked(entrypoint.manifestGenerator);
  run('bash', ['-n', entrypoint.shell]);
  run(process.execPath, ['--check', entrypoint.manifestGenerator]);
  const shellSource = readFileSync(path.join(root, entrypoint.shell), 'utf8');
  assert.ok(
    shellSource.includes(entrypoint.manifestGenerator),
    `${entrypoint.shell} does not invoke ${entrypoint.manifestGenerator}`,
  );
  const additionalVerifier = entrypoint.additionalVerifier
    ? (() => {
        assertTracked(entrypoint.additionalVerifier);
        run(process.execPath, ['--check', entrypoint.additionalVerifier]);
        assert.ok(shellSource.includes(entrypoint.additionalVerifier));
        return { path: entrypoint.additionalVerifier, ...fileDigest(entrypoint.additionalVerifier) };
      })()
    : null;
  return {
    ...entrypoint,
    packageResolution: packageJson.scripts[entrypoint.packageScript],
    shellParse: 'PASS',
    manifestGeneratorParse: 'PASS',
    shellDigest: fileDigest(entrypoint.shell),
    manifestGeneratorDigest: fileDigest(entrypoint.manifestGenerator),
    additionalVerifier,
  };
});
assert.equal(entrypoints.length, 1);

const verifierSql = `
SELECT e.id::text,
       btrim(e.evidence_digest::text),
       e.revision::text,
       t.id::text,
       t.status::text,
       COALESCE(t.verdict::text, ''),
       COALESCE(t.superseded_by_task_id::text, 'NONE')
  FROM task_completion_evidence e
  JOIN task t ON t.id = e.task_id
 WHERE e.evidence_digest = '${inventory.immutableVerifier.evidenceDigest}'::char(64)
 ORDER BY e.revision DESC
 LIMIT 1`;
const verifierColumns = queryOrbit(verifierSql).split('\t');
assert.equal(verifierColumns.length, 7, 'immutable verifier evidence was not found uniquely');
const observedVerifier = {
  evidenceDatabaseId: verifierColumns[0],
  evidenceId: uuidToBase62(verifierColumns[0]),
  evidenceDigest: verifierColumns[1],
  evidenceRevision: verifierColumns[2],
  taskDatabaseId: verifierColumns[3],
  taskId: uuidToBase62(verifierColumns[3]),
  status: verifierColumns[4],
  verdict: verifierColumns[5],
  supersededByTaskDatabaseId: verifierColumns[6] === 'NONE' ? null : verifierColumns[6],
};
assert.equal(observedVerifier.evidenceId, inventory.immutableVerifier.evidenceId);
assert.equal(observedVerifier.evidenceDigest, inventory.immutableVerifier.evidenceDigest);
assert.equal(observedVerifier.taskId, inventory.immutableVerifier.taskId);
assert.equal(observedVerifier.status, inventory.immutableVerifier.status);
assert.equal(observedVerifier.verdict, inventory.immutableVerifier.verdict);
assert.equal(observedVerifier.supersededByTaskDatabaseId, null, 'old verifier was marked superseded');

let authoritativeReceipt = null;
if (!allowUnpushed) {
  const lookup = inventory.authoritativeReceiptLookup;
  const receiptSql = `
SELECT id::text,
       result,
       source_branch,
       btrim(source_sha::text),
       target_branch,
       COALESCE(btrim(target_sha_before::text), ''),
       COALESCE(btrim(target_sha_after::text), ''),
       recorded_by,
       created_at::text
  FROM session_merge_receipt
 WHERE session_id = '${releaseDag.builder.sessionDatabaseId}'::uuid
   AND task_id = '${releaseDag.builder.taskDatabaseId}'::uuid
   AND source_branch = '${lookup.sourceBranch}'
   AND source_sha = '${target}'::char(40)
   AND target_branch = '${lookup.targetBranch}'
   AND target_sha_after = '${target}'::char(40)
   AND recorded_by = '${lookup.requiredRecordedBy}'
   AND result IN ('MERGED', 'ALREADY_MERGED')
 ORDER BY created_at DESC
 LIMIT 1`;
  const receiptColumns = queryOrbit(receiptSql).split('\t');
  assert.equal(receiptColumns.length, 9, 'authoritative non-force push receipt is missing');
  authoritativeReceipt = {
    databaseId: receiptColumns[0],
    publicId: uuidToBase62(receiptColumns[0]),
    result: receiptColumns[1],
    sourceBranch: receiptColumns[2],
    sourceSha: receiptColumns[3],
    targetBranch: receiptColumns[4],
    targetShaBefore: receiptColumns[5],
    targetShaAfter: receiptColumns[6],
    recordedBy: receiptColumns[7],
    createdAt: receiptColumns[8],
  };
  assert.ok(lookup.requiredResult.includes(authoritativeReceipt.result));
  assert.equal(authoritativeReceipt.sourceBranch, lookup.sourceBranch);
  assert.equal(authoritativeReceipt.sourceSha, target);
  assert.equal(authoritativeReceipt.targetBranch, lookup.targetBranch);
  assert.equal(authoritativeReceipt.targetShaAfter, target);
  assert.equal(authoritativeReceipt.recordedBy, lookup.requiredRecordedBy);
  assert.match(authoritativeReceipt.targetShaBefore, SHA);
  const strictAdvance = authoritativeReceipt.result === 'MERGED';
  if (strictAdvance) assert.notEqual(authoritativeReceipt.targetShaBefore, target);
  else assert.equal(authoritativeReceipt.targetShaBefore, target);
  assert.ok(
    isAncestor(authoritativeReceipt.targetShaBefore, target),
    'authoritative receipt does not describe a non-force fast-forward',
  );
  authoritativeReceipt.mode = strictAdvance ? 'NON_FORCE_FAST_FORWARD' : 'ALREADY_CURRENT';
  authoritativeReceipt.proof = {
    remoteEqualsTarget: refs.remoteHeadsMain === target,
    beforeIsStrictAncestor: strictAdvance,
    sourceEqualsTarget: true,
    targetAfterEqualsRemote: true,
  };
}

const cleanAfter = git('status', '--porcelain=v1', '--untracked-files=all');
assert.equal(cleanAfter, '', 'verification worktree became dirty');

const sourceFiles = [
  'package.json',
  inventoryPath,
  'contracts/outcome-reconciler-release-dag.json',
  'scripts/outcome-reconciler-authoritative-target.sh',
  'scripts/outcome-reconciler-authoritative-target.mjs',
];
const sources = Object.fromEntries(sourceFiles.map((relative) => [relative, fileDigest(relative)]));
const sourceDigest = sha256(sourceFiles
  .map((relative) => `${relative}:${sources[relative].sha256}`)
  .join('\n'));

const manifest = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.authoritative-target-attestation',
  outcome: 'PASS',
  generatedAt: new Date().toISOString(),
  verificationMode: allowUnpushed
    ? 'LOCAL_PRE_PUSH_AUDIT'
    : dagPredeploy ? 'FROZEN_PREDEPLOY_SOURCE_BRANCH' : 'CLEAN_REMOTE_CLONE',
  repository: {
    remoteUrl,
    branch,
    targetRef: inventory.targetRef,
    cleanTemporaryClone: !allowUnpushed && !dagPredeploy,
    exactReceiptTargetCheckout: dagPredeploy,
    builderReceiptSourceBranch: dagPredeploy ? inventory.sourceBranch : null,
  },
  refs,
  worktree: { clean: true, porcelain: cleanAfter },
  history: {
    policy: inventory.lineage.historyPolicy,
    originalRemoteCommit: inventory.lineage.remoteMainObservedBeforeIntegration,
    originalRemoteCommitIsAncestor: true,
    localIntegrationBase: inventory.lineage.localMainIntegrationBase,
    localIntegrationBaseIsAncestor: true,
  },
  immutableVerifier: {
    declared: inventory.immutableVerifier,
    observed: observedVerifier,
    unchanged: true,
  },
  candidates,
  recordedMergeReceipts,
  historicalDeploymentAndDeliveryInventory: {
    evidenceReuse: 'NONE',
    policy: inventory.historicalEvidencePolicy,
    entries: inventory.deploymentAndDeliveryEvidence,
  },
  integrationMerges,
  integratedDeliveries,
  requiredEntrypoints: entrypoints,
  nonForcePushReceipt: authoritativeReceipt ?? {
    localAuditOnly: true,
    requiredOnRemoteVerification: true,
  },
  sourceDigest,
  sources,
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
console.log(`authoritative-target manifest=${outputPath} target=${target} candidates=${candidates.length} entrypoints=${entrypoints.length}`);

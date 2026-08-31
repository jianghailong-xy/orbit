// The Release DAG checkpoint store.
//
// A round is a directory named after its binding digest, and it is thrown away when the
// target moves. A checkpoint is not: it is addressed by the digest of the inputs the node
// actually reads, so it survives exactly as long as those inputs are unchanged and no
// longer. Re-admitting one into a later round restates nothing about the run -- the bytes,
// the digests and the counts are the ones that were observed -- it only moves the same
// bytes into the round that is asking, and records which round observed them.
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DIGEST, canonical, sha256 } from './outcome-reconciler-release-dag-lib.mjs';

// Bounded on purpose: a repair loop walks forward, so keeping the few most recent input
// sets per node is enough to survive one revert without letting the store grow forever.
export const CHECKPOINTS_KEPT_PER_NODE = 3;

const resolveFrom = (repo, file) => (path.isAbsolute(file) ? file : path.join(repo, file));

function relativeTo(repo, file) {
  const relative = path.relative(repo, file);
  return relative.startsWith('..') ? file : relative;
}

function digestOf(file) {
  const raw = readFileSync(file);
  return { bytes: raw.byteLength, sha256: sha256(raw) };
}

function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function checkpointDirectory({ storeRoot, nodeId, inputDigest }) {
  if (!DIGEST.test(inputDigest ?? '')) return null;
  return path.join(storeRoot, nodeId, inputDigest);
}

export function readCheckpoint({ storeRoot, nodeId, inputDigest }) {
  const directory = checkpointDirectory({ storeRoot, nodeId, inputDigest });
  if (directory === null) return null;
  const file = path.join(directory, 'receipt.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function prune({ storeRoot, nodeId, keepDigest, keep }) {
  const nodeRoot = path.join(storeRoot, nodeId);
  if (!existsSync(nodeRoot)) return;
  const stale = readdirSync(nodeRoot)
    .filter((entry) => entry !== keepDigest && DIGEST.test(entry))
    .map((entry) => ({ entry, modifiedAtMs: statSync(path.join(nodeRoot, entry)).mtimeMs }))
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
    .slice(Math.max(0, keep - 1));
  for (const entry of stale) {
    rmSync(path.join(nodeRoot, entry.entry), { recursive: true, force: true });
  }
}

export function writeCheckpoint({ repo, storeRoot, receipt, keep = CHECKPOINTS_KEPT_PER_NODE }) {
  const directory = checkpointDirectory({
    storeRoot, nodeId: receipt.nodeId, inputDigest: receipt.inputDigest,
  });
  if (directory === null || receipt.state !== 'SUCCESS' || receipt.reusable !== true) return null;
  const artifactRoot = path.join(directory, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  const artifacts = receipt.artifacts.map((artifact, index) => {
    const destination = path.join(artifactRoot,
      `${String(index).padStart(2, '0')}-${path.basename(artifact.declaredPath)}`);
    copyFileSync(resolveFrom(repo, artifact.snapshotPath), destination);
    return { ...artifact, snapshotPath: relativeTo(repo, destination) };
  });
  const logPath = path.join(directory, `${receipt.nodeId}.log`);
  copyFileSync(resolveFrom(repo, receipt.log.path), logPath);
  const log = { ...receipt.log, path: relativeTo(repo, logPath) };
  const stored = {
    ...receipt,
    artifacts,
    log,
    artifactDigest: sha256(canonical({ artifacts, log })),
  };
  atomicJson(path.join(directory, 'receipt.json'), stored);
  prune({ storeRoot, nodeId: receipt.nodeId, keepDigest: path.basename(directory), keep });
  return stored;
}

export function readmitCheckpoint({
  repo, receipt, node, binding, target, releaseAttempt, runRoot, logRoot,
}) {
  if (receipt.binding?.bindingDigest === binding.bindingDigest) return receipt;
  assert.equal(node.artifactBinding, 'CONTENT_ONLY',
    `${node.id} embeds its round binding and cannot be re-admitted into another`);
  const snapshotDirectory = path.join(runRoot, 'artifacts', node.id);
  mkdirSync(snapshotDirectory, { recursive: true });
  const artifacts = receipt.artifacts.map((artifact, index) => {
    const destination = path.join(snapshotDirectory,
      `${String(index).padStart(2, '0')}-${path.basename(artifact.declaredPath)}`);
    copyFileSync(resolveFrom(repo, artifact.snapshotPath), destination);
    assert.equal(digestOf(destination).sha256, artifact.sha256,
      `${node.id} re-admitted artifact does not match its checkpoint`);
    return { ...artifact, snapshotPath: relativeTo(repo, destination) };
  });
  mkdirSync(logRoot, { recursive: true });
  const logPath = path.join(logRoot, `${node.id}.log`);
  copyFileSync(resolveFrom(repo, receipt.log.path), logPath);
  const log = { ...receipt.log, path: relativeTo(repo, logPath) };
  assert.equal(digestOf(logPath).sha256, receipt.log.sha256,
    `${node.id} re-admitted log does not match its checkpoint`);
  return {
    ...receipt,
    target,
    binding,
    releaseAttempt,
    artifacts,
    log,
    artifactDigest: sha256(canonical({ artifacts, log })),
    reuse: {
      inputDigest: receipt.inputDigest,
      observedTargetSha: receipt.target.sha,
      observedBindingDigest: receipt.binding.bindingDigest,
      observedReleaseAttemptToken: receipt.releaseAttempt?.token ?? null,
      observedStartedAt: receipt.startedAt,
      observedFinishedAt: receipt.finishedAt,
      sourceReceiptDigest: sha256(canonical(receipt)),
      readmittedAt: new Date().toISOString(),
    },
  };
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { canonical, sha256 } from './outcome-reconciler-release-dag-lib.mjs';

export const POSTGRES_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
export const PCC_IDENTIFIER = /^pcc[0-9a-z]*_[a-z0-9_]+$/u;
export const ATTEMPT_TOKEN = /^[0-9a-f]{12}$/u;

function identifierPrefix(value, label) {
  assert.match(value, /^[a-z][a-z0-9_]{1,24}$/u, `${label} is not a safe identifier prefix`);
  return value;
}

function boundedIdentifier(prefix, stableParts, volatilePart, maximumLength) {
  identifierPrefix(prefix, 'PostgreSQL prefix');
  const stable = [prefix, ...stableParts].join('_');
  const candidate = `${stable}_${volatilePart}`;
  if (candidate.length <= maximumLength) return candidate;
  const suffix = sha256(candidate).slice(0, 8);
  const available = maximumLength - stable.length - suffix.length - 2;
  assert.ok(available >= 1, 'stable PostgreSQL identity material exceeds its identifier budget');
  return `${stable}_${volatilePart.slice(0, available)}_${suffix}`;
}

function assertIdentity(identity, { requiresPcc = false } = {}) {
  for (const [field, value] of Object.entries(identity)) {
    if (!['database', 'emptyDatabase', 'role'].includes(field) || value == null) continue;
    assert.match(value, POSTGRES_IDENTIFIER, `${field} is not a safe PostgreSQL identifier`);
    assert.ok(value.length <= 63, `${field} exceeds PostgreSQL's identifier limit`);
    if (requiresPcc) {
      assert.match(value, PCC_IDENTIFIER, `${field} must retain the destructive pcc_* safety gate`);
      assert.doesNotMatch(value, /(^|_)orbit(_|$)/u,
        `${field} could address a shared Orbit PostgreSQL identity`);
    }
  }
  return identity;
}

export function deriveReleaseAttemptIdentity({
  bindingDigest,
  evaluatorTaskId,
  runnerTaskId,
  runnerSessionId,
  startedAt,
  nonce = randomUUID(),
}) {
  assert.match(bindingDigest, /^[0-9a-f]{64}$/u);
  assert.match(evaluatorTaskId, /^[0-9A-Za-z]+$/u);
  assert.match(runnerTaskId, /^[0-9A-Za-z]+$/u);
  assert.match(runnerSessionId, /^[0-9A-Za-z]+$/u);
  assert.ok(Number.isFinite(Date.parse(startedAt)), 'release attempt startedAt is invalid');
  assert.match(nonce, /^[0-9a-f-]{36}$/u, 'release attempt nonce must be a UUID');
  const material = {
    schemaVersion: 1,
    kind: 'orbit.outcome-reconciler.release-dag-attempt-identity',
    bindingDigest,
    evaluatorTaskId,
    runnerTaskId,
    runnerSessionId,
    startedAt,
    nonce,
  };
  const digest = sha256(canonical(material));
  return { ...material, digest, token: digest.slice(0, 12) };
}

export function nodeDatabaseIdentity({ node, bindingDigest, attemptToken }) {
  assert.equal(node.usesSharedPostgres, true, `${node.id} does not use shared PostgreSQL`);
  assert.match(bindingDigest, /^[0-9a-f]{64}$/u);
  assert.match(attemptToken, ATTEMPT_TOKEN);
  const databasePrefix = identifierPrefix(node.postgresDatabasePrefix, `${node.id} database prefix`);
  const rolePrefix = identifierPrefix(node.postgresRolePrefix, `${node.id} role prefix`);
  const stable = [`b${bindingDigest.slice(0, 8)}`, `a${attemptToken}`];
  const nodePart = `n${node.id.replaceAll('-', '_')}`;
  const identity = {
    database: boundedIdentifier(databasePrefix, stable, nodePart, 54),
    role: boundedIdentifier(rolePrefix, stable, nodePart, 63),
  };
  return assertIdentity(identity, { requiresPcc: node.destructiveCoordinatorSpecs === true });
}

export function fullApiCaseIdentity({
  bindingDigest,
  attemptToken,
  partitionClass,
  partitionIndex,
  caseIndex,
}) {
  assert.match(bindingDigest, /^[0-9a-f]{64}$/u);
  assert.match(attemptToken, ATTEMPT_TOKEN);
  assert.ok(partitionClass === 'parallel' || partitionClass === 'serial');
  assert.ok(Number.isInteger(partitionIndex) && partitionIndex >= 0 && partitionIndex <= 99);
  assert.ok(Number.isInteger(caseIndex) && caseIndex >= 1 && caseIndex <= 9999);
  const partition = partitionClass === 'serial' ? 'ss' : `sp${partitionIndex}`;
  const stable = [
    `b${bindingDigest.slice(0, 8)}`,
    `a${attemptToken}`,
    partition,
    `c${String(caseIndex).padStart(4, '0')}`,
  ];
  const stem = ['pccrd', ...stable].join('_');
  return assertIdentity({
    database: `${stem}_d`,
    emptyDatabase: `${stem}_e`,
    role: `${stem}_u`,
  }, { requiresPcc: true });
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const [action, bindingDigest, attemptToken, partitionClass, partitionIndex, caseIndex] =
    process.argv.slice(2);
  assert.equal(action, 'full-api-case',
    'usage: release-dag-database.mjs full-api-case BINDING ATTEMPT CLASS SHARD CASE');
  const identity = fullApiCaseIdentity({
    bindingDigest,
    attemptToken,
    partitionClass,
    partitionIndex: Number(partitionIndex),
    caseIndex: Number(caseIndex),
  });
  process.stdout.write(`${identity.database}\t${identity.emptyDatabase}\t${identity.role}\n`);
}

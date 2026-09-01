#!/usr/bin/env node
// One standalone Full API case, recorded as a fact rather than as an exit code.
//
// Written before the case's own success or failure is decided, so a case that failed still leaves
// something a reader can look at; nothing is forgiven by writing it, because the case script still
// exits non-zero on every outcome other than PASS.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [output, indexText, specPath, database, emptyDatabase, role,
  identityDatabase, identityRole, identitySystemIdentifier,
  tapPath, exitCodeText, cleanupCodeText,
  failureKind, elapsedText, timeoutText] = process.argv.slice(2);
assert.ok(timeoutText != null,
  'usage: full-api-standalone-receipt OUTPUT INDEX SPEC DB EMPTY ROLE ID_DB ID_ROLE ID_SYSTEM TAP EXIT CLEANUP KIND ELAPSED TIMEOUT');

const index = Number(indexText);
const exitCode = Number(exitCodeText);
const cleanupCode = Number(cleanupCodeText);
const elapsedSeconds = Number(elapsedText);
const timeoutSeconds = Number(timeoutText);
assert.ok(Number.isInteger(index) && index >= 1);
// The case script's own vocabulary for how a case ended, copied rather than re-derived: only it
// knows whether 124 came from the wall clock it set. An unknown word here would be a receipt
// claiming something no reader could interpret, so it is refused rather than recorded.
assert.ok(['COMPLETED', 'TIMED_OUT', 'SIGNALED', 'CRASHED_BEFORE_TAP', 'SPEC_FAILED'].includes(failureKind),
  `unknown case failure kind: ${failureKind}`);
assert.ok(Number.isInteger(elapsedSeconds) && elapsedSeconds >= 0);
assert.ok(Number.isInteger(timeoutSeconds) && timeoutSeconds > 0);
for (const identity of [database, emptyDatabase, role]) {
  assert.match(identity, /^pcc[0-9a-z]*_[a-z0-9_]+$/u,
    'destructive Full API cases must retain pcc_* identities');
}
assert.equal(identityDatabase, database);
assert.equal(identityRole, role);
assert.match(identitySystemIdentifier, /^[0-9]+$/u);

const tap = readFileSync(tapPath, 'utf8');
function metric(name) {
  const matches = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
  return matches.reduce((total, match) => total + Number(match[1]), 0);
}
const summary = {
  tests: metric('tests'),
  passed: metric('pass'),
  failed: metric('fail'),
  cancelled: metric('cancelled'),
  skipped: metric('skipped'),
  todo: metric('todo'),
};

// A case that reported nothing, a case that ran and failed, and a case whose database survived
// cleanup are three different facts, so each gets its own conclusion. A spec that skipped or
// reported no test at all is NOT a pass: an acceptance that accepted "zero tests, none failed"
// would accept a spec file that had quietly stopped running.
const outcome =
  cleanupCode !== 0 ? 'RESOURCES_REMAINING'
    : exitCode !== 0 ? 'FAILED'
      : summary.tests === 0 ? 'REPORTED_NOTHING'
        : summary.failed > 0 || summary.cancelled > 0 || summary.skipped > 0 || summary.todo > 0
          ? 'INCOMPLETE'
          : 'PASS';

const body = {
  schemaVersion: 1,
  kind: 'orbit.outcome-reconciler.full-api-standalone-case',
  outcome,
  caseIndex: index,
  spec: path.basename(specPath),
  database,
  emptyDatabase,
  role,
  identity: {
    database: identityDatabase,
    role: identityRole,
    systemIdentifier: identitySystemIdentifier,
    verifiedBeforeMutation: true,
  },
  cleanup: {
    databaseRemoved: cleanupCode === 0,
    emptyDatabaseRemoved: cleanupCode === 0,
    roleRemoved: cleanupCode === 0,
    resourcesRemaining: cleanupCode === 0 ? 0 : 1,
  },
  exitCode,
  // A case that reported nothing says nothing about WHY. These three do: 124 is the wall clock
  // this run enforced, 128+N is a signal someone else sent, and neither is the same failure as a
  // spec that ran and failed. Kept beside the exit code so a reader who has only the receipt --
  // the case log is deleted with its directory when the run ends -- can still tell them apart.
  failureKind,
  elapsedSeconds,
  timeoutSeconds,
  cleanupCode,
  summary,
};
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({ ...body, receiptDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }, null, 2)}\n`);
process.exit(outcome === 'PASS' ? 0 : 1);

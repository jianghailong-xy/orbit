import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const REPO = path.resolve(__dirname, '../../../..');
const SOURCE = readFileSync(path.join(REPO, 'src/apiserver/src/projects/project-decision.service.ts'), 'utf8');
const EVENTS = readFileSync(path.join(REPO, 'src/apiserver/src/projects/project-events.service.ts'), 'utf8');
const RECONCILE = readFileSync(path.join(REPO, 'src/apiserver/src/projects/project-reconcile.service.ts'), 'utf8');
const MIGRATION = readFileSync(
  path.join(REPO, 'src/apiserver/prisma/migrations/0120_project_decision_audit/migration.sql'),
  'utf8',
);

test('decision capture is pinned to a repeatable-read boundary and every tenant-bearing source is scoped', () => {
  assert.match(EVENTS, /isolationLevel:\s*Prisma\.TransactionIsolationLevel\.RepeatableRead/);
  assert.match(SOURCE, /Project decision snapshots require REPEATABLE READ or SERIALIZABLE/);
  for (const table of ['task', 'session', 'workspace', 'runner']) {
    const tableReads = SOURCE.match(new RegExp(`FROM \\"${table}\\"[\\s\\S]{0,1800}`, 'g')) ?? [];
    assert.ok(tableReads.length > 0, `snapshot no longer reads ${table}`);
    assert.ok(tableReads.every((read) => /owner_id/.test(read)), `${table} read lost its owner boundary`);
  }
  assert.match(SOURCE, /mp\."owner_id" IS NULL OR mp\."owner_id" = \$\{project\.ownerId\}::uuid/);
  assert.match(SOURCE, /target\."project_id" = p\."id"/);
  assert.match(SOURCE, /target\."owner_id" = p\."owner_id"/);
});

test('the audit schema binds every attributed action to a decision in the same Project', () => {
  assert.match(MIGRATION, /CREATE TABLE "project_decision"/);
  assert.match(MIGRATION, /"decision_input_hash" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(MIGRATION, /"decision_input"->>'decisionInputHash' = "decision_input_hash"/);
  assert.match(MIGRATION, /FOREIGN KEY \("decision_id", "project_id"\)/);
  assert.match(MIGRATION, /REFERENCES "project_decision"\("id", "project_id"\)/);
  assert.match(MIGRATION, /"decided_by" IN \('ORCHESTRATOR', 'COORDINATOR_AGENT'\)/);
  assert.match(MIGRATION, /PROJECT_DECISION_IMMUTABLE/);
  assert.match(MIGRATION, /ACTION_DECISION_LINK_FROZEN/);
  assert.match(SOURCE, /coordinatorAgentId/);
  assert.match(SOURCE, /coordinatorSessionId/);
});

test('stale actions fail closed and create their refusal, wake and outbox signal atomically', () => {
  assert.match(RECONCILE, /applyDecisionAction/);
  assert.match(RECONCILE, /refusalCode:\s*'STALE_SNAPSHOT'/);
  assert.match(RECONCILE, /kind:\s*'coordinator\.snapshot_stale'/);
  assert.match(RECONCILE, /stale Coordinator decision requires reconcile/);
  // The publish and the refuse both match the action's OWN decision lineage, which is what stops a
  // pass finishing an action a different judgment planned. `[K5]`'s retry re-claims a permanent key
  // whose `decision_id` migration 0120 freezes, so the local it compares against is the row's
  // lineage rather than this pass's id — `ledgerDecisionId` IS `decisionId` on every path that
  // inserts, and the row's own decision on the one path that re-claims. Both spellings are asserted
  // so neither clause can quietly stop comparing at all.
  assert.match(RECONCILE, /let ledgerDecisionId = decisionId;/);
  assert.match(RECONCILE, /"decision_id" = \$\{ledgerDecisionId\}::uuid/);
  assert.match(RECONCILE, /ledgerDecisionId = existing\.existingDecisionId \?\? decisionId;/);
  assert.match(RECONCILE, /isolationLevel:\s*Prisma\.TransactionIsolationLevel\.RepeatableRead/);
});

test('snapshot JSON deliberately publicizes ids and hashes opaque ledger/test content', () => {
  assert.match(SOURCE, /uuidToBase62/);
  assert.match(SOURCE, /idempotencyKeyHash:\s*sha256/);
  assert.match(SOURCE, /resultHash:/);
  assert.doesNotMatch(SOURCE, /api_key_enc|token_hash|system_prompt|append_system_prompt/);
});

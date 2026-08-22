import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { NEVER_PUBLIC_ID_FIELDS, PUBLIC_ID_FIELDS } from '@orbit/shared';

import { AUTHORITATIVE_OWNERSHIP_FIELD, SCOPE_PROVENANCE_FIELDS } from './project-scope-contract';

/**
 * Unit L2 — what the SCHEMA has to say, checked without a database.
 *
 * L1 froze two things this unit persists and left the persistence to it: the names of the four
 * provenance fields, and the rule that they are evidence (§3 SC7 — "任何门禁不得读它做授权判定").
 * A name is easy to keep; the rule is the one that decays, because it decays by somebody adding a
 * perfectly reasonable read. So the second half of this file is a sweep over the source tree that
 * fails when one of these names appears anywhere it was not deliberately put.
 *
 * The database-side claims — that the migration applies to a fresh server and to one with history
 * in it, survives being re-run, rolls back, and refuses what it says it refuses — are in
 * `project-provenance-epoch.pg.spec.ts`, because they are the DATABASE's claims and a mock cannot
 * make them.
 */

const REPO = path.resolve(__dirname, '../../../..');
const APISERVER = path.resolve(__dirname, '../..');
const SCHEMA = readFileSync(path.join(APISERVER, 'prisma/schema.prisma'), 'utf8');
const MIGRATION_DIR = path.join(
  APISERVER, 'prisma/migrations/0150_task_provenance_project_acceptance_epoch',
);
const MIGRATION = readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8');
const DOWN = readFileSync(path.join(MIGRATION_DIR, 'down.sql'), 'utf8');

/** Prisma field name → the column it maps to. The pairing L1 named and L2 had to spell. */
const PROVENANCE_COLUMNS: Readonly<Record<string, string>> = {
  discoveredFromProjectId: 'discovered_from_project_id',
  triggerEvent: 'trigger_event',
  sourceTaskId: 'source_task_id',
  sourceSessionId: 'source_session_id',
};

// ── The contract's names are the schema's names ───────────────────────────────────────────────

test('L2 persists exactly the four provenance fields L1 froze, under those names', () => {
  assert.deepEqual(
    [...SCOPE_PROVENANCE_FIELDS].sort(),
    Object.keys(PROVENANCE_COLUMNS).sort(),
    'the persisted set must be the frozen set — a fifth column here is a fact L1 never froze, ' +
      'and a missing one is a fact L1 froze and nothing records',
  );
  for (const [field, column] of Object.entries(PROVENANCE_COLUMNS)) {
    assert.match(
      SCHEMA,
      new RegExp(`\\b${field}\\b[^\\n]*@map\\("${column}"\\)`),
      `Task.${field} must map to "${column}"`,
    );
    assert.match(
      MIGRATION,
      new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`),
      `migration 0150 must add "${column}"`,
    );
  }
});

test('ownership is one column and provenance is beside it, never instead of it', () => {
  assert.equal(AUTHORITATIVE_OWNERSHIP_FIELD, 'projectId');
  assert.ok(
    !SCOPE_PROVENANCE_FIELDS.includes(AUTHORITATIVE_OWNERSHIP_FIELD as never),
    'the authoritative column must not also be provenance',
  );
  // The claim is stated in the referential actions, which is the one place every writer meets it:
  // a project that OWNS work cannot be deleted, a project work was merely NOTICED in can be.
  assert.match(
    SCHEMA,
    /project\s+Project\?\s+@relation\(fields: \[projectId\][^)]*onDelete: Restrict\)/,
    'task.projectId must stay ON DELETE Restrict — that is what makes it authority',
  );
  assert.match(
    SCHEMA,
    /@relation\("TaskDiscoveredFrom", fields: \[discoveredFromProjectId\][^)]*onDelete: SetNull\)/,
    'task.discoveredFromProjectId must be ON DELETE SetNull — that is what makes it evidence',
  );
});

test('every provenance id is classified as a public id, and none as a fence token', () => {
  for (const field of ['discoveredFromProjectId', 'sourceTaskId', 'sourceSessionId']) {
    assert.ok(PUBLIC_ID_FIELDS.has(field), `${field} must be a public id: it is an address`);
    assert.ok(!NEVER_PUBLIC_ID_FIELDS.has(field), `${field} must not be classified as a fence`);
  }
  // `triggerEvent` is a fact name, not an id, and belongs to neither set.
  assert.ok(!PUBLIC_ID_FIELDS.has('triggerEvent'));
  assert.ok(!NEVER_PUBLIC_ID_FIELDS.has('triggerEvent'));
});

// ── SC7, as a sweep rather than as a comment ──────────────────────────────────────────────────

/**
 * Where each provenance name is allowed to appear, and why. Anything else is a READER, and a
 * reader is how "I found this" becomes "I may write here".
 *
 * `sourceTaskId` is swept in its column spelling only. The camel-case name predates this unit —
 * the dependency graph's computed edges use it for the same kind of thing, which is why L1 chose
 * it — so a sweep over the camel form would fail on code that has nothing to do with provenance.
 */
const PROVENANCE_NAMES = [
  'discoveredFromProjectId',
  'sourceSessionId',
  'triggerEvent',
  'discovered_from_project_id',
  'source_task_id',
  'source_session_id',
  'trigger_event',
];

const ALLOWED_READERS: Readonly<Record<string, string>> = {
  // The frozen vocabulary itself, and the decision that proves it ignores these.
  'src/apiserver/src/projects/project-scope-contract.ts': 'L1 freezes the names',
  'src/apiserver/src/projects/project-scope-decision.ts': 'carries provenance, decides without it',
  // The one write path. `resolveOwnedSession` derives them; `taskCreateData` writes them.
  'src/apiserver/src/tasks/tasks.service.ts': 'the create path, and the only writer',
  // Both directions of the public-id classification.
  'src/shared/src/codec.ts': 'classifies the ids as addresses',
};

/**
 * The trees a reader could live in. Walked from the filesystem rather than asked of `git grep`,
 * which only sees tracked files — and the reader this test is meant to catch arrives as a NEW file
 * in somebody's working tree, where a tracked-only sweep is green until the moment it stops
 * mattering.
 */
const SOURCE_ROOTS = [
  'src/apiserver/src',
  'src/shared/src',
  'src/web/src',
  'src/runner-go',
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.prisma-local', 'vendor', 'testdata']);
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.go']);

function walk(dir: string, out: string[]): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a tree this checkout does not have is not a violation
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const SOURCE_FILES: ReadonlyArray<readonly [string, string]> = SOURCE_ROOTS.flatMap((root) =>
  walk(path.join(REPO, root), []).map(
    (file) => [path.relative(REPO, file), readFileSync(file, 'utf8')] as const,
  ),
);

test('SC7: no gate reads provenance — the names appear only where they were deliberately put', () => {
  assert.ok(SOURCE_FILES.length > 500, 'the sweep found almost no source files — it is not looking');
  const unexpected: string[] = [];
  for (const [file, text] of SOURCE_FILES) {
    // Specs are where these names are SUPPOSED to appear everywhere.
    if (file.endsWith('.spec.ts') || file.endsWith('_test.go')) continue;
    if (file in ALLOWED_READERS) continue;
    for (const name of PROVENANCE_NAMES) {
      if (text.includes(name)) unexpected.push(`${file} (${name})`);
    }
  }
  assert.deepEqual(
    unexpected.sort(),
    [],
    'a new reader of the provenance columns. If it is a gate — authorization, dispatch, ' +
      'acceptance counting, scheduling — the scope contract §3 SC7 forbids it: evidence grants ' +
      'nothing. If it is a read face, add it to ALLOWED_READERS with the reason.',
  );
});

// ── The acceptance epoch ──────────────────────────────────────────────────────────────────────

test('the acceptance epoch is on the project, stamped on the run, and starts at 0 for everyone', () => {
  assert.match(SCHEMA, /acceptanceEpoch BigInt @default\(0\) @map\("acceptance_epoch"\)/);
  assert.equal(
    (SCHEMA.match(/acceptanceEpoch BigInt @default\(0\)/g) ?? []).length,
    2,
    'both `project` and `project_acceptance_run` carry the epoch',
  );
  for (const table of ['project', 'project_acceptance_run']) {
    assert.match(
      MIGRATION,
      new RegExp(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "acceptance_epoch" BIGINT NOT NULL DEFAULT 0`),
      `${table}.acceptance_epoch must default to 0 — that is what keeps every DONE that stands today standing`,
    );
  }
  assert.doesNotMatch(
    MIGRATION,
    /UPDATE "project"\s+SET[^;]*acceptance_epoch/,
    'the migration must not backfill the epoch: every project starts in epoch 0 by construction',
  );
});

test('a reopen is both settled statuses, not only DONE', () => {
  // The hole this unit closes. `ProjectsService.update` retires the runs when a person moves
  // DONE -> OPEN and takes no branch at all for DONE -> CANCELLED -> OPEN, which leaves a live
  // PASS standing over a project that was put down and picked up again.
  assert.match(
    MIGRATION,
    /IF OLD\."status" IN \('DONE', 'CANCELLED'\) AND NEW\."status" = 'OPEN' THEN/,
    'the epoch must advance out of either settled status',
  );
});

test('the epoch trigger sorts before the DONE gate, because the gate reads what it writes', () => {
  // PostgreSQL fires BEFORE ROW triggers in alphabetical order by name. If the gate ran first it
  // would read whatever the statement put in `NEW.acceptance_epoch` rather than the value the
  // transition implies — and `SET status='DONE', acceptance_epoch=0` would gate against a 0 the
  // advance trigger is about to overwrite.
  const advance = MIGRATION.indexOf('CREATE TRIGGER "project_acceptance_advance_epoch"');
  const gate = MIGRATION.indexOf('CREATE TRIGGER "project_acceptance_done_gate"');
  assert.ok(advance > 0 && gate > 0, 'both triggers are created by this migration');
  assert.ok(
    'project_acceptance_advance_epoch' < 'project_acceptance_done_gate',
    'the advance trigger must sort first',
  );
});

test('the epoch audit fires on value change, not on the columns a statement names', () => {
  // `AFTER UPDATE OF "acceptance_epoch"` fires on the columns a STATEMENT lists, and a reopen never
  // lists this one: it writes `SET status = 'OPEN'` and the BEFORE trigger moves the epoch. An
  // `UPDATE OF` clause here would silence the audit for exactly the writes it exists to record.
  const trigger = MIGRATION.slice(MIGRATION.indexOf('CREATE TRIGGER "project_acceptance_epoch_audit"'));
  assert.match(trigger.slice(0, 300), /AFTER UPDATE ON "project"/);
  assert.doesNotMatch(trigger.slice(0, 300), /AFTER UPDATE OF/);
  assert.match(trigger.slice(0, 300), /WHEN \(NEW\."acceptance_epoch" IS DISTINCT FROM OLD\."acceptance_epoch"\)/);
});

test('a stale-epoch PASS is refused with the code that already means it, not a new one', () => {
  // PAC §12 E2: no synonym of an existing code. "Your evidence is about a world that is no longer
  // this one" is what ACCEPTANCE_EVIDENCE_STALE already says.
  const gate = MIGRATION.slice(MIGRATION.indexOf('CREATE OR REPLACE FUNCTION project_acceptance_done_gate'));
  assert.match(gate, /run\."acceptance_epoch" IS DISTINCT FROM NEW\."acceptance_epoch"/);
  assert.match(gate, /ACCEPTANCE_EVIDENCE_STALE: acceptance run % passed in epoch %/);
  assert.match(gate, /ACCEPTANCE_EVIDENCE_STALE: project % was reopened after its legacy DONE/);
  for (const invented of ['PROJECT_EPOCH_STALE', 'ACCEPTANCE_EPOCH_MISMATCH', 'STALE_EPOCH']) {
    assert.doesNotMatch(MIGRATION, new RegExp(invented), `${invented} is a synonym; §12 E2 forbids it`);
  }
});

test('the run keeps what it concluded: no supersede, no rewrite, on the epoch path', () => {
  const forward = MIGRATION.slice(MIGRATION.indexOf('2 · The acceptance epoch'));
  assert.doesNotMatch(
    forward,
    /UPDATE "project_acceptance_run"\s+SET\s+"superseded_at"/,
    'a historical PASS stops being current by being READ, not by being rewritten',
  );
});

// ── Re-runnable, and reversible ───────────────────────────────────────────────────────────────

test('every DDL statement in 0150 is guarded, so an interrupted apply can be retried', () => {
  const unguarded: string[] = [];
  for (const line of MIGRATION.split('\n')) {
    const s = line.trim();
    if (/^ALTER TABLE .* ADD COLUMN /.test(s) && !s.includes('IF NOT EXISTS')) unguarded.push(s);
    if (/^CREATE INDEX /.test(s) && !s.includes('IF NOT EXISTS')) unguarded.push(s);
    if (/^CREATE FUNCTION /.test(s)) unguarded.push(s);            // must be CREATE OR REPLACE
    if (/^CREATE TYPE /.test(s)) unguarded.push(s);                // 0150 introduces none
  }
  assert.deepEqual(unguarded, [], 'unguarded DDL: a retried apply would fail on it');
  // Constraints have no IF NOT EXISTS in PostgreSQL, so they are added inside a duplicate_object
  // guard instead. Every ADD CONSTRAINT here must be in one — except the audit CHECK, which is
  // REPLACED and therefore dropped by name first.
  const addConstraints = (MIGRATION.match(/ADD CONSTRAINT "([a-z_]+)"/g) ?? []).length;
  const guards = (MIGRATION.match(/EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;/g) ?? []).length;
  const dropFirst = (MIGRATION.match(/DROP CONSTRAINT IF EXISTS/g) ?? []).length;
  assert.equal(addConstraints, guards + dropFirst, 'every ADD CONSTRAINT is guarded or preceded by a DROP');
  // Every trigger is dropped by name before it is created, which is the only re-runnable spelling.
  const created = MIGRATION.match(/CREATE TRIGGER "([a-z_]+)"/g) ?? [];
  for (const c of created) {
    const name = c.slice('CREATE TRIGGER "'.length, -1);
    assert.match(MIGRATION, new RegExp(`DROP TRIGGER IF EXISTS "${name}" ON`), `${name} is not dropped first`);
  }
});

test('down.sql reverses every object 0150 creates, and says what rolling back costs', () => {
  for (const column of [...Object.values(PROVENANCE_COLUMNS), 'acceptance_epoch']) {
    assert.match(DOWN, new RegExp(`DROP COLUMN IF EXISTS "${column}"`), `${column} is not dropped`);
  }
  for (const c of MIGRATION.match(/CREATE TRIGGER "([a-z_]+)"/g) ?? []) {
    const name = c.slice('CREATE TRIGGER "'.length, -1);
    // The DONE gate is 0127's trigger, restored rather than removed.
    if (name === 'project_acceptance_done_gate') {
      assert.match(DOWN, /CREATE TRIGGER "project_acceptance_done_gate"/);
      continue;
    }
    assert.match(DOWN, new RegExp(`DROP TRIGGER IF EXISTS "${name}" ON`), `${name} survives the rollback`);
  }
  for (const idx of MIGRATION.match(/CREATE INDEX IF NOT EXISTS "([a-z_]+)"/g) ?? []) {
    const name = idx.slice('CREATE INDEX IF NOT EXISTS "'.length, -1);
    assert.match(DOWN, new RegExp(`DROP INDEX IF EXISTS "${name}"`), `${name} survives the rollback`);
  }
  // The audit rows are NOT pruned, and the rollback says so: an append-only table that a rollback
  // may prune is not append-only.
  assert.doesNotMatch(DOWN, /DELETE FROM "project_acceptance_audit"/);
  assert.match(DOWN, /WHAT ROLLING BACK COSTS/);
});

test('0150 avoids the numbers unlanded units already claim', () => {
  // Migrations 0132–0141 are taken on branches that have not merged. A second 0132 is a merge
  // conflict wearing a schema's clothes, and the collision surfaces at deploy rather than at merge.
  assert.ok(MIGRATION_DIR.includes('/0150_'), 'the L unit takes the 015x band');
  assert.match(MIGRATION, /The band is 0150 on purpose/);
});

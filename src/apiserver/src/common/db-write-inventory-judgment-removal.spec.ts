import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

/**
 * The trigger inventory after 0227, and the negative control that says it is still strict.
 *
 * `scripts/sync-db-trigger-inventory.mjs` regenerates `TRIGGER_WRITE_SOURCES` from the migration
 * ledger, and `db-write-inventory.spec.ts` refuses any disagreement between that list and what a
 * database actually has. Dropping a table drops its triggers, so a removal that forgets to run
 * the generator turns two of that spec's assertions red — and a removal that "fixes" them by
 * relaxing the correspondence has removed the only thing making the list mean anything.
 *
 * So: the ten triggers this change takes are gone from the list, the generator agrees with the
 * ledger in check mode, and an unregistered trigger is still refused. The last one is proved by
 * constructing it rather than asserted in prose.
 */

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(API, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');
const INVENTORY = path.join(API, 'src/common/db-write-inventory.ts');

/** Everything 0227 detaches from `task` or takes away with a table. */
const REMOVED_TRIGGERS = [
  'task_judgment_verifier_delete_guard',
  'task_judgment_verifier_terminal_guard',
  'task_open_verification_request_carrier_guard',
  'task_open_verification_request_guard',
  'task_executable_judgment_result_request_guard',
  'task_judgment_delivery_file',
  'task_judgment_delivery_stop',
  'task_judgment_request_migration_metadata_guard',
  'task_judgment_request_transition_guard',
  'task_judgment_request_verifier_role_guard',
];

test('the inventory no longer registers a trigger no database has', () => {
  const inventory = readFileSync(INVENTORY, 'utf8');
  for (const trigger of REMOVED_TRIGGERS) {
    assert.doesNotMatch(inventory, new RegExp(`"trigger":"${trigger}"`),
      `the write inventory still registers ${trigger}`);
  }
  // Nothing judgment-shaped in the generated block at all.
  const generated = inventory.slice(inventory.indexOf('TRIGGER_WRITE_SOURCES'));
  assert.doesNotMatch(generated, /"table":"task_judgment[a-z_]*"/u);
  assert.doesNotMatch(generated, /task_executable_judgment_result/u);

  // And the preserved walls are still registered, so this was a deletion and not a regeneration
  // that quietly lost something else.
  for (const trigger of ['project_acceptance_done_gate', 'project_acceptance_advance_epoch',
    'project_acceptance_criteria_fact', 'project_acceptance_epoch_audit',
    'task_verification_verdict_atomic_insert', 'task_verification_verdict_atomic_update',
    'task_done_canonical_writer_fence']) {
    assert.match(generated, new RegExp(`"trigger":"${trigger}"`),
      `the write inventory lost ${trigger}, which this change never named`);
  }
});

test('the generator agrees with the ledger: the inventory is current, not merely edited', () => {
  // Check mode. The generator walks the append-only ledger — CREATE registers, DROP TRIGGER and
  // the DROP TABLE cascade deregister — and asserts the file matches. Running it here is what
  // makes "the removal remembered to regenerate" a fact rather than a note in a commit message.
  const result = spawnSync('node', ['scripts/sync-db-trigger-inventory.mjs'],
    { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0,
    `the trigger inventory is stale; run node scripts/sync-db-trigger-inventory.mjs --write\n`
    + `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /db trigger inventory is current/u);
});

test('the two-way correspondence db-write-inventory.spec makes was not relaxed', () => {
  // The negative control's real subject. That spec derives the live trigger list from the ledger
  // and `deepEqual`s it against `TRIGGER_WRITE_SOURCES`, so BOTH directions fail: an installed
  // trigger nobody registered, and a registration no database has. A removal under time pressure
  // makes both of them red at once, and the cheap way out is to soften the comparison.
  const spec = readFileSync(path.join(API, 'src/common/db-write-inventory.spec.ts'), 'utf8');
  const correspondence = spec.slice(spec.indexOf(
    "test('the installed triggers are the ones the inventory describes'",
  ));
  const body = correspondence.slice(0, correspondence.indexOf('\n});'));
  assert.match(body, /assert\.deepEqual\(/u, 'the comparison must stay an exact deepEqual');
  assert.match(body, /TRIGGER_WRITE_SOURCES\.map/u);
  assert.doesNotMatch(body, /\.filter\(/u,
    'a filter here would let a whole class of trigger out of the correspondence');
  assert.doesNotMatch(body, /includes\(|some\(|superset/u,
    'a containment check is one-way; the inventory has to be exactly the installed set');

  // And the generator itself still refuses to be run silently, and still understands the cascade
  // that is the only reason the ten triggers below could disappear without a DROP TRIGGER each.
  const generator = readFileSync(path.join(ROOT, 'scripts/sync-db-trigger-inventory.mjs'), 'utf8');
  assert.match(generator,
    /db trigger inventory is stale; run node scripts\/sync-db-trigger-inventory\.mjs --write/u);
  assert.match(generator, /Dropping a table drops its triggers/u);
});

test('an unregistered trigger is still caught: the check runs against a forged ledger', () => {
  // Constructed rather than asserted in prose. A scratch copy of the ledger gains one migration
  // that installs a trigger nobody registered, the generator is pointed at that copy, and it must
  // refuse. Nothing in the repository is written to, so this is safe under the parallel full run.
  const scratch = mkdtempSync(path.join(tmpdir(), 'jr-inventory-'));
  try {
    const ledger = path.join(scratch, 'src/apiserver/prisma/migrations');
    cpSync(MIGRATIONS, ledger, { recursive: true });
    cpSync(path.join(ROOT, 'scripts/sync-db-trigger-inventory.mjs'),
      path.join(scratch, 'scripts/sync-db-trigger-inventory.mjs'), { recursive: false });
    mkdirSync(path.join(scratch, 'src/apiserver/src/common'), { recursive: true });
    cpSync(INVENTORY, path.join(scratch, 'src/apiserver/src/common/db-write-inventory.ts'));

    // Green first, on the unmodified copy: a check that fails for an unrelated reason proves
    // nothing about the trigger below.
    const green = spawnSync('node', ['scripts/sync-db-trigger-inventory.mjs'],
      { cwd: scratch, encoding: 'utf8' });
    assert.equal(green.status, 0, `${green.stdout}${green.stderr}`);

    mkdirSync(path.join(ledger, '9999_unregistered_trigger_probe'), { recursive: true });
    writeFileSync(path.join(ledger, '9999_unregistered_trigger_probe/migration.sql'),
      'CREATE TRIGGER "jr_unregistered_probe_trigger"\n'
      + '  BEFORE INSERT ON "task"\n'
      + '  FOR EACH ROW EXECUTE FUNCTION "task_dispatch_epoch_seed"();\n');
    const red = spawnSync('node', ['scripts/sync-db-trigger-inventory.mjs'],
      { cwd: scratch, encoding: 'utf8' });
    assert.notEqual(red.status, 0, 'an unregistered trigger must fail the inventory check');
    assert.match(`${red.stdout}${red.stderr}`, /db trigger inventory is stale/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

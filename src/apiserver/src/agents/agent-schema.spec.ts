import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { NEVER_PUBLIC_ID_FIELDS, PUBLIC_ID_FIELDS, base62ToUuid, uuidToBase62 } from '@orbit/shared';

/**
 * Unit 02A, the half that needs no database: what the `agent` table IS, asserted against
 * `schema.prisma` and against the migration that builds it.
 *
 * The contract's central claim about this table is a NEGATIVE one (§3.1 A1) — it holds an identity
 * and no location — and a negative claim is exactly the kind nothing else can check. A column
 * added for one plausible-sounding reason ("this agent always runs on the Mac, so let it keep a
 * runner id") would compile, pass every behavioural test, and quietly restore the coupling this
 * whole project exists to remove. So the assertion is made about the schema text itself.
 *
 * Cases: 02A.4 (A1), and the schema half of 02A.8 (§10 B1/B2).
 */

const API = path.resolve(__dirname, '../..');
const SCHEMA = readFileSync(path.join(API, 'prisma/schema.prisma'), 'utf8');
const MIGRATION = readFileSync(
  path.join(API, 'prisma/migrations/0129_project_agent_identity/migration.sql'),
  'utf8',
);

/** The body of a `model X { … }` block, addressed by name rather than by position. */
function model(name: string): string {
  const match = SCHEMA.match(new RegExp(`^model ${name} \\{\\n([\\s\\S]*?)^\\}`, 'm'));
  assert.ok(match, `schema.prisma no longer declares model ${name}`);
  return match[1];
}

/** Field names of a model block, ignoring comments, attributes and relation-only lines. */
function fields(body: string): Set<string> {
  const names = new Set<string>();
  for (const line of body.split('\n')) {
    const bare = line.trim();
    if (!bare || bare.startsWith('//') || bare.startsWith('///') || bare.startsWith('@@')) continue;
    const match = bare.match(/^(\w+)\s+\S/);
    if (match) names.add(match[1]);
  }
  return names;
}

/** A model body with its `///` and `//` comment lines removed. Assertions about what the schema
 *  does NOT declare have to read the declarations only — this file's own prose names the very
 *  attribute A2 forbids, and a regex over the raw text would match the warning against it. */
function declarations(body: string): string {
  return body.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

const AGENT = model('Agent');
const AGENT_DECLARATIONS = declarations(AGENT);
const AGENT_FIELDS = fields(AGENT);

// §3.1 A1, verbatim. Each of these is an answer to WHERE the work runs, and every one of them is a
// column `workspace` really has — which is what makes copying one over here feel harmless.
const FORBIDDEN = ['runnerId', 'targetRunnerId', 'targetLabels', 'workDir', 'enableWorktree', 'env'];

test('02A.4 the agent model carries no location: none of A1 six columns exists', () => {
  const present = FORBIDDEN.filter((f) => AGENT_FIELDS.has(f));
  assert.deepEqual(
    present,
    [],
    'contract §3.1 A1: `agent` must hold an identity and nothing about where it runs. ' +
      'WHERE is resolved from the Project workspaces and the runner capabilities a task requires.',
  );

  // The same claim about the table the migration actually builds — a column can be added in SQL
  // without ever appearing in schema.prisma, and Prisma would never notice.
  const create = MIGRATION.match(/CREATE TABLE "agent" \(([\s\S]*?)\n\);/);
  assert.ok(create, '0129 no longer creates the agent table');
  for (const column of ['runner_id', 'target_runner_id', 'target_labels', 'work_dir',
    'enable_worktree', '"env"']) {
    assert.ok(!create[1].includes(column), `0129 creates agent."${column}", which A1 forbids`);
  }
});

test('02A.4 the agent model carries every §3.1 field', () => {
  // The positive half: A1 is only meaningful if the table is otherwise complete, because "no
  // location" is trivially true of a table with nothing in it.
  const required = [
    'id', 'ownerId', 'name', 'description', 'role', 'systemPrompt', 'appendSystemPrompt',
    'defaultProvider', 'defaultModel', 'defaultEffort', 'providerFallbacks', 'disallowedTools',
    'requiredCapabilities', 'canCreateTasks', 'canDelegate', 'enabled', 'deletedAt',
    'legacyWorkspaceId',
  ];
  assert.deepEqual(required.filter((f) => !AGENT_FIELDS.has(f)), []);

  // The defaults the contract states, because each one is a decision the migration then relies on:
  // an empty fallback list means "do not downgrade" (§7.4), and both permission bits are closed.
  assert.match(AGENT, /providerFallbacks\s+Json\s+@default\("\[\]"\)/);
  assert.match(AGENT, /disallowedTools\s+Json\s+@default\("\[\]"\)/);
  assert.match(AGENT, /requiredCapabilities\s+String\[\]\s+@default\(\[\]\)/);
  assert.match(AGENT, /canCreateTasks\s+Boolean\s+@default\(false\)/);
  assert.match(AGENT, /canDelegate\s+Boolean\s+@default\(false\)/);
  assert.match(AGENT, /enabled\s+Boolean\s+@default\(true\)/);
});

test('02A.4 every column Prisma types non-null is NOT NULL in the migration', () => {
  // `prisma migrate diff` does not report this. Prisma emits a scalar list as a NULLABLE column
  // while typing it `String[]` and never returning null for it, so a nullable
  // `required_capabilities` reads as zero drift and is still a hole: any raw-SQL writer — and this
  // repo has several — can store NULL, and every reader then holds a value its own type says
  // cannot exist. The sibling columns 0122 added are all NOT NULL.
  const create = MIGRATION.match(/CREATE TABLE "agent" \(([\s\S]*?)\n\);/);
  assert.ok(create);
  const notNull = (column: string) =>
    new RegExp(`"${column}"[^\n]*\\bNOT NULL\\b`).test(create[1]);
  for (const column of ['owner_id', 'name', 'provider_fallbacks', 'disallowed_tools',
    'required_capabilities', 'can_create_tasks', 'can_delegate', 'enabled', 'created_at']) {
    assert.ok(notNull(column), `agent."${column}" is non-null in schema.prisma but nullable in SQL`);
  }
  // And the genuinely optional ones stay optional, so the check above is not simply "NOT NULL
  // everywhere" — which would be a different bug.
  for (const column of ['description', 'role', 'default_provider', 'deleted_at',
    'legacy_workspace_id']) {
    assert.ok(!notNull(column), `agent."${column}" is optional in schema.prisma but NOT NULL in SQL`);
  }
});

test('02A.4 the live-name uniqueness is partial, and lives in SQL', () => {
  // A2. A plain `@@unique([ownerId, name])` is the bug, not the fix: it would let a soft-deleted
  // Agent hold its name for ever, so deleting "dev" would mean never having a "dev" again.
  assert.ok(
    !/@@unique\(\[ownerId, name\]\)/.test(AGENT_DECLARATIONS),
    'a total unique on (ownerId, name) lets a soft-deleted row hold the name for ever (A2)',
  );
  assert.match(
    MIGRATION,
    /CREATE UNIQUE INDEX "agent_owner_id_name_active_key"\s*\n?\s*ON "agent" \("owner_id", "name"\) WHERE "deleted_at" IS NULL;/,
  );

  // The mirror's idempotency key, and the tenant index every listing reads (§11.2 step 9).
  assert.match(MIGRATION, /CREATE UNIQUE INDEX "agent_legacy_workspace_id_key" ON "agent" \("legacy_workspace_id"\);/);
  assert.match(MIGRATION, /CREATE INDEX "agent_owner_id_idx" ON "agent" \("owner_id"\);/);
  assert.match(SCHEMA, /legacyWorkspaceId\s+String\?\s+@unique @map\("legacy_workspace_id"\) @db\.Uuid/);
});

test('02A.8 legacyWorkspaceId is a public id, and survives a Base62 round trip', () => {
  // §10 B1 makes `public-id-coverage.spec.ts` red for any unclassified `@db.Uuid` column; B2 says
  // which side this one lands on. The failure a classification prevents is silent: an id that is
  // encoded on the way out and not decoded on the way in reaches a `where` clause as base62 and
  // matches nothing at all, for ever, with no type error anywhere.
  assert.ok(PUBLIC_ID_FIELDS.has('legacyWorkspaceId'));
  assert.ok(!NEVER_PUBLIC_ID_FIELDS.has('legacyWorkspaceId'));

  // The boundaries, because base62 is where a length assumption hides: a uuid whose leading bytes
  // are zero encodes SHORT, and one that is all-ones encodes long.
  for (const uuid of [
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-7000-8000-000000000001',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
    '019a0000-0000-7000-8000-00000000000f',
  ]) {
    const encoded = uuidToBase62(uuid);
    assert.match(encoded, /^[0-9A-Za-z]+$/);
    assert.equal(base62ToUuid(encoded), uuid, `round trip lost ${uuid}`);
  }
});

test('02A.4 agent.role decides nothing (A3)', () => {
  // The authoritative role is `project_member.role`: scoped to one project, enforced by an index.
  // A global label on the identity is a permission anybody can rename by editing a display field,
  // so the rule is that no code branches on this column. Asserted by reading the source rather than
  // by a behavioural test, because the defect is a read that LOOKS right — `if (agent.role ===
  // 'coordinator')` beside a genuine permission check — and produces no wrong answer until someone
  // renames an agent.
  assert.match(AGENT, /role\s+String\?/);

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
      const text = readFileSync(full, 'utf8');
      // Both spellings a reader would use: the Prisma object, and the raw SQL this repo also writes.
      if (/\bagent\.role\b/.test(text) || /"agent"\."role"/.test(text)) {
        offenders.push(path.relative(API, full));
      }
    }
  };
  walk(path.join(API, 'src'));
  assert.deepEqual(
    offenders,
    [],
    'contract §3.1 A3: agent.role is a label for humans and takes no part in any authorization ' +
      'decision — the role that decides anything is project_member.role',
  );
});
